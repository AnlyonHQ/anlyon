/**
 * Cloudflare Workers Signature Verification
 *
 * Provides middleware-style wrapper for verifying Anlyon webhook signatures
 * in Cloudflare Workers using Web Crypto API.
 *
 * @example
 * ```typescript
 * import { verifySignature } from '@anlyonhq/sdk/cloudflare-workers'
 *
 * export default {
 *   fetch: verifySignature(async (request, env, ctx) => {
 *     const data = await request.json()
 *     return Response.json({ ok: true })
 *   })
 * }
 * ```
 */

import {
  WebCryptoReceiver,
  SignatureVerificationError,
} from '../crypto/web-crypto';
import type { CloudflareEnv, CloudflareContext } from './serve';

/**
 * Configuration options for verifySignature
 */
export interface VerifySignatureConfig<Env extends CloudflareEnv = CloudflareEnv> {
  /**
   * The signing secret used to verify webhook signatures.
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
}

/**
 * Wrap a Cloudflare Workers handler with signature verification.
 *
 * @param handler - The handler to wrap
 * @param config - Configuration options
 * @returns A wrapped handler that verifies signatures
 *
 * @example
 * ```typescript
 * import { verifySignature } from '@anlyonhq/sdk/cloudflare-workers'
 *
 * export default {
 *   fetch: verifySignature(async (request, env, ctx) => {
 *     const data = await request.json()
 *     return Response.json({ processed: true })
 *   })
 * }
 * ```
 *
 * @example
 * ```typescript
 * // With typed environment
 * interface Env {
 *   SIGNING_SECRET: string
 * }
 *
 * export default {
 *   fetch: verifySignature<Env>(
 *     async (request, env) => {
 *       return Response.json({ ok: true })
 *     },
 *     { signingSecret: (env) => env.SIGNING_SECRET }
 *   )
 * }
 * ```
 */
export function verifySignature<Env extends CloudflareEnv = CloudflareEnv>(
  handler: (
    request: Request,
    env: Env,
    ctx: CloudflareContext
  ) => Response | Promise<Response>,
  config: VerifySignatureConfig<Env> = {}
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
    } = config;

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

    const body = await request.text();
    const signature = request.headers.get('anlyon-signature');

    try {
      await receiver.verifyOrThrow({
        signature,
        body,
      });
    } catch (error) {
      if (error instanceof SignatureVerificationError) {
        return Response.json(
          { error: 'Invalid signature', message: error.message },
          { status: 401 }
        );
      }
      throw error;
    }

    const verifiedRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body,
    });

    return handler(verifiedRequest, env, ctx);
  };
}

export { WebCryptoReceiver, SignatureVerificationError };
