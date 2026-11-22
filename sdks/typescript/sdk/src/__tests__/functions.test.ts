import { describe, expect, it, vi } from 'vitest';
import { Client } from '../client';
import { AnlyonError } from '../core/errors';
import { END_USER_HEADER } from '../core/end-user';

interface MockResponse { status?: number; body: unknown }
interface Call { url: string; method: string; body: unknown; endUser: string | null; idempotencyKey: string | null }

function makeClient(responses: MockResponse[] = [{ body: { success: true, data: {} } }]) {
  const calls: Call[] = [];
  let index = 0;
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({
      url: url.toString(),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body as string) : undefined,
      endUser: headers.get(END_USER_HEADER),
      idempotencyKey: headers.get('Idempotency-Key'),
    });
    const next = responses[Math.min(index++, responses.length - 1)];
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
  return { client, calls, fetchFn };
}

const ok = (data: unknown) => ({ body: { success: true, data } });
const route = (call: Call) => `${call.method} ${new URL(call.url).pathname}`;

const version = {
  id: 'fnv_1',
  version: 1,
  language: 'javascript',
  digest: 'sha256:abc',
  allowedActions: ['lookup-order', 'refund'],
  inputSchema: {},
  budgets: { maxActionCalls: 50, maxCpuMs: 1000, maxSubrequests: 100, timeoutMs: 30000 },
  straightThrough: null,
  review: null,
  createdAt: '2026-10-24T12:00:00.000Z',
};
const fn = {
  id: 'fn_1',
  name: 'refund-with-checks',
  description: null,
  environmentId: '123e4567-e89b-42d3-a456-426614174000',
  currentVersion: version,
  createdAt: '2026-10-24T12:00:00.000Z',
  updatedAt: '2026-10-24T12:00:00.000Z',
};
const planned = {
  id: 'frn_plan',
  functionId: 'fn_1',
  functionName: 'refund-with-checks',
  functionVersionId: 'fnv_1',
  mode: 'plan',
  status: 'awaiting_approval',
  endUserId: null,
  input: { order: 'ord_123' },
  inputDigest: 'sha256:in',
  output: null,
  error: null,
  logs: [],
  budget: null,
  actionCalls: 1,
  calls: [
    { sequence: 1, action: 'lookup-order', kind: 'read', state: 'dispatched', invocationId: 'inv_1', refusal: null, plannedSequence: null, createdAt: '2026-10-24T12:00:00.000Z' },
    { sequence: 2, action: 'refund', kind: 'write', state: 'intent', invocationId: null, refusal: null, plannedSequence: null, createdAt: '2026-10-24T12:00:00.000Z' },
  ],
  plan: {
    digest: 'sha256:plan',
    writes: [{ sequence: 2, action: 'refund', input: { order: 'ord_123' } }],
    approval: { id: 'apr_1', status: 'pending', decider: 'team' },
    appliedByRunId: null,
  },
  planRunId: null,
  planDigest: null,
  approvalId: null,
  receipt: null,
  durationMs: 12,
  createdAt: '2026-10-24T12:00:00.000Z',
  finishedAt: '2026-10-24T12:00:00.012Z',
};
const applied = {
  ...planned,
  id: 'frn_apply',
  mode: 'apply',
  status: 'succeeded',
  plan: null,
  planRunId: 'frn_plan',
  planDigest: 'sha256:plan',
  approvalId: 'apr_1',
};

describe('functions', () => {
  it('creates, lists and publishes with the documented request shapes', async () => {
    const { client, calls } = makeClient([ok(fn), ok(fn), ok([fn]), ok({ function: fn, version })]);

    await client.functions.create({ name: 'refund-with-checks' });
    await client.functions.create({ name: 'refund-with-checks', description: 'Refund a paid order.' });
    const { data: list } = await client.functions.list();
    const { data: published } = await client.functions.publish('refund-with-checks', {
      language: 'javascript',
      source: 'export default async function run(input, anlyon) {}',
      allowedActions: ['lookup-order', 'refund'],
      budgets: { maxActionCalls: 10 },
      straightThrough: { actions: ['refund'], maxWrites: 1 },
    });

    expect(calls.map(route)).toEqual([
      'POST /api/v2/functions',
      'POST /api/v2/functions',
      'GET /api/v2/functions',
      'POST /api/v2/functions/refund-with-checks/versions',
    ]);
    expect(calls[0].body).toEqual({ name: 'refund-with-checks' });
    expect(calls[1].body).toEqual({ name: 'refund-with-checks', description: 'Refund a paid order.' });
    expect(calls[3].body).toEqual({
      language: 'javascript',
      source: 'export default async function run(input, anlyon) {}',
      allowedActions: ['lookup-order', 'refund'],
      budgets: { maxActionCalls: 10 },
      straightThrough: { actions: ['refund'], maxWrites: 1 },
    });
    expect(calls.map((c) => c.idempotencyKey)).toEqual([null, null, null, null]);
    expect(list).toEqual([fn]);
    expect(published?.version.id).toBe('fnv_1');
  });

  it('sends a null straightThrough to clear the policy, and leaves out what was not given', async () => {
    const { client, calls } = makeClient([ok({ function: fn, version })]);
    await client.functions.publish('fn_1', { language: 'python', source: 'def run(input, anlyon): pass', allowedActions: [], straightThrough: null });
    expect(calls[0].body).toEqual({ language: 'python', source: 'def run(input, anlyon): pass', allowedActions: [], straightThrough: null });
  });

  it('leaves allowedActions out when not given, so the source proposes it', async () => {
    const { client, calls } = makeClient([ok({ function: fn, version })]);
    await client.functions.publish('fn_1', { language: 'javascript', source: 'export default async function run() {}' });
    expect(calls[0].body).toEqual({ language: 'javascript', source: 'export default async function run() {}' });
  });

  it('plans, then applies the approved plan with planRunId', async () => {
    const { client, calls } = makeClient([ok(planned), ok({ ...planned, plan: { ...planned.plan, approval: { id: 'apr_1', status: 'approved', decider: 'team' } } }), ok(applied)]);

    const { data: plan } = await client.functions.run('refund-with-checks', { input: { order: 'ord_123' } });
    expect(plan!.status).toBe('awaiting_approval');
    expect(plan!.plan!.approval!.id).toBe('apr_1');

    const { data: reread } = await client.functions.runs.get(plan!.id);
    expect(reread!.plan!.approval!.status).toBe('approved');

    const { data: done } = await client.functions.run('refund-with-checks', {
      input: { order: 'ord_123' },
      mode: 'apply',
      planRunId: plan!.id,
    });
    expect(done!.status).toBe('succeeded');
    expect(done!.planRunId).toBe('frn_plan');

    expect(calls.map(route)).toEqual([
      'POST /api/v2/functions/refund-with-checks/runs',
      'GET /api/v2/function-runs/frn_plan',
      'POST /api/v2/functions/refund-with-checks/runs',
    ]);
    expect(calls[0].body).toEqual({ input: { order: 'ord_123' } });
    expect(calls[2].body).toEqual({ input: { order: 'ord_123' }, mode: 'apply', planRunId: 'frn_plan' });
    expect(calls.map((c) => c.idempotencyKey)).toEqual([null, null, null]);
  });

  it('sends an empty body for a run with nothing given, and straight_through as given', async () => {
    const { client, calls } = makeClient([ok(planned), ok(planned)]);
    await client.functions.run('refund-with-checks');
    await client.functions.run('refund-with-checks', { mode: 'straight_through' });
    expect(calls[0].body).toEqual({});
    expect(calls[1].body).toEqual({ mode: 'straight_through' });
  });

  it('refuses apply without planRunId, and planRunId without apply, before sending', async () => {
    const { client, fetchFn } = makeClient();
    await expect(client.functions.run('f', { mode: 'apply' })).rejects.toBeInstanceOf(AnlyonError);
    await expect(client.functions.run('f', { planRunId: 'frn_1' })).rejects.toBeInstanceOf(AnlyonError);
    await expect(client.functions.run('f', { mode: 'plan', planRunId: 'frn_1' })).rejects.toBeInstanceOf(AnlyonError);
    await expect(client.functions.run('f', { mode: 'apply', planRunId: '' })).rejects.toBeInstanceOf(AnlyonError);
    await expect(client.functions.run('', {})).rejects.toBeInstanceOf(AnlyonError);
    await expect(client.functions.runs.get('')).rejects.toBeInstanceOf(AnlyonError);
    await expect(client.functions.create({ name: '' })).rejects.toBeInstanceOf(AnlyonError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reads the version history, one version with its source, and the run history', async () => {
    const { client, calls } = makeClient([
      ok([{ ...version, current: true }]),
      ok({ ...version, current: true, source: 'export default async function run() {}' }),
      ok({ ...version, current: true, source: 'x' }),
      ok([]),
      ok([]),
    ]);
    const { data: versions } = await client.functions.listVersions('refund-with-checks');
    expect(versions![0]!.current).toBe(true);
    const { data: current } = await client.functions.getVersion('refund-with-checks', 'current');
    expect(current!.source).toContain('run');
    await client.functions.getVersion('refund-with-checks', 3);
    await client.functions.listRuns('refund-with-checks');
    await client.functions.listRuns('refund-with-checks', { limit: 20, endUserId: 'user_1' });
    expect(calls.map(route)).toEqual([
      'GET /api/v2/functions/refund-with-checks/versions',
      'GET /api/v2/functions/refund-with-checks/versions/current',
      'GET /api/v2/functions/refund-with-checks/versions/3',
      'GET /api/v2/functions/refund-with-checks/runs',
      'GET /api/v2/functions/refund-with-checks/runs',
    ]);
    expect(new URL(calls[3]!.url).search).toBe('');
    expect(new URL(calls[4]!.url).searchParams.get('limit')).toBe('20');
    expect(new URL(calls[4]!.url).searchParams.get('endUserId')).toBe('user_1');
  });

  it('refuses a version that is not a number from 1 or current, before sending', async () => {
    const { client, fetchFn } = makeClient();
    for (const bad of [0, -1, 1.5, '../runs', '2', '1/../../x', 'current/../x'] as unknown as number[]) {
      await expect(client.functions.getVersion('refund-with-checks', bad)).rejects.toBeInstanceOf(AnlyonError);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('deletes a function by name', async () => {
    const { client, calls } = makeClient([ok({ deleted: true, id: 'fn_1', name: 'a/b' })]);
    const { data } = await client.functions.delete('a/b');
    expect(calls.map(route)).toEqual(['DELETE /api/v2/functions/a%2Fb']);
    expect(data).toEqual({ deleted: true, id: 'fn_1', name: 'a/b' });
  });

  it('encodes the function name and run id in the path', async () => {
    const { client, calls } = makeClient([ok(planned), ok(planned)]);
    await client.functions.run('a/b');
    await client.functions.runs.get('frn_1/x');
    expect(calls[0].url).toBe('https://api.test/api/v2/functions/a%2Fb/runs');
    expect(calls[1].url).toBe('https://api.test/api/v2/function-runs/frn_1%2Fx');
  });

  it('keeps function runs apart from agent runs', () => {
    const { client } = makeClient();
    expect(client.functions.runs).toBe(client.functions.runs);
    expect(client.functions.runs).not.toBe(client.runs as unknown);
    expect(client.functions).toBe(client.functions);
  });

  it('runs and reads for the end user of a forUser() client, and never for the parent', async () => {
    const { client, calls } = makeClient([ok({ ...planned, endUserId: 'user_42' })]);
    const forUser = client.forUser('user_42');

    const { data: plan } = await forUser.functions.run('refund-with-checks', { input: { order: 'ord_123' } });
    await forUser.functions.runs.get(plan!.id);
    await forUser.functions.run('refund-with-checks', { input: { order: 'ord_123' }, mode: 'apply', planRunId: plan!.id });
    await client.functions.run('refund-with-checks');
    await client.functions.runs.get('frn_plan');

    expect(calls.map((c) => c.endUser)).toEqual(['user_42', 'user_42', 'user_42', null, null]);
  });
});
