import { describe, it, expect, vi } from 'vitest';
import { Client } from '../client';

function makeClient(data: unknown = {}) {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Headers }> = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url: url.toString(),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body as string) : undefined,
      headers: new Headers(init.headers),
    });
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const client = new Client({ apiKey: 'operator-key', baseUrl: 'https://api.test', fetch: fetchFn as unknown as typeof fetch, retry: { maxAttempts: 1 } });
  return { client, calls };
}

describe('unknown invocations', () => {
  it('resolveInvocation() posts the outcome and evidence', async () => {
    const { client, calls } = makeClient();
    await client.actions.resolveInvocation('inv_1', { outcome: 'failed', evidence: 'No charge exists at the provider.', externalReference: 'ch_none' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://api.test/api/v2/actions/invocations/inv_1/resolve');
    expect(calls[0].body).toEqual({ outcome: 'failed', evidence: 'No charge exists at the provider.', externalReference: 'ch_none' });
  });

  it('invoke() sends retryOf with its own idempotency key', async () => {
    const { client, calls } = makeClient();
    await client.actions.invoke('refund_order', { amount: 5 }, { retryOf: 'inv_1', idempotencyKey: 'refund:42:retry-1' });
    expect(calls[0].body).toEqual({ input: { amount: 5 }, retryOf: 'inv_1' });
    expect(calls[0].headers.get('Idempotency-Key')).toBe('refund:42:retry-1');
  });

  it('invocations() filters to the unknown queue', async () => {
    const { client, calls } = makeClient([]);
    await client.actions.invocations({ status: 'unknown', limit: 10 });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('status')).toBe('unknown');
    expect(url.searchParams.get('limit')).toBe('10');
  });
});
