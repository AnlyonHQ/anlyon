// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createConnectCallbackHandler, createSessionHandler } from '../src/server';

const session = { token: 'eus_v1.claims.mac', expiresAt: '2026-10-26T12:15:00.000Z' };

describe('createSessionHandler', () => {
  it('mints a token for the signed-in user only, never cached', async () => {
    const createSession = vi.fn().mockResolvedValue({ data: { ...session, endUserId: 'user_1', capabilities: ['connections'] } });
    const handler = createSessionHandler({ client: { endUsers: { createSession } }, getEndUserId: () => 'user_1', ttlSeconds: 600 });
    const response = await handler(new Request('https://app.test/api/anlyon/session', { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual(session);
    expect(createSession).toHaveBeenCalledWith('user_1', { ttlSeconds: 600 });
  });

  it('answers 401 when nobody is signed in, without calling Anlyon', async () => {
    const createSession = vi.fn();
    const handler = createSessionHandler({ client: { endUsers: { createSession } }, getEndUserId: async () => null });
    const response = await handler(new Request('https://app.test/api/anlyon/session', { method: 'POST' }));
    expect(response.status).toBe(401);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('keeps the reason a mint failed on the server', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const createSession = vi.fn().mockRejectedValue(new Error('Missing scope end-users:write'));
    const handler = createSessionHandler({ client: { endUsers: { createSession } }, getEndUserId: () => 'user_1' });
    const response = await handler(new Request('https://app.test/api/anlyon/session', { method: 'POST' }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('end-users:write');
  });
});

describe('createConnectCallbackHandler', () => {
  const callback = 'https://app.test/api/anlyon/connected';

  it('confirms a pending flow for the signed-in user, then redirects without the flow id', async () => {
    const confirmConnection = vi.fn().mockResolvedValue({ data: { integration: 'github', status: 'active' } });
    const handler = createConnectCallbackHandler({ client: { endUsers: { confirmConnection } }, getEndUserId: () => 'user_1', redirectTo: '/settings/connections' });
    const response = await handler(new Request(`${callback}?integration=github&anlyon_status=pending_confirmation&anlyon_flow=flw_abc`));
    expect(confirmConnection).toHaveBeenCalledWith('user_1', 'flw_abc');
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('Location')!);
    expect(location.pathname).toBe('/settings/connections');
    expect(location.searchParams.get('anlyon_status')).toBe('connected');
    expect(location.searchParams.get('integration')).toBe('github');
    expect(location.searchParams.has('anlyon_flow')).toBe(false);
  });

  it('confirms nothing without a signed-in user', async () => {
    const confirmConnection = vi.fn();
    const handler = createConnectCallbackHandler({ client: { endUsers: { confirmConnection } }, getEndUserId: () => undefined, redirectTo: '/settings' });
    const response = await handler(new Request(`${callback}?integration=github&anlyon_status=pending_confirmation&anlyon_flow=flw_abc`));
    expect(confirmConnection).not.toHaveBeenCalled();
    expect(new URL(response.headers.get('Location')!).searchParams.get('anlyon_status')).toBe('error');
  });

  it('reports a failed confirm as an error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const confirmConnection = vi.fn().mockRejectedValue(new Error('EndUserMismatchError'));
    const handler = createConnectCallbackHandler({
      client: { endUsers: { confirmConnection } },
      getEndUserId: () => 'user_2',
      redirectTo: ({ status }) => `/settings?result=${status}`,
    });
    const response = await handler(new Request(`${callback}?integration=github&anlyon_status=pending_confirmation&anlyon_flow=flw_abc`));
    const location = new URL(response.headers.get('Location')!);
    expect(location.searchParams.get('result')).toBe('error');
    expect(location.searchParams.get('anlyon_status')).toBe('error');
  });

  it('closes a popup with a page that reports to this origin only, under a strict CSP', async () => {
    const handler = createConnectCallbackHandler({ client: { endUsers: { confirmConnection: vi.fn() } }, getEndUserId: () => 'user_1', redirectTo: '/settings' });
    const response = await handler(new Request(`${callback}?anlyon_popup=1&integration=slack&anlyon_status=connected`));
    expect(response.status).toBe(200);
    const csp = response.headers.get('Content-Security-Policy')!;
    const nonce = /'nonce-([0-9a-f]{32})'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain('{"type":"anlyon:connect","status":"connected","integration":"slack"}');
    expect(html).toContain('window.opener.postMessage(m,window.location.origin)');
    expect(html).not.toContain('flw_');
  });

  it('passes on only a catalogue id', async () => {
    const handler = createConnectCallbackHandler({ client: { endUsers: { confirmConnection: vi.fn() } }, getEndUserId: () => 'user_1', redirectTo: '/settings' });
    const response = await handler(new Request(`${callback}?anlyon_popup=1&integration=%3C%2Fscript%3E&anlyon_status=declined`));
    const html = await response.text();
    expect(html).not.toContain('</script><');
    expect(html).toContain('"integration":null');
    expect(html).toContain('Nothing was connected.');
  });
});
