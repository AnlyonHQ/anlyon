/**
 * Route handlers for your server, for `@anlyonhq/react`. Web-standard `Request` in, `Response` out:
 * Next.js route handlers, Remix, Hono, Bun and Deno take them as they are.
 *
 * No React here, and no API key leaves your server: the browser gets a short-lived end-user
 * session token, and confirming a connection stays on the server.
 */

const CHANNEL = 'anlyon-connect';
const MESSAGE = 'anlyon:connect';
const POPUP_PARAM = 'anlyon_popup';

/** Who is signed in to your app, from your own session. Null or undefined when nobody is. */
export type GetEndUserId = (request: Request) => string | null | undefined | Promise<string | null | undefined>;

/** The part of `@anlyonhq/sdk`'s `Client` the session route uses. */
export interface SessionMintingClient {
  endUsers: {
    createSession(
      endUserId: string,
      options?: { ttlSeconds?: number },
    ): Promise<{ data?: { token: string; expiresAt: string } | null }>;
  };
}

/** The part of `@anlyonhq/sdk`'s `Client` the connect callback uses. */
export interface ConnectConfirmingClient {
  endUsers: {
    confirmConnection(endUserId: string, flowId: string): Promise<unknown>;
  };
}

export interface SessionHandlerOptions {
  /** An `@anlyonhq/sdk` client with a key that has `end-users:write` (and `end-users:approvals` for approvals). */
  client: SessionMintingClient;
  getEndUserId: GetEndUserId;
  /** The token's lifetime, 60 to 3600 seconds. Default 900. */
  ttlSeconds?: number;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/**
 * A route that mints an end-user session token for whoever is signed in, and only for them. Answers
 * `{ token, expiresAt }`, which `<AnlyonProvider getToken>` takes as it is.
 *
 * @example
 * ```ts
 * // app/api/anlyon/session/route.ts
 * import { Client } from '@anlyonhq/sdk';
 * import { createSessionHandler } from '@anlyonhq/react/server';
 *
 * export const POST = createSessionHandler({
 *   client: new Client({ apiKey: process.env.ANLYON_API_KEY! }),
 *   getEndUserId: async () => (await auth())?.user.id,
 * });
 * ```
 */
export function createSessionHandler(options: SessionHandlerOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const endUserId = await options.getEndUserId(request);
    if (!endUserId) return json({ error: 'Sign in first.' }, 401);
    try {
      const ttl = options.ttlSeconds === undefined ? undefined : { ttlSeconds: options.ttlSeconds };
      const { data } = await options.client.endUsers.createSession(endUserId, ttl);
      if (!data?.token) throw new Error('Anlyon returned no session token.');
      return json({ token: data.token, expiresAt: data.expiresAt }, 200);
    } catch (error) {
      console.error('[anlyon] Could not create an end-user session:', error instanceof Error ? error.message : error);
      return json({ error: "Couldn't start an Anlyon session." }, 502);
    }
  };
}

/** How a connect flow ended, after the callback did its part. */
export type ConnectOutcomeStatus = 'connected' | 'declined' | 'error';

export interface ConnectCallbackOptions {
  client: ConnectConfirmingClient;
  getEndUserId: GetEndUserId;
  /**
   * Where to send the browser afterwards in redirect mode, e.g. `/settings/connections`. It gets
   * `anlyon_status` and `integration` in its query. In popup mode the popup closes instead.
   */
  redirectTo: string | ((outcome: { status: ConnectOutcomeStatus; integration: string | null }) => string);
}

function outcomeFrom(params: URLSearchParams): { raw: string | null; flowId: string | null; integration: string | null } {
  const integration = params.get('integration');
  return {
    raw: params.get('anlyon_status'),
    flowId: params.get('anlyon_flow') || null,
    integration: integration && /^[a-z][a-z0-9-]{0,63}$/.test(integration) ? integration : null,
  };
}

function nonce(): string {
  const bytes = new Uint8Array(16);
  const crypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The popup's last page: tell the opener, same origin only, and close. */
function popupPage(status: ConnectOutcomeStatus, integration: string | null): Response {
  const n = nonce();
  const message = JSON.stringify({ type: MESSAGE, status, integration }).replace(/</g, '\\u003c');
  const text = status === 'connected' ? 'Connected. You can close this window.' : status === 'declined' ? 'Nothing was connected. You can close this window.' : "That didn't work. Close this window and try again.";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${status === 'connected' ? 'Connected' : 'Not connected'}</title>
<style nonce="${n}">
body{margin:0;min-height:100vh;display:grid;place-items:center;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#0a0a0a;background:#fff}
@media (prefers-color-scheme:dark){body{color:#fafafa;background:#0a0a0a}}
p{margin:0;padding:24px;text-align:center}
</style>
</head>
<body>
<p>${text}</p>
<script nonce="${n}">
(function(){
var m=${message};
try{var c=new BroadcastChannel(${JSON.stringify(CHANNEL)});c.postMessage(m);c.close()}catch(e){}
try{if(window.opener)window.opener.postMessage(m,window.location.origin)}catch(e){}
setTimeout(function(){window.close()},200);
})();
</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${n}'; style-src 'nonce-${n}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}

/**
 * The route your connect `redirectUrl` points at. When the environment asks for confirmation, it
 * confirms the flow for whoever is signed in, so a link forwarded to someone else attaches nothing.
 * Then it closes the popup, or redirects to `redirectTo`.
 *
 * @example
 * ```ts
 * // app/api/anlyon/connected/route.ts
 * export const GET = createConnectCallbackHandler({
 *   client: anlyon,
 *   getEndUserId: async () => (await auth())?.user.id,
 *   redirectTo: '/settings/connections',
 * });
 * ```
 */
export function createConnectCallbackHandler(options: ConnectCallbackOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const { raw, flowId, integration } = outcomeFrom(url.searchParams);
    let status: ConnectOutcomeStatus = raw === 'connected' ? 'connected' : raw === 'declined' ? 'declined' : 'error';

    if (raw === 'pending_confirmation' && flowId) {
      const endUserId = await options.getEndUserId(request);
      if (endUserId) {
        try {
          await options.client.endUsers.confirmConnection(endUserId, flowId);
          status = 'connected';
        } catch (error) {
          console.error('[anlyon] Could not confirm a connection:', error instanceof Error ? error.message : error);
          status = 'error';
        }
      }
    }

    if (url.searchParams.get(POPUP_PARAM) === '1') return popupPage(status, integration);

    const target = typeof options.redirectTo === 'function' ? options.redirectTo({ status, integration }) : options.redirectTo;
    const next = new URL(target, url);
    next.searchParams.set('anlyon_status', status);
    if (integration) next.searchParams.set('integration', integration);
    return new Response(null, { status: 303, headers: { Location: next.toString(), 'Cache-Control': 'no-store' } });
  };
}
