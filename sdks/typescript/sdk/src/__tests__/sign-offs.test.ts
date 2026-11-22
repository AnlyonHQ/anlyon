import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '../client';
import { AnlyonError, NotFoundError, SignOffRequiredError } from '../core/errors';
import type { SignOffRequest } from '../types/sign-offs';

type Reply = { status: number; body: unknown };

function makeClient(replies: Reply[]) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: url.toString(), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined });
    const reply = replies.length > 1 ? replies.shift()! : replies[0];
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_1' },
    });
  });
  return {
    calls,
    fetchFn,
    client: new Client({ apiKey: 'test-key', baseUrl: 'https://api.test', fetch: fetchFn as unknown as typeof fetch, retry: { maxAttempts: 3, initialDelay: 1 } }),
  };
}

function signOff(overrides: Partial<SignOffRequest> = {}): SignOffRequest {
  return {
    object: 'sign_off_request',
    id: 'sor_123',
    status: 'pending',
    operation: 'impact_limit.update',
    environmentId: 'env-1',
    resource: { type: 'impact_limit', id: 'lim_123', name: 'Daily refunds' },
    summary: 'Raise impact limit "Daily refunds" from 50000 to 200000',
    changes: [{ field: 'amount', from: 50000, to: 200000, direction: 'loosening', reason: 'Raises a limit.' }],
    diff: '- amount: 50000\n+ amount: 200000',
    signOffUrl: 'https://console.anlyon.com/sign-offs/sor_123',
    pollUrl: '/api/v2/sign-offs/sor_123',
    pollAfterSeconds: 5,
    requestedBy: { type: 'api_key', id: 'key_1', onBehalfOf: null },
    createdAt: '2026-10-28T00:00:00.000Z',
    expiresAt: '2026-10-29T00:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    result: null,
    error: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a loosening change answered 202', () => {
  it('throws SignOffRequiredError carrying the request, its link and id, and does not retry', async () => {
    const { client, fetchFn } = makeClient([{ status: 202, body: { success: true, signOffRequired: true, data: signOff() } }]);
    const failure = await client.impactLimits.update('lim_123', { amount: 200_000 }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SignOffRequiredError);
    expect(failure).toBeInstanceOf(AnlyonError);
    const error = failure as SignOffRequiredError;
    expect(error.code).toBe('SIGN_OFF_REQUIRED');
    expect(error.status).toBe(202);
    expect(error.signOffId).toBe('sor_123');
    expect(error.signOffUrl).toBe('https://console.anlyon.com/sign-offs/sor_123');
    expect(error.signOff.diff).toBe('- amount: 50000\n+ amount: 200000');
    expect(error.requestId).toBe('req_1');
    expect(error.message).toBe(
      'A human must approve this change before it applies. Give them this link: https://console.anlyon.com/sign-offs/sor_123'
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('leaves a 202 without signOffRequired as a normal response', async () => {
    const { client } = makeClient([{ status: 202, body: { success: true, data: { id: 'lim_123', amount: 100 } } }]);
    const { data } = await client.impactLimits.update('lim_123', { amount: 100 });
    expect(data).toMatchObject({ id: 'lim_123' });
  });

  it('a tightening change keeps answering the updated object', async () => {
    const { client } = makeClient([{ status: 200, body: { success: true, data: { id: 'lim_123', amount: 10 } } }]);
    const { data } = await client.impactLimits.update('lim_123', { amount: 10 });
    expect(data).toMatchObject({ amount: 10 });
  });
});

describe('error.fix', () => {
  it('puts the fix on the error and in toJSON', async () => {
    const fix = {
      summary: 'Log in with the scope that decides approvals.',
      command: 'anlyon auth login --scope anlyon:approvals.decide',
      url: 'https://console.anlyon.com/settings/api-keys',
      docs: 'https://docs.anlyon.com/guides/scopes',
    };
    const { client } = makeClient([{ status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'No such limit', fix } } }]);
    const error = (await client.impactLimits.get('lim_x').catch((e: unknown) => e)) as NotFoundError;
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.fix).toEqual(fix);
    expect(error.toJSON()).toMatchObject({ fix });
  });

  it('keeps only the documented fields and drops a malformed fix', async () => {
    const { client } = makeClient([
      { status: 400, body: { success: false, error: { code: 'SOMETHING', message: 'x', fix: { summary: 'Do this.', command: 7, extra: 'y' } } } },
      { status: 400, body: { success: false, error: { code: 'SOMETHING', message: 'x', fix: { command: 'anlyon x' } } } },
    ]);
    const first = (await client.impactLimits.get('a').catch((e: unknown) => e)) as AnlyonError;
    expect(first.fix).toEqual({ summary: 'Do this.' });
    const second = (await client.impactLimits.get('b').catch((e: unknown) => e)) as AnlyonError;
    expect(second.fix).toBeUndefined();
    expect(second.toJSON()).not.toHaveProperty('fix');
  });
});

describe('client.signOffs', () => {
  it('gets, lists and cancels with the routes the API takes', async () => {
    const { client, calls } = makeClient([{ status: 200, body: { success: true, data: signOff() } }]);
    await client.signOffs.get('sor_123');
    await client.signOffs.list({ status: 'pending', limit: 50 });
    await client.signOffs.list();
    await client.signOffs.cancel('sor_123');
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`)).toEqual([
      'GET /api/v2/sign-offs/sor_123',
      'GET /api/v2/sign-offs?status=pending&limit=50',
      'GET /api/v2/sign-offs',
      'POST /api/v2/sign-offs/sor_123/cancel',
    ]);
  });

  it('wait polls until the request leaves pending and returns it', async () => {
    const applied = signOff({ status: 'applied', result: { id: 'lim_123', amount: 200000 }, decidedAt: '2026-10-28T00:01:00.000Z' });
    const { client, calls } = makeClient([
      { status: 200, body: { success: true, data: signOff() } },
      { status: 200, body: { success: true, data: signOff() } },
      { status: 200, body: { success: true, data: applied } },
    ]);
    const decided = await client.signOffs.wait('sor_123', { pollIntervalMs: 1 });
    expect(decided.status).toBe('applied');
    expect(decided.result).toEqual({ id: 'lim_123', amount: 200000 });
    expect(calls).toHaveLength(3);
  });

  it('wait returns the request still pending when the time runs out', async () => {
    const { client } = makeClient([{ status: 200, body: { success: true, data: signOff() } }]);
    const decided = await client.signOffs.wait('sor_123', { timeoutMs: 20, pollIntervalMs: 5 });
    expect(decided.status).toBe('pending');
  });

  it('wait uses pollAfterSeconds when no interval is given', async () => {
    vi.useFakeTimers();
    const { client, calls } = makeClient([
      { status: 200, body: { success: true, data: signOff({ pollAfterSeconds: 2 }) } },
      { status: 200, body: { success: true, data: signOff({ status: 'rejected', decisionNote: 'Too high' }) } },
    ]);
    const waiting = client.signOffs.wait('sor_123');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const decided = await waiting;
    expect(calls).toHaveLength(2);
    expect(decided.status).toBe('rejected');
    expect(decided.decisionNote).toBe('Too high');
  });
});
