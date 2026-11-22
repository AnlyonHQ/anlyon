/**
 * Hono Handler Factory
 *
 * Provides a convenient way to create Hono route handlers that
 * automatically verify Anlyon webhook signatures.
 *
 * Works on Cloudflare Workers, Deno, Bun, Node.js, and any other
 * runtime that supports Hono.
 *
 * @example
 * ```typescript
 * // Using with Hono
 * import { Hono } from 'hono'
 * import { serve } from '@anlyonhq/sdk/hono'
 *
 * const app = new Hono()
 *
 * app.post('/webhook', serve(async (c) => {
 *   const data = await c.req.json()
 *   await processJob(data)
 *   return { success: true }
 * }))
 * ```
 */

import {
  WebCryptoReceiver,
  SignatureVerificationError,
} from '../crypto/web-crypto';

/**
 * Hono Context interface (minimal required fields)
 */
export interface HonoContext {
  req: {
    raw: Request;
    text(): Promise<string>;
    json<T = unknown>(): Promise<T>;
    header(name: string): string | undefined;
  };
  json<T>(data: T, status?: number): Response;
  text(data: string, status?: number): Response;
  body(data: string | ArrayBuffer | ReadableStream, init?: ResponseInit): Response;
}

/**
 * Configuration options for serve()
 */
export interface ServeOptions {
  /**
   * The signing secret used to verify webhook signatures.
   * Defaults to environment variable lookup (varies by runtime).
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
  onError?: (error: Error, c: HonoContext) => Response | Promise<Response>;
}

/**
 * The handler function that processes verified requests.
 */
export type ServeHandler<T = unknown> = (
  c: HonoContext
) => T | Promise<T>;

declare const Deno: { env: { get(key: string): string | undefined } } | undefined;

/**
 * Get signing secret from environment
 * Supports different runtime environments
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
 * Create a Hono route handler that automatically verifies
 * Anlyon webhook signatures using Web Crypto API.
 *
 * @param handler - The function to handle verified requests
 * @param options - Configuration options
 * @returns A Hono handler function
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono'
 * import { serve } from '@anlyonhq/sdk/hono'
 *
 * const app = new Hono()
 *
 * app.post('/webhook', serve(async (c) => {
 *   const data = await c.req.json()
 *   await processJob(data)
 *   return { success: true }
 * }))
 *
 * export default app
 * ```
 *
 * @example
 * ```typescript
 * // Cloudflare Workers
 * import { Hono } from 'hono'
 * import { serve } from '@anlyonhq/sdk/hono'
 *
 * const app = new Hono<{ Bindings: { ANLYON_SIGNING_SECRET: string } }>()
 *
 * app.post('/webhook', serve(
 *   async (c) => {
 *     const data = await c.req.json()
 *     return { processed: true }
 *   },
 *   {
 *     signingSecret: c.env.ANLYON_SIGNING_SECRET,
 *   }
 * ))
 * ```
 */
export function serve<T = unknown>(
  handler: ServeHandler<T>,
  options: ServeOptions = {}
): (c: HonoContext) => Promise<Response> {
  return async (c: HonoContext): Promise<Response> => {
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
      const body = await c.req.text();
      const signature = c.req.header('anlyon-signature') ?? null;

      try {
        await receiver.verifyOrThrow({
          signature,
          body,
        });
      } catch (error) {
        if (error instanceof SignatureVerificationError) {
          return c.json({ error: 'Invalid signature' }, 401);
        }
        throw error;
      }

      const verifiedContext: HonoContext = {
        ...c,
        req: {
          ...c.req,
          raw: new Request(c.req.raw.url, {
            method: c.req.raw.method,
            headers: c.req.raw.headers,
            body,
          }),
          text: async () => body,
          json: async <U = unknown>() => JSON.parse(body) as U,
          header: (name: string) => c.req.header(name),
        },
      };

      const result = await handler(verifiedContext);

      if (result instanceof Response) {
        return result;
      }

      return c.json(result ?? { success: true });
    } catch (error) {
      if (onError) {
        return onError(error as Error, c);
      }

      console.error('[Anlyon] Handler error:', error);
      return c.json({ error: 'Internal server error' }, 500);
    }
  };
}
