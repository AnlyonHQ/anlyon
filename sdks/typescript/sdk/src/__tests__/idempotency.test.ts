import { describe, expect, it, vi } from 'vitest';
import { Client } from '../client';

function makeClient() {
  const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    calls.push({ method: init.method ?? 'GET', url: url.toString(), headers });
    return new Response(JSON.stringify({ success: true, data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return {
    calls,
    client: new Client({
      apiKey: 'test-key',
      baseUrl: 'https://api.test',
      fetch: fetchFn as unknown as typeof fetch,
      retry: { maxAttempts: 1 },
    }),
  };
}

const KEY = 'idem-key-1';

describe('idempotency key propagation', () => {
  it('sends the header on POST mutations across every idempotent resource', async () => {
    const { client, calls } = makeClient();

    await client.approvals.request({ title: 'ship it' }, { idempotencyKey: KEY });
    await client.approvals.approve('apr_1', {}, { idempotencyKey: KEY });
    await client.events.publish({ topic: 't', type: 'e', data: {} }, { idempotencyKey: KEY });
    await client.events.createTopic({ name: 'orders' }, { idempotencyKey: KEY });
    await client.events.createSubscription('orders', { url: 'https://x' }, { idempotencyKey: KEY });
    await client.events.rotateSecret('sub_1', { idempotencyKey: KEY });
    await client.actions.create({ name: 'a', urlTemplate: 'https://x' }, { idempotencyKey: KEY });
    await client.runs.start({}, { idempotencyKey: KEY });

    expect(calls).toHaveLength(8);
    for (const call of calls) {
      expect(call.method).toBe('POST');
      expect(call.headers['idempotency-key']).toBe(KEY);
    }
  });

  it('sends the header on PATCH and DELETE mutations', async () => {
    const { client, calls } = makeClient();

    await client.events.updateTopic('orders', { description: 'd' }, { idempotencyKey: KEY });
    await client.events.updateSubscription('sub_1', { enabled: false }, { idempotencyKey: KEY });
    await client.actions.update('act_1', { description: 'd' }, { idempotencyKey: KEY });

    await client.events.deleteTopic('orders', { idempotencyKey: KEY });
    await client.events.deleteSubscription('sub_1', { idempotencyKey: KEY });
    await client.actions.delete('act_1', { idempotencyKey: KEY });

    expect(calls.map((call) => call.method)).toEqual([
      'PATCH', 'PATCH', 'PATCH', 'DELETE', 'DELETE', 'DELETE',
    ]);
    for (const call of calls) {
      expect(call.headers['idempotency-key']).toBe(KEY);
    }
  });

  it('omits the header when no key is supplied', async () => {
    const { client, calls } = makeClient();

    await client.runs.start({});
    await client.events.deleteTopic('orders');

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers['idempotency-key']).toBeUndefined();
    }
  });

  it('keeps the idempotency key out of the request body', async () => {
    const bodies: unknown[] = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(init.body ? JSON.parse(init.body as string) : undefined);
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new Client({
      apiKey: 'test-key',
      baseUrl: 'https://api.test',
      fetch: fetchFn as unknown as typeof fetch,
      retry: { maxAttempts: 1 },
    });

    await client.actions.importFromOpenApi({ openapi: '3.1.0' }, { baseUrl: 'https://x', idempotencyKey: KEY });

    expect(bodies[0]).toEqual({ spec: { openapi: '3.1.0' }, baseUrl: 'https://x' });
  });
});
