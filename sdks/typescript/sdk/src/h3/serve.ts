/**
 * H3/Nuxt Handler Factory
 *
 * Provides a convenient way to create H3 event handlers that
 * automatically verify Anlyon webhook signatures.
 *
 * Works with Nuxt 3 server routes and standalone H3 applications.
 * Supports both Node.js and edge runtimes via Web Crypto API.
 *
 * @example
 * ```typescript
 * // server/api/webhook.post.ts (Nuxt 3)
 * import { serve } from '@anlyonhq/sdk/h3'
 *
 * export default serve(async (event) => {
 *   const body = await readBody(event)
 *   await processJob(body)
 *   return { success: true }
 * })
 * ```
 */

import {
  WebCryptoReceiver,
  SignatureVerificationError,
} from '../crypto/web-crypto';

/**
 * H3 Event interface (minimal required fields)
 */
export interface H3Event {
  node: {
    req: {
      headers: Record<string, string | string[] | undefined>;
      method?: string;
      url?: string;
    };
    res: {
      statusCode: number;
      setHeader(name: string, value: string): void;
      end(data?: string): void;
    };
  };
  context: Record<string, unknown>;
  _requestBody?: string;
  path: string;
  method: string;
}

/**
 * Configuration options for serve()
 */
export interface ServeOptions {
  /**
   * The signing secret used to verify webhook signatures.
   * Defaults to environment variable lookup.
   */
  signingSecret?: string;

  /**
   * Maximum allowed time difference in seconds between the signature
   * timestamp and current time.
   * @default 300 (5 minutes)
   */
  clockTolerance?: number;

  /** Require delivery attribution for this environment. */
  expectedEnvironmentId?: string;

  /**
   * Custom error handler for when verification or processing fails.
   */
  onError?: (error: Error, event: H3Event) => unknown | Promise<unknown>;
}

/**
 * The handler function that processes verified requests.
 */
export type ServeHandler<T = unknown> = (
  event: H3Event
) => T | Promise<T>;

declare const Deno: { env: { get(key: string): string | undefined } } | undefined;

/**
 * Get signing secret from environment
 */
function getSigningSecret(): string | undefined {
  if (typeof process !== 'undefined' && process.env) {
    return process.env.ANLYON_SIGNING_SECRET;
  }
  if (typeof Deno !== 'undefined') {
    return Deno.env.get('ANLYON_SIGNING_SECRET');
  }
  return undefined;
}

/**
 * Read raw body from H3 event
 */
async function readRawBody(event: H3Event): Promise<string> {
  if (event._requestBody) {
    return event._requestBody;
  }

  const req = event.node.req;

  return new Promise((resolve, reject) => {
    let body = '';

    const nodeReq = req as unknown as NodeJS.ReadableStream & {
      on(event: string, listener: (...args: unknown[]) => void): void;
    };

    nodeReq.on('data', (chunk: Buffer | string) => {
      body += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    });

    nodeReq.on('end', () => {
      event._requestBody = body;
      resolve(body);
    });

    nodeReq.on('error', reject);
  });
}

/**
 * Get header value from H3 event
 */
function getHeader(event: H3Event, name: string): string | null {
  const value = event.node.req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

/**
 * Send JSON response
 */
function sendJson(event: H3Event, data: unknown, statusCode = 200): void {
  event.node.res.statusCode = statusCode;
  event.node.res.setHeader('Content-Type', 'application/json');
  event.node.res.end(JSON.stringify(data));
}

/**
 * Create an H3 event handler that automatically verifies
 * Anlyon webhook signatures.
 *
 * Uses Web Crypto API for compatibility with edge runtimes.
 *
 * @param handler - The function to handle verified requests
 * @param options - Configuration options
 * @returns H3 event handler
 *
 * @example
 * ```typescript
 * // server/api/webhook.post.ts (Nuxt 3)
 * import { serve } from '@anlyonhq/sdk/h3'
 *
 * export default serve(async (event) => {
 *   const body = await readBody(event)
 *   await processJob(body)
 *   return { success: true }
 * })
 * ```
 *
 * @example
 * ```typescript
 * // Standalone H3 app
 * import { createApp, createRouter, defineEventHandler } from 'h3'
 * import { serve } from '@anlyonhq/sdk/h3'
 *
 * const app = createApp()
 * const router = createRouter()
 *
 * router.post('/webhook', serve(async (event) => {
 *   const body = await readBody(event)
 *   return { processed: true }
 * }))
 *
 * app.use(router)
 * ```
 *
 * @example
 * ```typescript
 * // With custom options
 * export default serve(
 *   async (event) => {
 *     const body = await readBody(event)
 *     return { ok: true }
 *   },
 *   {
 *     signingSecret: process.env.CUSTOM_SECRET,
 *     clockTolerance: 600,
 *     onError: (error, event) => {
 *       console.error('Webhook error:', error)
 *       return { error: error.message }
 *     },
 *   }
 * )
 * ```
 */
export function serve<T = unknown>(
  handler: ServeHandler<T>,
  options: ServeOptions = {}
): (event: H3Event) => Promise<T | void> {
  return async (event: H3Event): Promise<T | void> => {
    const {
      signingSecret = getSigningSecret(),
      clockTolerance = 300,
      expectedEnvironmentId,
      onError,
    } = options;

    if (!signingSecret) {
      throw new Error(
        'Signing secret is required. Set ANLYON_SIGNING_SECRET environment variable or pass signingSecret option.'
      );
    }

    const receiver = new WebCryptoReceiver({
      signingSecret,
      clockTolerance,
      expectedEnvironmentId,
    });

    try {
      const body = await readRawBody(event);
      const signature = getHeader(event, 'anlyon-signature');

      try {
        await receiver.verifyOrThrow({
          signature,
          body,
        });
      } catch (error) {
        if (error instanceof SignatureVerificationError) {
          sendJson(event, { error: 'Invalid signature' }, 401);
          return;
        }
        throw error;
      }

      event.context.anlyonVerifiedBody = body;

      const result = await handler(event);

      return result;
    } catch (error) {
      if (onError) {
        return onError(error as Error, event) as T;
      }

      console.error('[Anlyon] Handler error:', error);
      sendJson(event, { error: 'Internal server error' }, 500);
    }
  };
}

/**
 * Get the verified body from event context.
 *
 * Use this after serve() to get the pre-read body without
 * re-parsing from the request.
 *
 * @param event - H3 event
 * @returns The verified body string
 */
export function getVerifiedBody(event: H3Event): string | undefined {
  return event.context.anlyonVerifiedBody as string | undefined;
}
