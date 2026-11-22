import { describe, expect, it, vi } from 'vitest';
import { Client } from '../client';

function makeClient(bodies: unknown[]) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let index = 0;
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: url.toString(), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined });
    const body = bodies[Math.min(index++, bodies.length - 1)];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { calls, client: new Client({ apiKey: 'test-key', baseUrl: 'https://api.test', fetch: fetchFn as unknown as typeof fetch, retry: { maxAttempts: 1 } }) };
}

const ok = (data: unknown) => ({ success: true, data });

describe('ConnectionsResource', () => {
  it('lists integrations and connected accounts', async () => {
    const { client, calls } = makeClient([ok([{ id: 'hubspot' }]), ok([])]);
    expect((await client.connections.integrations()).data).toEqual([{ id: 'hubspot' }]);
    await client.connections.list();
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /api/v2/connections/integrations',
      'GET /api/v2/connections',
    ]);
  });

  it('asks for the best way to act in an app, with the name encoded', async () => {
    const { client, calls } = makeClient([ok({ name: 'Acme', route: { kind: 'openapi' } })]);
    expect((await client.connections.findRoute('Acme & co')).data?.route.kind).toBe('openapi');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('https://api.test/api/v2/connections/integrations/find?name=Acme%20%26%20co');
  });

  it('starts a session and completes it, with and without a reference', async () => {
    const session = { sessionId: 'csn_abcdef123456', connectUrl: 'https://connect.example/x' };
    const { client, calls } = makeClient([ok(session), ok({ status: 'pending', secret: null }), ok({ status: 'completed', secret: { name: 'HUBSPOT' } })]);
    const started = await client.connections.createSession({ integrationId: 'hubspot', secretName: 'HUBSPOT' });
    expect(started.data).toEqual(session);
    expect((await client.connections.complete('csn_abcdef123456')).data).toEqual({ status: 'pending', secret: null });
    await client.connections.complete('csn_abcdef123456', { reference: 'conn-1' });
    expect(calls).toEqual([
      { url: 'https://api.test/api/v2/connections/sessions', method: 'POST', body: { integrationId: 'hubspot', secretName: 'HUBSPOT' } },
      { url: 'https://api.test/api/v2/connections/sessions/csn_abcdef123456/complete', method: 'POST', body: {} },
      { url: 'https://api.test/api/v2/connections/sessions/csn_abcdef123456/complete', method: 'POST', body: { reference: 'conn-1' } },
    ]);
  });

  it('connects an API-key integration with one request and returns the secret metadata', async () => {
    const secret = { name: 'GITHUB', kind: 'static', integrationId: 'github', allowedHosts: ['api.github.com'] };
    const { client, calls } = makeClient([ok(secret)]);
    const result = await client.connections.connectWithApiKey({ integrationId: 'github', secretName: 'GITHUB', apiKey: 'fixture-token-not-a-key', description: 'Issues bot' });
    expect(result.data).toEqual(secret);
    expect(calls).toEqual([
      { url: 'https://api.test/api/v2/connections/keys', method: 'POST', body: { integrationId: 'github', secretName: 'GITHUB', apiKey: 'fixture-token-not-a-key', description: 'Issues bot' } },
    ]);
  });

  it('checks an account and reconnects it, with a key or by starting a session', async () => {
    const checked = { name: 'GITHUB', health: { status: 'needs_reauth', checkedAt: '2026-10-15T00:00:00.000Z', reason: 'key_rejected' } };
    const { client, calls } = makeClient([
      ok(checked),
      ok({ status: 'completed', secret: { ...checked, health: { status: 'active', checkedAt: '2026-10-15T00:01:00.000Z', reason: null } }, session: null }),
      ok({ status: 'pending', secret: null, session: { sessionId: 'csn_abcdef123456', connectUrl: 'https://connect.example/x' } }),
    ]);
    expect((await client.connections.check('GITHUB')).data).toEqual(checked);
    const renewed = await client.connections.reconnect('GITHUB', { apiKey: 'fixture-renewed-not-a-key' });
    expect(renewed.data?.status).toBe('completed');
    const signin = await client.connections.reconnect('HUBSPOT');
    expect(signin.data?.status).toBe('pending');
    expect(calls).toEqual([
      { url: 'https://api.test/api/v2/connections/GITHUB/check', method: 'POST', body: {} },
      { url: 'https://api.test/api/v2/connections/GITHUB/reconnect', method: 'POST', body: { apiKey: 'fixture-renewed-not-a-key' } },
      { url: 'https://api.test/api/v2/connections/HUBSPOT/reconnect', method: 'POST', body: {} },
    ]);
  });

  it('is a stable lazy singleton', () => {
    const { client } = makeClient([ok(null)]);
    expect(client.connections).toBe(client.connections);
  });
});
