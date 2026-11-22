/**
 * Hono Signature Verification Middleware
 *
 * Provides middleware for verifying Anlyon webhook signatures
 * in Hono applications using Web Crypto API.
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono'
 * import { verifySignature } from '@anlyonhq/sdk/hono'
 *
 * const app = new Hono()
 *
 * app.post('/webhook', verifySignature(), async (c) => {
 *   const data = await c.req.json()
 *   return c.json({ ok: true })
 * })
 * ```
 */

import {
  WebCryptoReceiver,
  SignatureVerificationError,
} from '../crypto/web-crypto';

/**
 * Minimal Hono context interface
 */
export interface HonoContext {
  req: {
    raw: Request;
    text(): Promise<string>;
    header(name: string): string | undefined;
  };
  json<T>(data: T, status?: number): Response;
  set(key: string, value: unknown): void;
  get<T>(key: string): T;
}

/**
 * Hono next function
 */
export type HonoNext = () => Promise<void>;

/**
 * Configuration options for verifySignature middleware
 */
export interface VerifySignatureConfig {
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
   * Custom error response handler
   */
  onError?: (error: SignatureVerificationError, c: HonoContext) => Response | Promise<Response>;
}

/**
 * Verified body stored in context
 */
const VERIFIED_BODY_KEY = 'anlyon-verified-body';

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
 * Create Hono middleware that verifies Anlyon webhook signatures.
 *
 * The middleware reads the request body, verifies the signature,
 * and stores the verified body in the context for downstream handlers.
 *
 * @param config - Configuration options
 * @returns Hono middleware function
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono'
 * import { verifySignature } from '@anlyonhq/sdk/hono'
 *
 * const app = new Hono()
 *
 * // Apply to specific route
 * app.post('/webhook', verifySignature(), async (c) => {
 *   const data = await c.req.json()
 *   return c.json({ ok: true })
 * })
 * ```
 *
 * @example
 * ```typescript
 * // With custom options
 * app.post('/webhook', verifySignature({
 *   signingSecret: 'my-secret',
 *   clockTolerance: 600,
 * }), handler)
 * ```
 *
 * @example
 * ```typescript
 * // Apply to all routes under /webhooks
 * app.use('/webhooks/*', verifySignature())
 * ```
 */
export function verifySignature(
  config: VerifySignatureConfig = {}
): (c: HonoContext, next: HonoNext) => Promise<Response | void> {
  return async (c: HonoContext, next: HonoNext): Promise<Response | void> => {
    const {
      signingSecret = getSigningSecret(),
      clockTolerance = 300,
      expectedEnvironmentId,
      onError,
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

    const body = await c.req.text();
    const signature = c.req.header('anlyon-signature') ?? null;

    try {
      await receiver.verifyOrThrow({
        signature,
        body,
      });
    } catch (error) {
      if (error instanceof SignatureVerificationError) {
        if (onError) {
          return onError(error, c);
        }
        return c.json(
          { error: 'Invalid signature', message: error.message },
          401
        );
      }
      throw error;
    }

    c.set(VERIFIED_BODY_KEY, body);

    await next();
  };
}

/**
 * Get the verified request body from context.
 *
 * Use this after verifySignature middleware to access
 * the pre-read request body.
 *
 * @param c - Hono context
 * @returns The verified body string, or undefined if not set
 *
 * @example
 * ```typescript
 * app.post('/webhook', verifySignature(), async (c) => {
 *   const body = getVerifiedBody(c)
 *   const data = JSON.parse(body!)
 *   return c.json({ ok: true })
 * })
 * ```
 */
export function getVerifiedBody(c: HonoContext): string | undefined {
  return c.get<string>(VERIFIED_BODY_KEY);
}

export { WebCryptoReceiver, SignatureVerificationError };
