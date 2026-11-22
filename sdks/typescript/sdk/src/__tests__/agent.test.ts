import { describe, it, expect, vi } from 'vitest';
import { Client } from '../client';

function makeClient(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let i = 0;

  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url: url.toString(),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const client = new Client({
    apiKey: 'test-key',
    baseUrl: 'https://api.test',
    fetch: fetchFn as unknown as typeof fetch,
    retry: { maxAttempts: 1 },
  });

  return { client, calls };
}

const ok = (data: unknown) => ({ body: { success: true, data } });

describe('SecretsResource', () => {
  it('put() PUTs the value and list() never carries one back', async () => {
    const { client, calls } = makeClient([
      ok({ id: 'sec_1', name: 'STRIPE_KEY', description: null }),
      ok([{ id: 'sec_1', name: 'STRIPE_KEY', description: null }]),
    ]);

    await client.secrets.put('STRIPE_KEY', { value: 'sk_live_x' });
    const listed = await client.secrets.list();

    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe('https://api.test/api/v2/secrets/STRIPE_KEY');
    expect(calls[0].body).toEqual({ value: 'sk_live_x' });

    expect(listed.data?.[0]).not.toHaveProperty('value');
  });

  it('put() sends the destination policy, and null clears it', async () => {
    const { client, calls } = makeClient([ok({ id: 'sec_1' }), ok({ id: 'sec_1' })]);

    await client.secrets.put('STRIPE_KEY', {
      value: 'sk_live_x',
      allowedHosts: ['api.stripe.com'],
      allowedPlacements: ['header'],
    });
    await client.secrets.put('STRIPE_KEY', { value: 'sk_live_y', allowedHosts: null });

    expect(calls[0].body).toEqual({
      value: 'sk_live_x',
      allowedHosts: ['api.stripe.com'],
      allowedPlacements: ['header'],
    });
    expect(calls[1].body).toEqual({ value: 'sk_live_y', allowedHosts: null });
  });
});

describe('ActionsResource', () => {
  it('invoke() wraps the input and reports a pending approval', async () => {
    const { client, calls } = makeClient([
      {
        status: 202,
        body: {
          success: true,
          data: {
            id: 'inv_1',
            actionName: 'refund',
            status: 'pending_approval',
            approvalId: 'apr_1',
            pendingApproval: true,
          },
        },
      },
    ]);

    const res = await client.actions.invoke('refund', { charge: 'ch_1' });

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://api.test/api/v2/actions/refund/invoke');
    expect(calls[0].body).toEqual({ input: { charge: 'ch_1' } });
    expect(res.data?.pendingApproval).toBe(true);
    expect(res.data?.approvalId).toBe('apr_1');
  });

  it('invocations() hits the static log path, not /:ref', async () => {
    const { client, calls } = makeClient([{ body: { data: [], pagination: {} } }]);

    await client.actions.invocations({ action: 'refund', limit: 5 });

    expect(calls[0].url).toBe(
      'https://api.test/api/v2/actions/invocations?action=refund&limit=5'
    );
  });
});

describe('ActionsResource  OpenAPI import', () => {
  it('importFromOpenApi() posts the spec and the options together', async () => {
    const { client, calls } = makeClient([
      ok({ created: [{ name: 'listPets', warnings: [] }], skipped: [], dryRun: true }),
    ]);

    const spec = { openapi: '3.0.0', paths: {} };
    const res = await client.actions.importFromOpenApi(spec, {
      baseUrl: 'https://api.acme.com',
      auth: { headerName: 'Authorization', secretName: 'ACME_KEY' },
      dryRun: true,
    });

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://api.test/api/v2/actions/import');
    expect(calls[0].body).toEqual({
      spec,
      baseUrl: 'https://api.acme.com',
      auth: { headerName: 'Authorization', secretName: 'ACME_KEY' },
      dryRun: true,
    });
    expect(res.data?.created[0].name).toBe('listPets');
  });

  it('surfaces the skipped operations', async () => {
    const { client } = makeClient([
      ok({
        created: [],
        skipped: [{ path: '/pets', method: 'POST', reason: 'body: "oneOf" is not supported' }],
        dryRun: false,
      }),
    ]);

    const res = await client.actions.importFromOpenApi({ openapi: '3.0.0' });

    expect(res.data?.skipped[0].reason).toContain('oneOf');
  });
});

describe('ApprovalsResource', () => {
  it('request() and approve() hit the right paths', async () => {
    const { client, calls } = makeClient([
      ok({ id: 'apr_1', status: 'pending' }),
      ok({ approval: { id: 'apr_1', status: 'approved' }, invocation: { id: 'inv_1' } }),
    ]);

    await client.approvals.request({
      title: 'Send the contract?',
      runId: 'run_trace',
      parentSpanId: 'span_parent',
    });
    const decided = await client.approvals.approve('apr_1', { note: 'looks right' });

    expect(calls[0].url).toBe('https://api.test/api/v2/approvals');
    expect(calls[0].body).toEqual({
      title: 'Send the contract?',
      runId: 'run_trace',
      parentSpanId: 'span_parent',
    });
    expect(calls[1].url).toBe('https://api.test/api/v2/approvals/apr_1/approve');
    expect(calls[1].body).toEqual({ note: 'looks right' });
    expect(decided.data?.invocation?.id).toBe('inv_1');
  });

  it('get() passes waitSeconds through as a query param', async () => {
    const { client, calls } = makeClient([ok({ id: 'apr_1', status: 'pending' })]);

    await client.approvals.get('apr_1', { waitSeconds: 30 });

    expect(calls[0].url).toBe('https://api.test/api/v2/approvals/apr_1?waitSeconds=30');
  });

  it('waitForDecision() returns as soon as the approval is decided', async () => {
    const { client, calls } = makeClient([
      ok({ id: 'apr_1', status: 'pending' }),
      ok({ id: 'apr_1', status: 'approved' }),
    ]);

    const decided = await client.approvals.waitForDecision('apr_1');

    expect(decided.status).toBe('approved');
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('waitSeconds=55');
  });

  it('waitForDecision() returns the pending approval when the timeout elapses', async () => {
    const { client, calls } = makeClient([ok({ id: 'apr_1', status: 'pending' })]);

    const result = await client.approvals.waitForDecision('apr_1', { timeoutMs: 0 });

    expect(result.status).toBe('pending');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.test/api/v2/approvals/apr_1');
  });

  it('waitForDecision() shortens the last hop to the caller deadline', async () => {
    const { client, calls } = makeClient([ok({ id: 'apr_1', status: 'approved' })]);

    await client.approvals.waitForDecision('apr_1', { timeoutMs: 5_000 });

    expect(calls[0].url).toContain('waitSeconds=5');
  });

  it('gate() requests approval with the call args, then runs the function once approved', async () => {
    const { client, calls } = makeClient([
      ok({ id: 'apr_1', status: 'pending', title: 'Refund a customer?' }),
      ok({ id: 'apr_1', status: 'approved', title: 'Refund a customer?' }),
    ]);

    const fn = vi.fn(async (orderId: string, amount: number) => `${orderId}:${amount}`);
    const refund = client.approvals.gate({ title: 'Refund a customer?' }, fn);

    const result = await refund('ord_42', 129.99);

    expect(result).toBe('ord_42:129.99');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('ord_42', 129.99);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({
      title: 'Refund a customer?',
      payload: { args: ['ord_42', 129.99] },
    });
  });

  it('gate() throws ApprovalDeniedError and never runs the function on deny', async () => {
    const { client } = makeClient([
      ok({ id: 'apr_1', status: 'pending', title: 'Refund?' }),
      ok({ id: 'apr_1', status: 'denied', title: 'Refund?', decisionNote: 'too large' }),
    ]);

    const fn = vi.fn();
    const refund = client.approvals.gate({ title: 'Refund?' }, fn);

    await expect(refund()).rejects.toMatchObject({
      name: 'ApprovalDeniedError',
      approval: { id: 'apr_1', status: 'denied', decisionNote: 'too large' },
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('gate() throws ApprovalPendingError when the wait elapses undecided', async () => {
    const { client } = makeClient([ok({ id: 'apr_1', status: 'pending', title: 'Refund?' })]);

    const fn = vi.fn();
    const refund = client.approvals.gate({ title: 'Refund?', timeoutMs: 0 }, fn);

    await expect(refund()).rejects.toMatchObject({ name: 'ApprovalPendingError' });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('BudgetsResource', () => {
  it('put() PUTs the cap for a key', async () => {
    const { client, calls } = makeClient([
      ok({ apiKeyId: 'key_1', monthlyCostCentsCap: 500, usage: {}, estimatedCostCents: 0 }),
    ]);

    await client.budgets.put('key_1', {
      monthlyCostCentsCap: 500,
      dimensionCaps: { actionInvokes: 1000 },
    });

    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe('https://api.test/api/v2/budgets/key_1');
    expect(calls[0].body).toEqual({
      monthlyCostCentsCap: 500,
      dimensionCaps: { actionInvokes: 1000 },
    });
  });
});
