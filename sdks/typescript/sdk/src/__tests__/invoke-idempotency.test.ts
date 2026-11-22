import { describe, expect, it, vi } from 'vitest';
import { Client } from '../client';
import { generateIdempotencyKey } from '../core/idempotency';

type Reply = () => Response | Promise<Response>;

const ok: Reply = () =>
  new Response(JSON.stringify({ success: true, data: { id: 'inv_1', status: 'succeeded' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const serverError: Reply = () =>
  new Response(JSON.stringify({ success: false, error: { code: 'INTERNAL', message: 'boom' } }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });

const timeout: Reply = () => {
  throw new DOMException('The operation was aborted.', 'AbortError');
};

function makeClient(replies: Reply[] = []) {
  const calls: Array<{ method: string; url: string; key: string | null }> = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      method: init.method ?? 'GET',
      url: url.toString(),
      key: new Headers(init.headers).get('idempotency-key'),
    });
    return (replies.shift() ?? ok)();
  });
  return {
    calls,
    client: new Client({
      apiKey: 'test-key',
      baseUrl: 'https://api.test',
      fetch: fetchFn as unknown as typeof fetch,
      retry: { maxAttempts: 3, initialDelay: 1, jitter: false },
    }),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('actions.invoke always carries an idempotency key', () => {
  it('sends a generated Idempotency-Key when the caller passes none', async () => {
    const { client, calls } = makeClient();

    await client.actions.invoke('refund', { charge: 'ch_1' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toMatch(UUID);
  });

  it('sends the same generated key on the retry after a 5xx', async () => {
    const { client, calls } = makeClient([serverError, ok]);

    await client.actions.invoke('refund', { charge: 'ch_1' });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.key).toMatch(UUID);
    expect(calls[1]!.key).toBe(calls[0]!.key);
  });

  it('sends the same generated key on the retry after a timeout', async () => {
    const { client, calls } = makeClient([timeout, timeout, ok]);

    await client.actions.invoke('refund', { charge: 'ch_1' });

    expect(calls).toHaveLength(3);
    expect(calls[0]!.key).toMatch(UUID);
    expect(new Set(calls.map((call) => call.key)).size).toBe(1);
  });

  it('passes a caller-supplied key through unchanged, on every attempt', async () => {
    const { client, calls } = makeClient([serverError, ok]);

    await client.actions.invoke('refund', { charge: 'ch_1' }, { idempotencyKey: 'refund:ord_42' });

    expect(calls.map((call) => call.key)).toEqual(['refund:ord_42', 'refund:ord_42']);
  });

  it('gives two separate invoke calls different generated keys', async () => {
    const { client, calls } = makeClient();

    await client.actions.invoke('refund', { charge: 'ch_1' });
    await client.actions.invoke('refund', { charge: 'ch_1' });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.key).toMatch(UUID);
    expect(calls[1]!.key).toMatch(UUID);
    expect(calls[1]!.key).not.toBe(calls[0]!.key);
  });

  it('keeps the key out of the request body', async () => {
    const bodies: unknown[] = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return ok();
    });
    const client = new Client({
      apiKey: 'test-key',
      baseUrl: 'https://api.test',
      fetch: fetchFn as unknown as typeof fetch,
    });

    await client.actions.invoke(
      'refund',
      { charge: 'ch_1' },
      { idempotencyKey: 'refund:ord_42', operationKey: 'op-1' }
    );

    expect(bodies[0]).toEqual({ input: { charge: 'ch_1' }, operationKey: 'op-1' });
  });
});

describe('every write on the action and approval path carries an idempotency key', () => {
  it('generates one key per call for each write, and reuses it on a retry', async () => {
    const writes: Array<[string, (client: Client) => Promise<unknown>]> = [
      ['actions.create', (c) => c.actions.create({ name: 'a', urlTemplate: 'https://x' })],
      ['actions.importFromOpenApi', (c) => c.actions.importFromOpenApi({ openapi: '3.1.0' })],
      ['actions.update', (c) => c.actions.update('a', { description: 'd' })],
      ['actions.declare', (c) => c.actions.declare('a', { verify: null })],
      ['actions.delete', (c) => c.actions.delete('a')],
      ['actions.preview', (c) => c.actions.preview('a', {})],
      ['actions.refreshPreview', (c) => c.actions.refreshPreview('prv_1')],
      ['actions.reconcileEffect', (c) => c.actions.reconcileEffect('eff_1')],
      ['actions.addEffectNote', (c) => c.actions.addEffectNote('eff_1', 'checked the provider')],
      ['actions.resolveEffect', (c) => c.actions.resolveEffect('eff_1', { outcome: 'failed', reason: 'never arrived' } as never)],
      ['actions.replayEffect', (c) => c.actions.replayEffect('eff_1')],
      ['actions.resolveInvocation', (c) => c.actions.resolveInvocation('inv_1', { outcome: 'failed', note: 'never arrived' } as never)],
      ['approvals.request', (c) => c.approvals.request({ title: 'ship it' })],
      ['approvals.approve', (c) => c.approvals.approve('apr_1')],
      ['approvals.deny', (c) => c.approvals.deny('apr_1')],
    ];

    const seen = new Set<string>();
    for (const [name, write] of writes) {
      const { client, calls } = makeClient([serverError, ok]);
      await write(client);

      expect(calls, name).toHaveLength(2);
      expect(calls[0]!.key, name).toMatch(UUID);
      expect(calls[1]!.key, name).toBe(calls[0]!.key);
      seen.add(calls[0]!.key!);
    }
    expect(seen.size).toBe(writes.length);
  });

  it('uses the caller-supplied key on approval decisions', async () => {
    const { client, calls } = makeClient();

    await client.approvals.approve('apr_1', {}, { idempotencyKey: 'decide:apr_1' });

    expect(calls[0]!.key).toBe('decide:apr_1');
  });

  it('does not add a key to reads', async () => {
    const { client, calls } = makeClient();

    await client.actions.list();
    await client.actions.invocation('inv_1');
    await client.actions.effect('eff_1');
    await client.approvals.get('apr_1');

    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'GET', 'GET']);
    for (const call of calls) expect(call.key).toBeNull();
  });
});

describe('generateIdempotencyKey', () => {
  it('returns a UUID v4 without a Web Crypto global', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      const a = generateIdempotencyKey();
      const b = generateIdempotencyKey();
      expect(a).toMatch(UUID);
      expect(b).toMatch(UUID);
      expect(a).not.toBe(b);
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
    }
  });
});

describe('a retry that arrives while the original is still running', () => {
  const inProgress: Reply = () =>
    new Response(
      JSON.stringify({
        success: false,
        error: {
          code: 'idempotency_request_in_progress',
          message: 'A request with this Idempotency-Key is still being processed. Retry shortly.',
        },
      }),
      { status: 409, headers: { 'content-type': 'application/json', 'retry-after': '1' } },
    );

  it('is not retried again, and the error names the generated key', async () => {
    const { client, calls } = makeClient([timeout, inProgress]);

    const error = await client.actions.invoke('refund', { charge: 'ch_1' }).catch((e: unknown) => e);

    expect(calls).toHaveLength(2);
    const key = calls[0]!.key!;
    expect(calls[1]!.key).toBe(key);
    expect(error).toMatchObject({
      code: 'idempotency_request_in_progress',
      status: 409,
      details: { idempotencyKey: key },
    });
    expect((error as Error).message).toContain(key);
  });

  it('names the key the caller passed', async () => {
    const { client, calls } = makeClient([inProgress]);

    const error = await client.actions
      .invoke('refund', { charge: 'ch_1' }, { idempotencyKey: 'refund-ch_1' })
      .catch((e: unknown) => e);

    expect(calls).toHaveLength(1);
    expect(error).toMatchObject({ status: 409, details: { idempotencyKey: 'refund-ch_1' } });
  });
});
