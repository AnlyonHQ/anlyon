import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CliError } from '../errors';
import { EXIT } from '../exit-codes';
import { sanitizeRemoteText } from '../redact';
import { constantTimeEqual } from './pkce';

export const CALLBACK_PATH = '/callback';
/** What the client registers. The server matches any port for a loopback IP (RFC 8252 §7.3). */
export const REGISTERED_REDIRECT_URI = `http://127.0.0.1${CALLBACK_PATH}`;

export interface LoopbackResult {
  code: string;
}

export interface LoopbackListener {
  redirectUri: string;
  /** Resolves with the authorization code once a callback with the right state arrives. */
  result: Promise<LoopbackResult>;
  close(): void;
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`;

function respond(res: ServerResponse, status: number, title: string, body: string) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(page(title, body));
}

/**
 * A one-shot HTTP listener on 127.0.0.1 and an ephemeral port (RFC 8252 §7.3).
 *
 * Bound to the IPv4 loopback literal, not "localhost", so it is never reachable
 * from another machine and never depends on how "localhost" resolves. Only GET
 * /callback is answered. A callback whose `state` does not match is rejected and
 * the listener keeps waiting: a page elsewhere in the browser can reach a
 * loopback port, and must not be able to end the login by guessing wrong. An
 * `iss` parameter, when present, must be the expected issuer (RFC 9207).
 */
export async function startLoopback(options: {
  state: string;
  issuer: string;
  /** The server advertised RFC 9207 `iss`; a response without it is refused. */
  issRequired?: boolean;
  signal?: AbortSignal;
}): Promise<LoopbackListener> {
  let resolveResult!: (value: LoopbackResult) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<LoopbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let done = false;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (done) {
      respond(res, 400, 'Already handled', 'This login has already completed. You can close this tab.');
      return;
    }
    const state = url.searchParams.get('state') ?? '';
    if (!constantTimeEqual(state, options.state)) {
      respond(res, 400, 'Login not recognised', 'This response does not belong to the login in progress.');
      return;
    }
    const iss = url.searchParams.get('iss');
    if (iss === null && options.issRequired) {
      done = true;
      respond(res, 400, 'Login failed', 'The response did not name the authorization server it came from.');
      rejectResult(
        new CliError('OAUTH_ISSUER_MISSING', 'Authorization response omitted the issuer this server says it always sends.', EXIT.AUTH_REQUIRED),
      );
      return;
    }
    if (iss !== null && iss !== options.issuer) {
      done = true;
      respond(res, 400, 'Login failed', 'The response came from an unexpected authorization server.');
      rejectResult(new CliError('OAUTH_ISSUER_MISMATCH', 'Authorization response came from an unexpected issuer.', EXIT.AUTH_REQUIRED));
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      done = true;
      const description = url.searchParams.get('error_description');
      respond(res, 400, 'Login was not completed', 'Return to your terminal for details.');
      rejectResult(
        new CliError(
          error === 'access_denied' ? 'ACCESS_DENIED' : 'OAUTH_ERROR',
          `Authorization failed: ${sanitizeRemoteText(error)}${description ? ` (${sanitizeRemoteText(description)})` : ''}`,
          EXIT.AUTH_REQUIRED,
        ),
      );
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      respond(res, 400, 'Login failed', 'The response carried no authorization code.');
      return;
    }
    done = true;
    respond(res, 200, 'Anlyon CLI is signed in', 'You can close this tab and return to your terminal.');
    resolveResult({ code });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  const close = () => {
    server.closeAllConnections?.();
    server.close();
  };
  const onAbort = () => {
    rejectResult(new CliError('CANCELLED', 'Cancelled.', EXIT.CANCELLED));
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  result.finally(() => options.signal?.removeEventListener('abort', onAbort)).catch(() => {});

  return { redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`, result, close };
}
