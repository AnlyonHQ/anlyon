import { describe, it, expect, vi } from 'vitest';
import { Client } from '../client';

function makeClient(data: unknown = {}, extra: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Headers }> = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url: url.toString(),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body as string) : undefined,
      headers: new Headers(init.headers),
    });
    return new Response(JSON.stringify({ success: true, data, ...extra }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const client = new Client({ apiKey: 'key', baseUrl: 'https://api.test', fetch: fetchFn as unknown as typeof fetch, retry: { maxAttempts: 1 } });
  return { client, calls };
}

describe('governed effects', () => {
  it('creates an adapter-backed action without a URL template', async () => {
    const { client, calls } = makeClient();
    await client.actions.create({
      name: 'refund',
      requiresApproval: true,
      adapter: { type: 'stripe.refund', config: { account: 'acct_1', mode: 'test', currency: 'usd' }, credentialSecret: 'STRIPE_TEST_KEY' },
    });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.test/api/v2/actions' });
    expect(calls[0].body).toEqual({
      name: 'refund',
      requiresApproval: true,
      adapter: { type: 'stripe.refund', config: { account: 'acct_1', mode: 'test', currency: 'usd' }, credentialSecret: 'STRIPE_TEST_KEY' },
    });
  });

  it('previews, then invokes bound to the preview with an operation key', async () => {
    const { client, calls } = makeClient({ id: 'prv_1' });
    await client.actions.preview('refund', { paymentIntent: 'pi_1', amount: 1250, currency: 'usd' }, { ttlSeconds: 600 });
    await client.actions.invoke('refund', { paymentIntent: 'pi_1', amount: 1250, currency: 'usd' }, {
      previewId: 'prv_1', operationKey: 'order-42-refund', dependsOn: [{ effect: 'eff_0', outcome: 'succeeded' }], idempotencyKey: 'k1',
    });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.test/api/v2/actions/refund/previews' });
    expect(calls[0].body).toEqual({ input: { paymentIntent: 'pi_1', amount: 1250, currency: 'usd' }, ttlSeconds: 600 });
    expect(calls[1].body).toEqual({
      input: { paymentIntent: 'pi_1', amount: 1250, currency: 'usd' },
      operationKey: 'order-42-refund',
      previewId: 'prv_1',
      dependsOn: [{ effect: 'eff_0', outcome: 'succeeded' }],
    });
    expect(calls[1].headers.get('Idempotency-Key')).toBe('k1');
  });

  it('reads and refreshes previews', async () => {
    const { client, calls } = makeClient();
    await client.actions.getPreview('prv_1');
    await client.actions.refreshPreview('prv_1', { ttlSeconds: 120 });
    expect(calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ['GET', '/api/v2/actions/previews/prv_1'],
      ['POST', '/api/v2/actions/previews/prv_1/refresh'],
    ]);
    expect(calls[1].body).toEqual({ ttlSeconds: 120 });
  });

  it('lists unresolved effects and drives recovery', async () => {
    const { client, calls } = makeClient([], { pagination: { total: 0, page: 1, limit: 20, totalPages: 0, hasMore: false } });
    await client.actions.effects({ unresolved: true, outcome: 'unknown', limit: 5 });
    await client.actions.effect('eff_1');
    await client.actions.reconcileEffect('eff_1');
    await client.actions.addEffectNote('eff_1', 'Checked Stripe dashboard');
    await client.actions.resolveEffect('eff_1', { outcome: 'failed', reason: 'No refund exists in Stripe for this order.' });
    await client.actions.replayEffect('eff_1');
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/v2/actions/effects');
    expect(url.searchParams.get('unresolved')).toBe('true');
    expect(url.searchParams.get('outcome')).toBe('unknown');
    expect(calls.slice(1).map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ['GET', '/api/v2/actions/effects/eff_1'],
      ['POST', '/api/v2/actions/effects/eff_1/reconcile'],
      ['POST', '/api/v2/actions/effects/eff_1/notes'],
      ['POST', '/api/v2/actions/effects/eff_1/resolve'],
      ['POST', '/api/v2/actions/effects/eff_1/replay'],
    ]);
    expect(calls[3].body).toEqual({ note: 'Checked Stripe dashboard' });
    expect(calls[4].body).toEqual({ outcome: 'failed', reason: 'No refund exists in Stripe for this order.' });
  });

  it('manages impact limits', async () => {
    const { client, calls } = makeClient();
    await client.impactLimits.list({ includeArchived: true });
    await client.impactLimits.create({ name: 'Daily refunds', dimension: 'money', currency: 'usd', period: 'day', amount: 10_000 });
    await client.impactLimits.get('lim_1');
    await client.impactLimits.update('lim_1', { amount: 5000 });
    await client.impactLimits.archive('lim_1');
    expect(calls.map((c) => [c.method, new URL(c.url).pathname + new URL(c.url).search])).toEqual([
      ['GET', '/api/v2/impact-limits?includeArchived=true'],
      ['POST', '/api/v2/impact-limits'],
      ['GET', '/api/v2/impact-limits/lim_1'],
      ['PATCH', '/api/v2/impact-limits/lim_1'],
      ['DELETE', '/api/v2/impact-limits/lim_1'],
    ]);
    expect(client.impactLimits).toBe(client.impactLimits);
  });
});

describe('declared actions and receipt grades', () => {
  const impact = { dimension: 'emails', amount: 'count(input.to)', bound: 'exact' } as const;
  const verify = { url: 'https://api.example.com/v1/messages/{{response.id}}', status: 200, match: [{ path: 'status', equals: 'sent' }] };

  it('creates a template action that carries impact and verify', async () => {
    const stored = { id: 'act_1', name: 'send-email', governed: true, impact: { ...impact, unit: 'emails' }, verify, adapter: null };
    const { client, calls } = makeClient(stored);
    const { data } = await client.actions.create({
      name: 'send-email',
      method: 'POST',
      urlTemplate: 'https://api.example.com/v1/messages',
      impact,
      verify,
    });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.test/api/v2/actions' });
    expect(calls[0].body).toEqual({
      name: 'send-email',
      method: 'POST',
      urlTemplate: 'https://api.example.com/v1/messages',
      impact: { dimension: 'emails', amount: 'count(input.to)', bound: 'exact' },
      verify,
    });
    expect(data!.governed).toBe(true);
    expect(data!.impact).toEqual({ dimension: 'emails', unit: 'emails', amount: 'count(input.to)', bound: 'exact' });
    expect(data!.verify!.match[0]).toEqual({ path: 'status', equals: 'sent' });
  });

  it('declare() PATCHes the action with the declarations alone', async () => {
    const { client, calls } = makeClient({ id: 'act_1', name: 'refund', governed: true });
    await client.actions.declare(
      'refund',
      { impact: { dimension: 'money', unit: 'usd', amount: 'input.amount', bound: 'upper_bound' }, governed: true },
      { idempotencyKey: 'declare-1' },
    );
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: 'https://api.test/api/v2/actions/refund' });
    expect(calls[0].body).toEqual({
      impact: { dimension: 'money', unit: 'usd', amount: 'input.amount', bound: 'upper_bound' },
      governed: true,
    });
    expect(calls[0].body).not.toHaveProperty('verify');
    expect(calls[0].headers.get('Idempotency-Key')).toBe('declare-1');
  });

  it('sends null to remove a declaration, and governed: false to remove them all', async () => {
    const { client, calls } = makeClient({ id: 'act_1', name: 'send-email', governed: true, impact: null, verify: null });
    const { data } = await client.actions.declare('send-email', { verify: null });
    await client.actions.declare('send-email', { impact: null, verify: undefined });
    await client.actions.declare('send-email', { governed: false });
    await client.actions.update('send-email', { description: 'Sends one email', verify: null });
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'PATCH', 'PATCH', 'PATCH']);
    expect(calls[0].body).toEqual({ verify: null });
    expect(calls[1].body).toEqual({ impact: null });
    expect(calls[2].body).toEqual({ governed: false });
    expect(calls[3].body).toEqual({ description: 'Sends one email', verify: null });
    expect(data!.impact).toBeNull();
    expect(data!.verify).toBeNull();
  });

  it('filters effects by grade and parses the grade on each one', async () => {
    const effect = { id: 'eff_1', grade: 'acknowledged', outcome: 'succeeded', impact: [{ dimension: 'emails', amount: 3, bound: 'exact' }] };
    const { client, calls } = makeClient([effect], { pagination: { total: 1, page: 1, limit: 20, totalPages: 1, hasMore: false } });
    const page = await client.actions.effects({ grade: 'acknowledged', action: 'send-email' });
    const url = new URL(calls[0].url);
    expect(calls[0].method).toBe('GET');
    expect(url.pathname).toBe('/api/v2/actions/effects');
    expect(url.searchParams.get('grade')).toBe('acknowledged');
    expect(url.searchParams.get('action')).toBe('send-email');
    expect(url.searchParams.has('unresolved')).toBe(false);
    expect(page.data![0].grade).toBe('acknowledged');
    expect(page.data![0].impact[0]).toEqual({ dimension: 'emails', amount: 3, bound: 'exact' });
  });

  it('reads the grade from an invoke response and a single invocation', async () => {
    const { client, calls } = makeClient({ id: 'inv_1', status: 'succeeded', pendingApproval: false, effectId: 'eff_1', grade: 'confirmed' });
    const invoked = await client.actions.invoke('send-email', { to: ['a@example.com'] });
    const read = await client.actions.invocation('inv_1');
    expect(calls[0].body).toEqual({ input: { to: ['a@example.com'] } });
    expect(invoked.data!.grade).toBe('confirmed');
    expect(read.data!.grade).toBe('confirmed');

    const template = makeClient({ id: 'inv_2', status: 'succeeded', pendingApproval: false, effectId: null });
    expect((await template.client.actions.invoke('lookup')).data!.grade).toBeUndefined();
  });

  it('creates a limit in a declared unit and reads its unit back', async () => {
    const stored = { id: 'lim_1', name: 'Daily emails', dimension: 'emails', currency: null, unit: 'emails', period: 'day', limit: 500, available: 500 };
    const { client, calls } = makeClient(stored);
    const { data } = await client.impactLimits.create({ name: 'Daily emails', dimension: 'emails', actionName: 'send-email', period: 'day', amount: 500 });
    await client.impactLimits.create({ name: 'Daily refunds', dimension: 'money', unit: 'usd', period: 'day', amount: 10_000 });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.test/api/v2/impact-limits' });
    expect(calls[0].body).toEqual({ name: 'Daily emails', dimension: 'emails', actionName: 'send-email', period: 'day', amount: 500 });
    expect(calls[1].body).toEqual({ name: 'Daily refunds', dimension: 'money', unit: 'usd', period: 'day', amount: 10_000 });
    expect(data!.dimension).toBe('emails');
    expect(data!.unit).toBe('emails');
    expect(data!.currency).toBeNull();
  });
});
