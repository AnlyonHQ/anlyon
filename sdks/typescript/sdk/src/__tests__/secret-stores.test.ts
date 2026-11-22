import { describe, expect, it, vi } from 'vitest';
import { Client } from '../client';

function makeClient() {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: url.toString(), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined });
    return new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return {
    calls,
    client: new Client({ apiKey: 'test-key', baseUrl: 'https://api.test', fetch: fetchFn as unknown as typeof fetch, retry: { maxAttempts: 1 } }),
  };
}

describe('secret stores (Enterprise)', () => {
  it('manages a store with the request shapes the API takes', async () => {
    const { client, calls } = makeClient();
    await client.secretStores.create({
      name: 'prod-vault',
      type: 'hashicorp_vault',
      config: { address: 'https://vault.example.com:8200', auth: 'approle' },
      credential: { roleId: '<your-role-id>', secretId: '<your-secret-id>' },
      allowedPaths: ['payments'],
      cacheTtlSeconds: 0,
    });
    await client.secretStores.list();
    await client.secretStores.get('prod-vault');
    await client.secretStores.update('prod-vault', { cacheTtlSeconds: 60 }, { confirmProtected: true });
    await client.secretStores.check('prod-vault');
    await client.secretStores.delete('prod-vault');

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`)).toEqual([
      'POST /api/v2/secret-stores',
      'GET /api/v2/secret-stores',
      'GET /api/v2/secret-stores/prod-vault',
      'PATCH /api/v2/secret-stores/prod-vault?confirmProtected=true',
      'POST /api/v2/secret-stores/prod-vault/check',
      'DELETE /api/v2/secret-stores/prod-vault',
    ]);
    expect(calls[0].body).toMatchObject({ name: 'prod-vault', type: 'hashicorp_vault', allowedPaths: ['payments'], cacheTtlSeconds: 0 });
    expect(calls[3].body).toEqual({ cacheTtlSeconds: 60 });
  });

  it('creates an external secret with PUT /secrets/{name} and checks it', async () => {
    const { client, calls } = makeClient();
    await client.secrets.putExternal('STRIPE_KEY', {
      external: { store: 'prod-vault', path: 'payments/stripe', key: 'apiKey' },
      allowedHosts: ['api.stripe.com'],
      allowedPlacements: ['header'],
    });
    await client.secrets.check('STRIPE_KEY');
    expect(calls[0]).toEqual({
      url: 'https://api.test/api/v2/secrets/STRIPE_KEY',
      method: 'PUT',
      body: { external: { store: 'prod-vault', path: 'payments/stripe', key: 'apiKey' }, allowedHosts: ['api.stripe.com'], allowedPlacements: ['header'] },
    });
    expect(calls[1]).toMatchObject({ url: 'https://api.test/api/v2/secrets/STRIPE_KEY/check', method: 'POST' });
  });

  it('hands back the warning when the store could not produce the value yet', async () => {
    const warning = { code: 'EXTERNAL_SECRET_UNREADABLE', reason: 'reference_not_found', message: 'Secret STRIPE_KEY was saved, and ...' };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { name: 'STRIPE_KEY', health: { status: 'unreachable' } }, warning }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const client = new Client({ apiKey: 'test-key', baseUrl: 'https://api.test', fetch: fetchFn as unknown as typeof fetch, retry: { maxAttempts: 1 } });
    const result = await client.secrets.putExternal('STRIPE_KEY', { external: { store: 'prod-vault', path: 'p', key: 'k' } });
    expect(result.warning).toEqual(warning);
    expect(result.data).toMatchObject({ health: { status: 'unreachable' } });
  });

  it('exposes the resource as a stable lazy singleton', () => {
    const { client } = makeClient();
    expect(client.secretStores).toBe(client.secretStores);
  });
});
