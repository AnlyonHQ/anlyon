/**
 * SvelteKit Handler Factory
 *
 * Provides a convenient way to create SvelteKit API route handlers that
 * automatically verify Anlyon webhook signatures.
 *
 * Supports both Node.js adapter and edge adapters (Vercel Edge, Cloudflare).
 *
 * @example
 * ```typescript
 * // src/routes/api/webhook/+server.ts
 * import { serve } from '@anlyonhq/sdk/sveltekit'
 *
 * export const POST = serve(async ({ request }) => {
 *   const data = await request.json()
 *   await processJob(data)
 *   return { success: true }
 * })
 * ```
 */

import {
  WebCryptoReceiver,
  SignatureVerificationError,
} from '../crypto/web-crypto';

/**
 * SvelteKit RequestEvent interface (minimal required fields)
 */
export interface RequestEvent {
  request: Request;
  locals: Record<string, unknown>;
  params: Record<string, string>;
  url: URL;
  platform?: unknown;
  getClientAddress(): string;
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
  onError?: (error: Error, event: RequestEvent) => Response | Promise<Response>;
}

/**
 * The handler function that processes verified requests.
 */
export type ServeHandler<T = unknown> = (
  event: RequestEvent
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
 * Create a SvelteKit API route handler that automatically verifies
 * Anlyon webhook signatures.
 *
 * Uses Web Crypto API for compatibility with all SvelteKit adapters
 * including edge deployments.
 *
 * @param handler - The function to handle verified requests
 * @param options - Configuration options
 * @returns SvelteKit RequestHandler
 *
 * @example
 * ```typescript
 * // src/routes/api/webhook/+server.ts
 * import { serve } from '@anlyonhq/sdk/sveltekit'
 *
 * export const POST = serve(async ({ request }) => {
 *   const data = await request.json()
 *   await processJob(data)
 *   return { success: true }
 * })
 * ```
 *
 * @example
 * ```typescript
 * // With custom options
 * import { serve } from '@anlyonhq/sdk/sveltekit'
 * import { ANLYON_SIGNING_SECRET } from '$env/static/private'
 *
 * export const POST = serve(
 *   async ({ request, locals }) => {
 *     const data = await request.json()
 *     await locals.db.insert(data)
 *     return { stored: true }
 *   },
 *   {
 *     signingSecret: ANLYON_SIGNING_SECRET,
 *     clockTolerance: 600,
 *   }
 * )
 * ```
 *
 * @example
 * ```typescript
 * // With error handling
 * export const POST = serve(
 *   async ({ request }) => {
 *     const data = await request.json()
 *     return { processed: true }
 *   },
 *   {
 *     onError: (error, event) => {
 *       console.error('Webhook failed:', error)
 *       return new Response(JSON.stringify({ error: error.message }), {
 *         status: 500,
 *         headers: { 'Content-Type': 'application/json' }
 *       })
 *     }
 *   }
 * )
 * ```
 */
export function serve<T = unknown>(
  handler: ServeHandler<T>,
  options: ServeOptions = {}
): (event: RequestEvent) => Promise<Response> {
  return async (event: RequestEvent): Promise<Response> => {
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
      const body = await event.request.text();
      const signature = event.request.headers.get('anlyon-signature');

      try {
        await receiver.verifyOrThrow({
          signature,
          body,
        });
      } catch (error) {
        if (error instanceof SignatureVerificationError) {
          return new Response(JSON.stringify({ error: 'Invalid signature' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw error;
      }

      const verifiedRequest = new Request(event.request.url, {
        method: event.request.method,
        headers: event.request.headers,
        body,
      });

      const verifiedEvent: RequestEvent = {
        ...event,
        request: verifiedRequest,
      };

      const result = await handler(verifiedEvent);

      if (result instanceof Response) {
        return result;
      }

      return new Response(JSON.stringify(result ?? { success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      if (onError) {
        return onError(error as Error, event);
      }

      console.error('[Anlyon] Handler error:', error);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  };
}
