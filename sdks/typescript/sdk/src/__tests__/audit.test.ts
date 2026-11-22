import { describe, expect, it, vi } from 'vitest';
import { Client } from '../client';
import { NotFoundError } from '../core/errors';

interface MockResponse { status?: number; body: unknown; contentType?: string }

function makeClient(responses: MockResponse[]) {
  const calls: Array<{ url: URL; method: string }> = [];
  let index = 0;
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: new URL(url.toString()), method: init.method ?? 'GET' });
    const next = responses[Math.min(index++, responses.length - 1)];
    const contentType = next.contentType ?? 'application/json';
    const body = contentType.includes('json') ? JSON.stringify(next.body) : String(next.body);
    return new Response(body, { status: next.status ?? 200, headers: { 'content-type': contentType } });
  });
  return {
    calls,
    client: new Client({ apiKey: 'anlyon_live_xxx', baseUrl: 'https://api.test', fetch: fetchFn as unknown as typeof fetch, retry: { maxAttempts: 1 } }),
  };
}

const event = {
  schema: 'anlyon.audit.v1', id: 'aud_1', sequence: 7, type: 'approval.vote', category: 'approval',
  occurredAt: '2026-10-19T10:00:00.000Z', workspaceId: 'ws', environmentId: 'env', actor: { type: 'user', id: 'u' },
  resource: { type: 'approval', id: 'apr_1' }, outcome: 'approve', data: {}, context: null,
};

describe('client.audit', () => {
  it('lists records with filters, joining types and sending times as ISO', async () => {
    const { client, calls } = makeClient([{ body: { success: true, data: [event], pagination: { nextBefore: 7 } } }]);
    const page = await client.audit.listEvents({
      from: new Date('2026-10-01T00:00:00Z'), type: ['approval.*', 'policy.updated'], action: 'refund_order', limit: 50, before: 99,
    });
    expect(page.data[0]?.id).toBe('aud_1');
    expect(page.pagination.nextBefore).toBe(7);
    const url = calls[0]!.url;
    expect(url.pathname).toBe('/api/v2/audit/events');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: '2026-10-01T00:00:00.000Z', type: 'approval.*,policy.updated', action: 'refund_order', limit: '50', before: '99',
    });
  });

  it('exports CSV as text and JSON as the export document', async () => {
    const { client, calls } = makeClient([
      { body: 'id,sequence\r\naud_1,7\r\n', contentType: 'text/csv' },
      { body: { schema: 'anlyon.audit.export.v1', events: [event], count: 1 } },
    ]);
    expect(await client.audit.export({ from: '2026-10-01', to: '2026-11-01', format: 'csv' })).toContain('aud_1,7');
    const document = await client.audit.export({ from: '2026-10-01', to: '2026-11-01' });
    expect(document.count).toBe(1);
    expect(calls.map(({ url }) => [url.pathname, url.searchParams.get('format'), url.searchParams.get('to')])).toEqual([
      ['/api/v2/audit/export', 'csv', '2026-11-01T00:00:00.000Z'],
      ['/api/v2/audit/export', 'json', '2026-11-01T00:00:00.000Z'],
    ]);
  });

  it('reads the JSON Schema', async () => {
    const { client } = makeClient([{ body: { success: true, data: { schema: 'anlyon.audit.v1', jsonSchema: { required: ['id'] }, eventTypes: {} } } }]);
    expect((await client.audit.schema()).data?.schema).toBe('anlyon.audit.v1');
  });

  it('surfaces an edition without audit streaming as not found', async () => {
    const { client } = makeClient([{ status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Endpoint not found' } } }]);
    await expect(client.audit.listEvents()).rejects.toBeInstanceOf(NotFoundError);
  });

  it('is a stable lazy singleton', () => {
    const { client } = makeClient([{ body: {} }]);
    expect(client.audit).toBe(client.audit);
  });
});
