/**
 * Express Handler Factory
 *
 * Provides a convenient way to create Express route handlers that
 * automatically verify Anlyon webhook signatures.
 *
 * @example
 * ```typescript
 * import express from 'express'
 * import { serve } from '@anlyonhq/sdk/express'
 *
 * const app = express()
 *
 * app.post('/webhook', express.raw({ type: 'application/json' }), serve((req, res) => {
 *   const data = JSON.parse(req.body.toString())
 *   return { success: true }
 * }))
 * ```
 */

import { Receiver, SignatureVerificationError } from '../receiver';
import type { ExpressRequest, ExpressResponse, ExpressNext } from './middleware';

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
   * timestamp and current time.
   * @default 300 (5 minutes)
   */
  clockTolerance?: number;

  /** Require delivery attribution for this environment. */
  expectedEnvironmentId?: string;

  /**
   * Custom error handler for when verification or processing fails.
   */
  onError?: (error: Error, req: ExpressRequest, res: ExpressResponse) => void;
}

/**
 * The handler function that processes verified requests.
 * Can return data to be sent as JSON, or void to let Express continue.
 */
export type ServeHandler<T = unknown> = (
  req: ExpressRequest,
  res: ExpressResponse
) => T | Promise<T> | void | Promise<void>;

/**
 * Get the raw body from an Express request.
 */
function getRawBody(req: ExpressRequest): string | null {
  if (Buffer.isBuffer(req.body)) {
    return req.body.toString('utf-8');
  }
  if (typeof req.body === 'string') {
    return req.body;
  }
  if (typeof req.body === 'object' && req.body !== null) {
    if ('rawBody' in req && typeof (req as any).rawBody === 'string') {
      return (req as any).rawBody;
    }
    return JSON.stringify(req.body);
  }
  return null;
}

/**
 * Create an Express route handler that automatically verifies
 * Anlyon webhook signatures.
 *
 * IMPORTANT: Use express.raw() middleware before this handler.
 *
 * @param handler - The function to handle verified requests
 * @param options - Configuration options
 * @returns Express route handler
 *
 * @example
 * ```typescript
 * import express from 'express'
 * import { serve } from '@anlyonhq/sdk/express'
 *
 * const app = express()
 *
 * app.post(
 *   '/webhook',
 *   express.raw({ type: 'application/json' }),
 *   serve((req, res) => {
 *     const data = JSON.parse(req.body.toString())
 *     console.log('Received:', data)
 *     return { processed: true }
 *   })
 * )
 * ```
 *
 * @example
 * ```typescript
 * // With custom options and error handling
 * app.post('/webhook', express.raw({ type: 'application/json' }), serve(
 *   (req, res) => {
 *     const data = JSON.parse(req.body.toString())
 *     processJob(data)
 *     return { success: true }
 *   },
 *   {
 *     signingSecret: process.env.CUSTOM_SECRET,
 *     onError: (error, req, res) => {
 *       console.error('Webhook error:', error)
 *       res.status(500).json({ error: 'Processing failed' })
 *     },
 *   }
 * ))
 * ```
 */
export function serve<T = unknown>(
  handler: ServeHandler<T>,
  options: ServeOptions = {}
): (req: ExpressRequest, res: ExpressResponse, next: ExpressNext) => void {
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

  return async (
    req: ExpressRequest,
    res: ExpressResponse,
    _next: ExpressNext
  ): Promise<void> => {
    const body = getRawBody(req);
    const signature = req.get('anlyon-signature') ?? req.headers['anlyon-signature'];

    if (!body) {
      const error = new Error(
        'Missing request body. Make sure to use express.raw() middleware.'
      );
      if (onError) {
        onError(error, req, res);
        return;
      }
      res.status(400).json({ error: error.message });
      return;
    }

    try {
      receiver.verifyOrThrow({
        signature: Array.isArray(signature) ? signature[0] : signature ?? null,
        body,
      });
    } catch (error) {
      if (error instanceof SignatureVerificationError) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
      throw error;
    }

    try {
      const result = await handler(req, res);

      if (result !== undefined && result !== null) {
        res.json(result);
      }
    } catch (error) {
      if (onError) {
        onError(error as Error, req, res);
        return;
      }

      console.error('[Anlyon] Handler error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}
