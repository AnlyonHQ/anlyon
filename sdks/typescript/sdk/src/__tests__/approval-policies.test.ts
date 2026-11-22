import { describe, it, expect, vi } from 'vitest';
import { Client } from '../client';

function makeClient(data: unknown = {}) {
  const calls: Array<{ url: string; method: string; body: unknown; raw: string | undefined }> = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url: url.toString(),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body as string) : undefined,
      raw: init.body as string | undefined,
    });
    return new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const client = new Client({
    apiKey: 'operator-key',
    baseUrl: 'https://api.test',
    fetch: fetchFn as unknown as typeof fetch,
    retry: { maxAttempts: 1 },
  });
  return { client, calls };
}

describe('ApprovalPoliciesResource', () => {
  it('reads versions after deletion and sends change notes on updates', async () => {
    const { client, calls } = makeClient([]);
    await client.approvalPolicies.versions('apol_deleted');
    await client.approvalPolicies.update('apol_1', { minAmount: 300, changeNote: 'Finance review' });
    expect(calls[0].url).toBe('https://api.test/api/v2/approval-policies/apol_deleted/versions');
    expect(calls[0].method).toBe('GET');
    expect(calls[1].body).toEqual({ minAmount: 300, changeNote: 'Finance review' });
  });
  it('sends a CEL condition, and null removes it', async () => {
    const { client, calls } = makeClient();
    await client.approvalPolicies.create({
      name: 'big refunds', matchKind: 'action', matchActionName: 'refund_order',
      condition: 'input.amount >= 500 && input.currency == "USD"',
    });
    await client.approvalPolicies.update('apol_1', { condition: null });
    expect((calls[0].body as Record<string, unknown>).condition).toBe('input.amount >= 500 && input.currency == "USD"');
    expect(calls[1].body).toEqual({ condition: null });
  });
  it('pages history with a version cursor and reads one exact version', async () => {
    const { client, calls } = makeClient([]);
    await client.approvalPolicies.versions('apol_1', { limit: 10, before: 40 });
    await client.approvalPolicies.version('apol_1', 7);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/v2/approval-policies/apol_1/versions');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('before')).toBe('40');
    expect(calls[1].url).toBe('https://api.test/api/v2/approval-policies/apol_1/versions/7');
  });
  it('evaluates without a mutation or caller-selected environment', async () => {
    const { client, calls } = makeClient({ evaluation: 'policy_only' });
    const request = { kind: 'action' as const, actionName: 'refund_order', payload: { amount: 120 } };
    const result = await client.approvalPolicies.evaluate(request);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.test/api/v2/approval-policies/evaluate', body: request });
    expect(result.data?.evaluation).toBe('policy_only');
  });
  it('create() sends explicit targeting and no environment', async () => {
    const { client, calls } = makeClient({ id: 'apol_1' });
    await client.approvalPolicies.create({
      name: 'refund_order_denied',
      matchKind: 'action',
      matchActionName: 'refund_order',
      effect: 'auto_deny',
    });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://api.test/api/v2/approval-policies');
    expect(calls[0].body).toEqual({
      name: 'refund_order_denied',
      matchKind: 'action',
      matchActionName: 'refund_order',
      effect: 'auto_deny',
    });
    expect(calls[0].raw).not.toContain('environmentId');
  });

  it('list() filters by action and get()/delete() address one policy', async () => {
    const { client, calls } = makeClient([]);
    await client.approvalPolicies.list({ actionName: 'refund_order' });
    await client.approvalPolicies.get('apol_1');
    await client.approvalPolicies.delete('apol_1');
    expect(calls[0].url).toBe('https://api.test/api/v2/approval-policies?actionName=refund_order');
    expect([calls[1].method, calls[1].url]).toEqual(['GET', 'https://api.test/api/v2/approval-policies/apol_1']);
    expect([calls[2].method, calls[2].url]).toEqual(['DELETE', 'https://api.test/api/v2/approval-policies/apol_1']);
  });

  it('update(): omitted and undefined are left out, null clears', async () => {
    const { client, calls } = makeClient({});
    await client.approvalPolicies.update('apol_1', {
      priority: 3,
      matchAgentId: null,
      minAmount: null,
      matchActionName: undefined,
    });
    expect(calls[0].method).toBe('PATCH');
    expect(JSON.parse(calls[0].raw as string)).toEqual({ priority: 3, matchAgentId: null, minAmount: null });
    expect(calls[0].raw).not.toContain('matchActionName');
  });

  it('enable()/disable() are patches of `enabled` only', async () => {
    const { client, calls } = makeClient({});
    await client.approvalPolicies.enable('apol_1');
    await client.approvalPolicies.disable('apol_1');
    expect(calls.map((c) => [c.method, c.body])).toEqual([
      ['PATCH', { enabled: true }],
      ['PATCH', { enabled: false }],
    ]);
  });
});

describe('AuthResource', () => {
  it('identity() reads the caller credential', async () => {
    const { client, calls } = makeClient({ credentialType: 'api_key', scopes: ['actions:invoke'] });
    const res = await client.auth.identity();
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('https://api.test/api/v2/auth/identity');
    expect(res.data?.scopes).toEqual(['actions:invoke']);
  });
});

describe('invocation decision and approval origin', () => {
  it('approvals.list() sends decisionOrigin', async () => {
    const { client, calls } = makeClient([]);
    await client.approvals.list({ status: 'pending', decisionOrigin: 'automated' });
    expect(calls[0].url).toContain('decisionOrigin=automated');
    expect(calls[0].url).toContain('status=pending');
  });
});

describe('AuthResource.requireScopes (startup check)', () => {
  const need = ['actions:invoke', 'sessions:write'];

  it.each([undefined, null, {}, { scopes: 'policies:write' }, { scopes: [42] }])('fails closed on malformed scope information: %j', async (identity) => {
    const { client } = makeClient(identity);
    await expect(client.auth.requireScopes([], { forbidden: ['policies:write'] })).rejects.toMatchObject({
      message: 'Credential identity response has no valid scope information.',
    });
  });

  it('rejects a key without sessions:write, naming exactly what is missing', async () => {
    const { client } = makeClient({ scopes: ['actions:invoke', 'sessions:read'] });
    await expect(client.auth.requireScopes(need)).rejects.toMatchObject({
      name: 'ScopeCheckError',
      missing: ['sessions:write'],
      forbidden: [],
    });
  });

  it('accepts a key that holds them, returns its identity, and can refuse scopes it must not hold', async () => {
    const { client } = makeClient({ scopes: ['actions:invoke', 'sessions:write'], environmentId: 'env_1' });
    expect((await client.auth.requireScopes(need)).environmentId).toBe('env_1');
    await expect(client.auth.requireScopes(need, { forbidden: ['sessions:write'] })).rejects.toMatchObject({
      forbidden: ['sessions:write'],
    });
  });

  it('a session (no scope list) cannot satisfy a requirement', async () => {
    const { client } = makeClient({ credentialType: 'session', scopes: null });
    await expect(client.auth.requireScopes(['actions:invoke'])).rejects.toMatchObject({ missing: ['actions:invoke'] });
  });

  it('only inspects: it makes one GET and never sends a body', async () => {
    const { client, calls } = makeClient({ scopes: need });
    await client.auth.requireScopes(need);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.test/api/v2/auth/identity' });
    expect(calls[0].body).toBeUndefined();
  });
});
