import { describe, expect, it, vi } from 'vitest';
import { Client } from '../client';

function makeClient(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  let index = 0;
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    calls.push({
      url: url.toString(),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body as string) : undefined,
      headers,
    });
    const next = responses[Math.min(index++, responses.length - 1)];
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
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

describe('runs resource', () => {
  it('is a stable lazy singleton', () => {
    const { client } = makeClient([{ body: { success: true, data: {} } }]);
    expect(client.runs).toBe(client.runs);
  });

  it('starts a run', async () => {
    const { client, calls } = makeClient([{ status: 201, body: { success: true, data: { id: 'run_1' } } }]);
    const { data } = await client.runs.start({ name: 'nightly', agentId: 'agt_1' });
    expect(data!.id).toBe('run_1');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.test/api/v2/runs',
      body: { name: 'nightly', agentId: 'agt_1' },
    });
  });

  it('sends an idempotency key on start when provided', async () => {
    const { client, calls } = makeClient([{ status: 201, body: { success: true, data: { id: 'run_1' } } }]);
    await client.runs.start({ name: 'x' }, { idempotencyKey: 'k1' });
    expect(calls[0].headers['idempotency-key']).toBe('k1');
  });

  it('lists runs with filters as query params', async () => {
    const { client, calls } = makeClient([
      { body: { success: true, data: [], pagination: { total: 0, limit: 20, offset: 0, hasMore: false } } },
    ]);
    await client.runs.list({ search: 'billing', status: 'failed', limit: 10 });
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('search=billing');
    expect(calls[0].url).toContain('status=failed');
    expect(calls[0].url).toContain('limit=10');
  });

  it('gets a run with its span tree', async () => {
    const { client, calls } = makeClient([
      { body: { success: true, data: { id: 'run_1', spans: [{ id: 'span_a', children: [] }] } } },
    ]);
    const { data } = await client.runs.get('run_1');
    expect(data!.spans[0].id).toBe('span_a');
    expect(calls[0].url).toBe('https://api.test/api/v2/runs/run_1');
  });

  it('exports a run trace as OTLP/JSON', async () => {
    const { client, calls } = makeClient([
      { body: { success: true, data: { resourceSpans: [] } } },
    ]);
    const { data } = await client.runs.exportTrace('run_1');
    expect(data!.resourceSpans).toEqual([]);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.test/api/v2/runs/run_1/export' });
  });

  it('imports an OTLP/JSON trace with an idempotency key', async () => {
    const { client, calls } = makeClient([{ status: 201, body: { success: true, data: { id: 'run_imported' } } }]);
    const trace = { resourceSpans: [{ scopeSpans: [{ spans: [{ spanId: 'a', name: 'root', startTimeUnixNano: '1' }] }] }] };
    const { data } = await client.runs.importTrace(trace, { idempotencyKey: 'import-1' });
    expect(data!.id).toBe('run_imported');
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.test/api/v2/runs/import', body: trace });
    expect(calls[0].headers['idempotency-key']).toBe('import-1');
  });

  it('ends a run', async () => {
    const { client, calls } = makeClient([{ body: { success: true, data: { id: 'run_1', status: 'succeeded' } } }]);
    await client.runs.end('run_1', { status: 'succeeded', output: { ok: true } });
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: 'https://api.test/api/v2/runs/run_1',
      body: { status: 'succeeded', output: { ok: true } },
    });
  });

  it('attaches feedback to a run', async () => {
    const { client, calls } = makeClient([{ status: 201, body: { success: true, data: { id: 'fbk_1' } } }]);
    const { data } = await client.runs.addFeedback('run_1', { label: 'thumbs_up', rating: 1 });
    expect(data!.id).toBe('fbk_1');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.test/api/v2/runs/run_1/feedback',
      body: { label: 'thumbs_up', rating: 1 },
    });
  });

  it('lists feedback for a run', async () => {
    const { client, calls } = makeClient([{ body: { success: true, data: [{ id: 'fbk_1' }] } }]);
    const { data } = await client.runs.listFeedback('run_1');
    expect(data![0].id).toBe('fbk_1');
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.test/api/v2/runs/run_1/feedback' });
  });

  it('ingests spans under a spans envelope', async () => {
    const { client, calls } = makeClient([{ body: { success: true, data: { ingested: 2 } } }]);
    const { data } = await client.runs.ingestSpans('run_1', [
      { id: 'span_a', name: 'plan', type: 'model_call', startedAt: '2026-07-15T00:00:00Z' },
      { id: 'span_b', name: 'call', type: 'tool_call', startedAt: '2026-07-15T00:00:01Z' },
    ]);
    expect(data!.ingested).toBe(2);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.test/api/v2/runs/run_1/spans' });
    expect((calls[0].body as { spans: unknown[] }).spans).toHaveLength(2);
  });
});
