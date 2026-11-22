/**
 * Next.js App Router Handler Factory
 *
 * Provides a convenient way to create Next.js route handlers that
 * automatically verify Anlyon webhook signatures.
 *
 * @example
 * ```typescript
 * // app/api/scheduler/route.ts
 * import { serve } from '@anlyonhq/sdk/nextjs'
 *
 * export const { POST } = serve(async (request) => {
 *   const data = await request.json()
 *   await processJob(data)
 *   return { success: true }
 * })
 * ```
 */

import { Receiver, SignatureVerificationError } from '../receiver';

/**
 * Configuration options for serve()
 */
export interface ServeOptions {
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

  /**
   * Custom error handler for when verification or processing fails.
   * If not provided, returns a 500 error with a generic message.
   */
  onError?: (error: Error) => Response | Promise<Response>;
}

/**
 * The handler function that processes verified requests.
 * Receives the verified request and should return the response data.
 */
export type ServeHandler<T = unknown> = (
  request: Request
) => T | Promise<T>;

/**
 * Create a Next.js App Router handler that automatically verifies
 * Anlyon webhook signatures.
 *
 * The returned object can be directly exported from a route.ts file.
 *
 * @param handler - The function to handle verified requests
 * @param options - Configuration options
 * @returns An object with a POST method for Next.js App Router
 *
 * @example
 * ```typescript
 * // app/api/scheduler/route.ts
 * import { serve } from '@anlyonhq/sdk/nextjs'
 *
 * export const { POST } = serve(async (request) => {
 *   const data = await request.json()
 *
 *   // Process the verified webhook
 *   await processJob(data)
 *
 *   return { success: true }
 * })
 * ```
 *
 * @example
 * ```typescript
 * // With custom options
 * export const { POST } = serve(
 *   async (request) => {
 *     const data = await request.json()
 *     return { processed: true }
 *   },
 *   {
 *     signingSecret: process.env.CUSTOM_SECRET,
 *     onError: (error) => Response.json(
 *       { error: error.message },
 *       { status: 400 }
 *     ),
 *   }
 * )
 * ```
 */
export function serve<T = unknown>(
  handler: ServeHandler<T>,
  options: ServeOptions = {}
): { POST: (request: Request) => Promise<Response> } {
  const {
    signingSecret = process.env.ANLYON_SIGNING_SECRET,
    clockTolerance = 300,
    expectedEnvironmentId,
    onError,
  } = options;

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

  return {
    POST: async (request: Request): Promise<Response> => {
      try {
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
              { error: 'Invalid signature' },
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

        return Response.json(result ?? { success: true });
      } catch (error) {
        if (onError) {
          return onError(error as Error);
        }

        console.error('[Anlyon] Handler error:', error);
        return Response.json(
          { error: 'Internal server error' },
          { status: 500 }
        );
      }
    },
  };
}
