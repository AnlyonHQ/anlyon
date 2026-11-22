/**
 * SvelteKit Signature Verification
 *
 * Provides middleware-style wrapper and hook for verifying Anlyon
 * webhook signatures in SvelteKit applications.
 *
 * @example
 * ```typescript
 * // src/routes/api/webhook/+server.ts
 * import { verifySignature } from '@anlyonhq/sdk/sveltekit'
 *
 * export const POST = verifySignature(async ({ request }) => {
 *   const data = await request.json()
 *   return new Response(JSON.stringify({ ok: true }), {
 *     headers: { 'Content-Type': 'application/json' }
 *   })
 * })
 * ```
 */

import {
  WebCryptoReceiver,
  SignatureVerificationError,
} from '../crypto/web-crypto';
import type { RequestEvent } from './serve';

/**
 * Configuration options for verifySignature
 */
export interface VerifySignatureConfig {
  /**
   * The signing secret used to verify webhook signatures.
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
}

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
 * Wrap a SvelteKit handler with signature verification.
 *
 * @param handler - The handler to wrap
 * @param config - Configuration options
 * @returns A wrapped handler that verifies signatures
 *
 * @example
 * ```typescript
 * // src/routes/api/webhook/+server.ts
 * import { verifySignature } from '@anlyonhq/sdk/sveltekit'
 *
 * export const POST = verifySignature(async ({ request }) => {
 *   const data = await request.json()
 *   return new Response(JSON.stringify({ processed: true }), {
 *     headers: { 'Content-Type': 'application/json' }
 *   })
 * })
 * ```
 *
 * @example
 * ```typescript
 * // With custom configuration
 * import { verifySignature } from '@anlyonhq/sdk/sveltekit'
 * import { SIGNING_SECRET } from '$env/static/private'
 *
 * export const POST = verifySignature(
 *   async ({ request }) => {
 *     const data = await request.json()
 *     return new Response(JSON.stringify({ ok: true }))
 *   },
 *   { signingSecret: SIGNING_SECRET }
 * )
 * ```
 */
export function verifySignature(
  handler: (event: RequestEvent) => Response | Promise<Response>,
  config: VerifySignatureConfig = {}
): (event: RequestEvent) => Promise<Response> {
  return async (event: RequestEvent): Promise<Response> => {
    const {
      signingSecret = getSigningSecret(),
      clockTolerance = 300,
      expectedEnvironmentId,
    } = config;

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

    const body = await event.request.text();
    const signature = event.request.headers.get('anlyon-signature');

    try {
      await receiver.verifyOrThrow({
        signature,
        body,
      });
    } catch (error) {
      if (error instanceof SignatureVerificationError) {
        return new Response(
          JSON.stringify({ error: 'Invalid signature', message: error.message }),
          {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }
        );
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

    return handler(verifiedEvent);
  };
}

export { WebCryptoReceiver, SignatureVerificationError };
