import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@anlyonhq/sdk';
import { eventsTools } from '../src/tools/events.ts';

function tool(name: string) {
  const found = eventsTools.find((t) => t.name === name);
  if (!found) throw new Error(`Tool not found: ${name}`);
  return found;
}

describe('events tool handlers', () => {
  it('publish_event proxies to client.events.publish', async () => {
    const publish = vi.fn().mockResolvedValue({ data: { id: 'evt_1', status: 'received' } });
    const client = { events: { publish } } as unknown as Client;

    const result = await tool('publish_event').handler(client, {
      topic: 'orders',
      type: 'order.created',
      data: { orderId: '1' },
    });

    expect(result).toEqual({ id: 'evt_1', status: 'received' });
    expect(publish).toHaveBeenCalledWith({
      topic: 'orders',
      type: 'order.created',
      data: { orderId: '1' },
      idempotencyKey: undefined,
    });
  });

  it('create_subscription proxies with topicRef', async () => {
    const createSubscription = vi
      .fn()
      .mockResolvedValue({ data: { id: 'sub_1', secret: 'whsec_x' } });
    const client = { events: { createSubscription } } as unknown as Client;

    const result = await tool('create_subscription').handler(client, {
      topicRef: 'orders',
      url: 'https://example.com/hook',
      generateSecret: true,
    });

    expect(result).toEqual({ id: 'sub_1', secret: 'whsec_x' });
    expect(createSubscription).toHaveBeenCalledWith('orders', {
      url: 'https://example.com/hook',
      eventTypes: undefined,
      enabled: undefined,
      generateSecret: true,
      headers: undefined,
    });
  });

  it('list_topics returns topic list data', async () => {
    const listTopics = vi.fn().mockResolvedValue({ data: [{ id: 'top_1', name: 'orders' }] });
    const client = { events: { listTopics } } as unknown as Client;

    const result = await tool('list_topics').handler(client, {});
    expect(result).toEqual([{ id: 'top_1', name: 'orders' }]);
  });

  it('handler errors propagate (surfaced as isError by the server)', async () => {
    const publish = vi.fn().mockRejectedValue(new Error('insufficient scope: events:write required'));
    const client = { events: { publish } } as unknown as Client;

    await expect(tool('publish_event').handler(client, { topic: 't', type: 'e' })).rejects.toThrow('events:write');
  });
});
