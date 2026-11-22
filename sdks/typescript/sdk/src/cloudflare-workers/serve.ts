/**
 * Cloudflare Workers Handler Factory
 *
 * Provides a convenient way to create Cloudflare Workers fetch handlers
 * that automatically verify Anlyon webhook signatures using Web Crypto API.
 *
 * @example
 * ```typescript
 * import { serve } from '@anlyonhq/sdk/cloudflare-workers'
 *
 * export default {
 *   fetch: serve(async (request, env, ctx) => {
 *     const data = await request.json()
 *     await processJob(data)
 *     return { success: true }
 *   })
 * }
 * ```
 */

import {
  WebCryptoReceiver,
  SignatureVerificationError,
} from '../crypto/web-crypto';

/**
 * Cloudflare Workers environment bindings
 */
export interface CloudflareEnv {
  ANLYON_SIGNING_SECRET?: string;
  [key: string]: unknown;
}

/**
 * Cloudflare Workers execution context
 */
export interface CloudflareContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/**
 * Configuration options for serve()
 */
export interface ServeOptions<Env extends CloudflareEnv = CloudflareEnv> {
  /**
   * The signing secret used to verify webhook signatures.
   * Can be a string or a function that extracts from env.
   */
  signingSecret?: string | ((env: Env) => string);

  /**
   * Maximum allowed time difference in seconds between the signature
   * timestamp and current time.
   * @default 300 (5 minutes)
   */
  clockTolerance?: number;

  /** Require delivery attribution for this environment. */
  expectedEnvironmentId?: string | ((env: Env) => string);

  /**
   * Custom error handler for when verification or processing fails.
   */
  onError?: (
    error: Error,
    request: Request,
    env: Env,
    ctx: CloudflareContext
  ) => Response | Promise<Response>;
}

/**
 * The handler function that processes verified requests.
 */
export type ServeHandler<T = unknown, Env extends CloudflareEnv = CloudflareEnv> = (
  request: Request,
  env: Env,
  ctx: CloudflareContext
) => T | Promise<T>;

/**
 * Create a Cloudflare Workers fetch handler that automatically verifies
 * Anlyon webhook signatures using Web Crypto API.
 *
 * @param handler - The function to handle verified requests
 * @param options - Configuration options
 * @returns A Cloudflare Workers fetch handler
 *
 * @example
 * ```typescript
 * // wrangler.toml: [vars] ANLYON_SIGNING_SECRET = "..."
 * import { serve } from '@anlyonhq/sdk/cloudflare-workers'
 *
 * export default {
 *   fetch: serve(async (request, env, ctx) => {
 *     const data = await request.json()
 *     await processJob(data)
 *     return { success: true }
 *   })
 * }
 * ```
 *
 * @example
 * ```typescript
 * // With typed environment
 * interface Env {
 *   ANLYON_SIGNING_SECRET: string
 *   MY_KV: KVNamespace
 * }
 *
 * export default {
 *   fetch: serve<unknown, Env>(
 *     async (request, env, ctx) => {
 *       const data = await request.json()
 *       await env.MY_KV.put('last-webhook', JSON.stringify(data))
 *       return { stored: true }
 *     },
 *     {
 *       signingSecret: (env) => env.ANLYON_SIGNING_SECRET,
 *     }
 *   )
 * }
 * ```
 */
export function serve<T = unknown, Env extends CloudflareEnv = CloudflareEnv>(
  handler: ServeHandler<T, Env>,
  options: ServeOptions<Env> = {}
): (request: Request, env: Env, ctx: CloudflareContext) => Promise<Response> {
  return async (
    request: Request,
    env: Env,
    ctx: CloudflareContext
  ): Promise<Response> => {
    const {
      signingSecret: secretOption,
      clockTolerance = 300,
      expectedEnvironmentId: environmentOption,
      onError,
    } = options;

    let signingSecret: string | undefined;
    if (typeof secretOption === 'function') {
      signingSecret = secretOption(env);
    } else if (secretOption) {
      signingSecret = secretOption;
    } else {
      signingSecret = env.ANLYON_SIGNING_SECRET;
    }

    if (!signingSecret) {
      throw new Error(
        'Signing secret is required. Set ANLYON_SIGNING_SECRET in wrangler.toml or pass signingSecret option.'
      );
    }

    const expectedEnvironmentId = typeof environmentOption === 'function'
      ? environmentOption(env)
      : environmentOption;
    if (environmentOption !== undefined && expectedEnvironmentId === undefined) {
      throw new Error('expectedEnvironmentId resolver must return an environment identifier.');
    }

    const receiver = new WebCryptoReceiver({
      signingSecret,
      clockTolerance,
      expectedEnvironmentId,
    });

    try {
      const body = await request.text();
      const signature = request.headers.get('anlyon-signature');

      try {
        await receiver.verifyOrThrow({
          signature,
          body,
        });
      } catch (error) {
        if (error instanceof SignatureVerificationError) {
          return Response.json({ error: 'Invalid signature' }, { status: 401 });
        }
        throw error;
      }

      const verifiedRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
      });

      const result = await handler(verifiedRequest, env, ctx);

      if (result instanceof Response) {
        return result;
      }

      return Response.json(result ?? { success: true });
    } catch (error) {
      if (onError) {
        return onError(error as Error, request, env, ctx);
      }

      console.error('[Anlyon] Handler error:', error);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }
  };
}
