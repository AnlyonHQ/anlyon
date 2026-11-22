import { describe, expect, it, vi } from 'vitest';
import { Client } from '../client';

interface MockResponse { status?: number; body: unknown; contentType?: string }

function makeClient(responses: MockResponse[]) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let index = 0;
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url: url.toString(),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    const next = responses[Math.min(index++, responses.length - 1)];
    const contentType = next.contentType ?? 'application/json';
    const body = contentType.includes('json') ? JSON.stringify(next.body) : String(next.body);
    return new Response(body, { status: next.status ?? 200, headers: { 'content-type': contentType } });
  });
  return {
    calls,
    client: new Client({ apiKey: 'test-key', baseUrl: 'https://api.test', fetch: fetchFn as unknown as typeof fetch, retry: { maxAttempts: 1 } }),
  };
}

describe('contract parity resources', () => {
  it('reads the workspace alert target without mutating billing', async () => {
    const budget = { workspaceId: 'ws_1', enabled: true, maxOverageCents: 2500,
      alertThresholds: [50, 100], behaviourAtMax: 'alert_only' };
    const { client, calls } = makeClient([{ body: { success: true, data: budget } }]);
    expect((await client.billing.getWorkspaceBudget()).data).toEqual(budget);
    expect(calls).toEqual([{ url: 'https://api.test/api/v2/billing/budget', method: 'GET', body: undefined }]);
  });

  it('exposes every newly supported resource as a stable lazy singleton', () => {
    const { client } = makeClient([{ body: { success: true, data: {} } }]);
    for (const resource of ['billing', 'notifications', 'dlq', 'integrations', 'logs'] as const) {
      expect(client[resource]).toBe(client[resource]);
    }
  });

  it('exposes the cross-product analytics endpoints with shared filters', async () => {
    const response = { body: { success: true, data: {} } };
    const { client, calls } = makeClient([response, response, response, response]);
    const params = {
      startDate: new Date('2026-07-01T00:00:00.000Z'),
      granularity: 'day' as const,
      environmentId: '123e4567-e89b-42d3-a456-426614174000',
      limit: 8,
    };

    await client.analytics.getOverview(params);
    await client.analytics.getAgentAnalytics(params);
    await client.analytics.getTrustControlAnalytics(params);
    await client.analytics.getDeliveryAnalytics(params);

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/api/v2/analytics/overview',
      '/api/v2/analytics/agents',
      '/api/v2/analytics/trust-control',
      '/api/v2/analytics/delivery',
    ]);
    expect(calls[0].url).toContain('environmentId=123e4567-e89b-42d3-a456-426614174000');
    expect(calls[0].url).toContain('startDate=2026-07-01T00%3A00%3A00.000Z');
  });

  it('sends the required notification webhook body', async () => {
    const { client, calls } = makeClient([{ body: { success: true, data: { message: 'sent' } } }]);
    await client.notifications.testWebhook({ webhookUrl: 'https://example.com/hook', webhookSecret: 'secret' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.test/api/v2/notifications/preferences/test-webhook',
      body: { webhookUrl: 'https://example.com/hook', webhookSecret: 'secret' },
    });
  });

  it('reads and replaces the caller\'s own notification preferences', async () => {
    const mine = { success: true, data: { mutedTypes: ['quota_warning'], updatedAt: '2026-10-03T00:00:00.000Z' } };
    const { client, calls } = makeClient([{ body: mine }, { body: mine }, { body: { success: true, data: { mutedTypes: [], updatedAt: null } } }]);
    const read = await client.notifications.getMyPreferences();
    const saved = await client.notifications.updateMyPreferences({ mutedTypes: ['quota_warning'] });
    await client.notifications.updateMyPreferences({ mutedTypes: [] });
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.test/api/v2/notifications/preferences/me' });
    expect(calls[1]).toMatchObject({
      method: 'PATCH',
      url: 'https://api.test/api/v2/notifications/preferences/me',
      body: { mutedTypes: ['quota_warning'] },
    });
    expect(calls[2]).toMatchObject({ method: 'PATCH', body: { mutedTypes: [] } });
    expect(read.data?.mutedTypes).toEqual(['quota_warning']);
    expect(saved.data?.updatedAt).toBe('2026-10-03T00:00:00.000Z');
  });

  it('normalizes log dates and preserves unified list statistics', async () => {
    const body = {
      success: true, data: [],
      pagination: { total: 0, page: 1, limit: 50, totalPages: 0, hasMore: false },
      stats: { totalSuccess: 0, totalError: 0, totalRetry: 0, avgDuration: 0, errorRate: 0 },
    };
    const { client, calls } = makeClient([{ body }]);
    const response = await client.logs.list({ startDate: new Date('2026-07-01T00:00:00Z') });
    expect(calls[0].url).toContain('startDate=2026-07-01T00%3A00%3A00.000Z');
    expect(response.stats.totalSuccess).toBe(0);
  });

  it('returns CSV exports as raw text and JSON exports as the canonical logs object', async () => {
    const { client, calls } = makeClient([
      { body: 'id,type\n1,message', contentType: 'text/csv' },
      { body: { logs: [{ id: '1', type: 'message', entityId: 'msg_1', status: 'SUCCESS', timestamp: '2026-07-01T00:00:00Z' }] } },
    ]);
    expect(await client.logs.export({ format: 'csv' })).toContain('id,type');
    const json = await client.logs.export({ format: 'json' });
    expect(json.logs).toHaveLength(1);
    expect(calls[0].url).toContain('format=csv');
    expect(calls[1].url).toContain('format=json');
  });

  it('uses canonical hasMore pagination semantics', async () => {
    const page = (id: string, current: number, hasMore: boolean) => ({
      success: true,
      data: [{ messageId: id }],
      pagination: { total: 2, page: current, limit: 1, totalPages: 2, hasMore },
    });
    const { client, calls } = makeClient([{ body: page('msg_1', 1, true) }, { body: page('msg_2', 2, false) }]);
    const failed = await client.dlq.listAll({ limit: 1 }).toArray();
    expect(failed.map((message) => message.messageId)).toEqual(['msg_1', 'msg_2']);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0].url).pathname).toBe('/api/v2/dlq');
    expect(calls[1].url).toContain('page=2');
  });

  it('reads, replays and removes dead-lettered messages on the DLQ paths', async () => {
    const ok = { body: { success: true, data: { message: 'ok', messageId: 'msg_1' } } };
    const { client, calls } = makeClient([ok, ok, ok, ok, ok, ok]);
    await client.dlq.get('msg_1');
    await client.dlq.getStats();
    const replayed = await client.dlq.retry('msg_1');
    await client.dlq.retryAll();
    await client.dlq.delete('msg_1');
    await client.dlq.clear();
    expect(calls.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
      'GET /api/v2/dlq/msg_1',
      'GET /api/v2/dlq/stats',
      'POST /api/v2/dlq/msg_1/retry',
      'POST /api/v2/dlq/retry-all',
      'DELETE /api/v2/dlq/msg_1',
      'DELETE /api/v2/dlq',
    ]);
    expect(replayed.data?.message).toBe('ok');
  });

  it('covers notification deletion and per-action invocation history', async () => {
    const { client, calls } = makeClient([
      { body: { success: true, data: { message: 'deleted' } } },
      { body: { success: true, data: [], pagination: { total: 0, page: 1, limit: 20, totalPages: 0, hasMore: false } } },
    ]);
    await client.notifications.delete('123e4567-e89b-42d3-a456-426614174000');
    await client.actions.invocationsFor('refund-customer', { limit: 20, offset: 0 });
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: 'https://api.test/api/v2/notifications/123e4567-e89b-42d3-a456-426614174000' });
    expect(calls[1].url).toBe('https://api.test/api/v2/actions/refund-customer/invocations?limit=20&offset=0');
  });
});
