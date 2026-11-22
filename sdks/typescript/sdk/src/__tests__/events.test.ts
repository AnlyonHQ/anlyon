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

describe('EventsResource', () => {
  it('publish() posts to /api/v2/events', async () => {
    const { client, calls } = makeClient([
      {
        status: 202,
        body: { success: true, data: { id: 'evt_1', status: 'received' } },
      },
    ]);

    const res = await client.events.publish({
      topic: 'orders',
      type: 'order.created',
      data: { orderId: '123' },
      idempotencyKey: 'k1',
      runId: 'run_trace',
      parentSpanId: 'span_parent',
    });

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://api.test/api/v2/events');
    expect(calls[0].body).toEqual({
      topic: 'orders',
      type: 'order.created',
      data: { orderId: '123' },
      idempotencyKey: 'k1',
      runId: 'run_trace',
      parentSpanId: 'span_parent',
    });
    expect(res.data?.id).toBe('evt_1');
  });

  it('list() queries with topic/type filters', async () => {
    const { client, calls } = makeClient([
      {
        body: {
          success: true,
          data: [{ id: 'evt_1', type: 'order.created', status: 'received' }],
          pagination: { total: 1, page: 1, limit: 20, totalPages: 1, hasMore: false },
        },
      },
    ]);

    const res = await client.events.list({ topic: 'orders', type: 'order.created', limit: 10 });

    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('https://api.test/api/v2/events?');
    expect(calls[0].url).toContain('topic=orders');
    expect(calls[0].url).toContain('type=order.created');
    expect(res.data?.[0].id).toBe('evt_1');
  });

  it('get() fetches event with deliveries', async () => {
    const { client, calls } = makeClient([
      {
        body: {
          success: true,
          data: {
            id: 'evt_1',
            type: 'order.created',
            deliveries: [{ messageId: 'msg_1', status: 'delivered' }],
          },
        },
      },
    ]);

    const res = await client.events.get('evt_1');

    expect(calls[0].url).toBe('https://api.test/api/v2/events/evt_1');
    expect(res.data?.deliveries).toHaveLength(1);
  });

  it('createTopic() posts to /topics', async () => {
    const { client, calls } = makeClient([
      { status: 201, body: { success: true, data: { id: 'top_1', name: 'orders' } } },
    ]);

    const res = await client.events.createTopic({ name: 'orders', description: 'Order events' });

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://api.test/api/v2/events/topics');
    expect(res.data?.name).toBe('orders');
  });

  it('listTopics() gets /topics', async () => {
    const { client, calls } = makeClient([
      { body: { success: true, data: [{ id: 'top_1', name: 'orders' }] } },
    ]);

    const res = await client.events.listTopics();

    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('https://api.test/api/v2/events/topics');
    expect(res.data?.[0].id).toBe('top_1');
  });

  it('deleteTopic() deletes by ref', async () => {
    const { client, calls } = makeClient([
      { body: { success: true, data: { deleted: true } } },
    ]);

    await client.events.deleteTopic('orders');

    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe('https://api.test/api/v2/events/topics/orders');
  });

  it('createSubscription() posts under the topic and returns secret once', async () => {
    const { client, calls } = makeClient([
      {
        status: 201,
        body: {
          success: true,
          data: {
            id: 'sub_1',
            url: 'https://example.com/hook',
            secret: 'whsec_abc',
          },
        },
      },
    ]);

    const res = await client.events.createSubscription('orders', {
      url: 'https://example.com/hook',
      eventTypes: ['order.*'],
      generateSecret: true,
    });

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(
      'https://api.test/api/v2/events/topics/orders/subscriptions'
    );
    expect(calls[0].body).toEqual({
      url: 'https://example.com/hook',
      eventTypes: ['order.*'],
      generateSecret: true,
    });
    expect(res.data?.secret).toBe('whsec_abc');
  });

  it('listSubscriptions() lists for a topic', async () => {
    const { client, calls } = makeClient([
      { body: { success: true, data: [{ id: 'sub_1' }] } },
    ]);

    const res = await client.events.listSubscriptions('orders');

    expect(calls[0].url).toBe(
      'https://api.test/api/v2/events/topics/orders/subscriptions'
    );
    expect(res.data?.[0].id).toBe('sub_1');
  });

  it('deleteSubscription() deletes by id', async () => {
    const { client, calls } = makeClient([
      { body: { success: true, data: { deleted: true } } },
    ]);

    await client.events.deleteSubscription('sub_1');

    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe('https://api.test/api/v2/events/subscriptions/sub_1');
  });

  it('rotateSecret() posts to rotate-secret', async () => {
    const { client, calls } = makeClient([
      { body: { success: true, data: { id: 'sub_1', secret: 'whsec_new' } } },
    ]);

    const res = await client.events.rotateSecret('sub_1');

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(
      'https://api.test/api/v2/events/subscriptions/sub_1/rotate-secret'
    );
    expect(res.data?.secret).toBe('whsec_new');
  });
});
