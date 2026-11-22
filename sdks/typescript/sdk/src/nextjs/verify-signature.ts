/**
 * Next.js Signature Verification Middleware
 *
 * Provides middleware-style wrapper for verifying Anlyon webhook signatures
 * in Next.js App Router route handlers.
 *
 * @example
 * ```typescript
 * // app/api/webhook/route.ts
 * import { verifySignature } from '@anlyonhq/sdk/nextjs'
 *
 * export const POST = verifySignature(async (request) => {
 *   const data = await request.json()
 *   // Process verified webhook...
 *   return Response.json({ ok: true })
 * })
 * ```
 */

import { Receiver, SignatureVerificationError } from '../receiver';

/**
 * Configuration options for verifySignature middleware
 */
export interface VerifySignatureConfig {
  /**
   * The signing secret used to verify webhook signatures.
   * Defaults to `process.env.ANLYON_SIGNING_SECRET`.
   */
  signingSecret?: string;

  /**
   * Maximum allowed time difference in seconds between the signature
   * timestamp and current time. Helps prevent replay attacks.
   * @default 300 (5 minutes)
   */
  clockTolerance?: number;

  /** Require delivery attribution for this environment. */
  expectedEnvironmentId?: string;
}

/**
 * Wrap a Next.js route handler with signature verification.
 *
 * This middleware verifies the Anlyon webhook signature before
 * passing the request to your handler. If verification fails,
 * it returns a 401 Unauthorized response.
 *
 * @param handler - The route handler to wrap
 * @param config - Configuration options
 * @returns A wrapped handler that verifies signatures
 *
 * @example
 * ```typescript
 * // app/api/webhook/route.ts
 * import { verifySignature } from '@anlyonhq/sdk/nextjs'
 *
 * export const POST = verifySignature(async (request) => {
 *   const data = await request.json()
 *
 *   // Signature is already verified at this point
 *   await processWebhook(data)
 *
 *   return Response.json({ success: true })
 * })
 * ```
 *
 * @example
 * ```typescript
 * // With custom configuration
 * export const POST = verifySignature(
 *   async (request) => {
 *     const data = await request.json()
 *     return Response.json({ processed: true })
 *   },
 *   {
 *     signingSecret: process.env.CUSTOM_SECRET,
 *     clockTolerance: 600, // 10 minutes
 *   }
 * )
 * ```
 */
export function verifySignature<T extends Response | object>(
  handler: (request: Request) => Promise<T> | T,
  config: VerifySignatureConfig = {}
): (request: Request) => Promise<Response> {
  const {
    signingSecret = process.env.ANLYON_SIGNING_SECRET,
    clockTolerance = 300,
    expectedEnvironmentId,
  } = config;

  if (!signingSecret) {
    throw new Error(
      'Signing secret is required. Set ANLYON_SIGNING_SECRET environment variable or pass signingSecret option.'
    );
  }

  const receiver = new Receiver({
    signingSecret,
    clockTolerance,
    expectedEnvironmentId,
  });

  return async (request: Request): Promise<Response> => {
    const body = await request.text();
    const signature = request.headers.get('anlyon-signature');

    try {
      receiver.verifyOrThrow({
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

    const result = await handler(verifiedRequest);

    if (result instanceof Response) {
      return result;
    }

    return Response.json(result);
  };
}
