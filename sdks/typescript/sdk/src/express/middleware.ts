/**
 * Express Signature Verification Middleware
 *
 * Provides middleware for verifying Anlyon webhook signatures
 * in Express applications.
 *
 * IMPORTANT: This middleware requires raw body access. Use express.raw()
 * or a similar middleware to preserve the raw request body.
 *
 * @example
 * ```typescript
 * import express from 'express'
 * import { verifySignature } from '@anlyonhq/sdk/express'
 *
 * const app = express()
 *
 * // Use raw body parser for webhook routes
 * app.use('/webhook', express.raw({ type: 'application/json' }))
 * app.post('/webhook', verifySignature(), (req, res) => {
 *   const data = JSON.parse(req.body.toString())
 *   res.json({ ok: true })
 * })
 * ```
 */

import { Receiver, SignatureVerificationError } from '../receiver';

/**
 * Express Request interface (minimal required fields)
 */
export interface ExpressRequest {
  body: Buffer | string | Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  get(name: string): string | undefined;
}

/**
 * Express Response interface (minimal required fields)
 */
export interface ExpressResponse {
  status(code: number): this;
  json(data: unknown): void;
  send(data: string | Buffer): void;
}

/**
 * Express NextFunction
 */
export type ExpressNext = (error?: Error) => void;

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
   * timestamp and current time.
   * @default 300 (5 minutes)
   */
  clockTolerance?: number;

  /** Require delivery attribution for this environment. */
  expectedEnvironmentId?: string;

  /**
   * Custom error handler for signature verification failures.
   */
  onError?: (
    error: SignatureVerificationError,
    req: ExpressRequest,
    res: ExpressResponse
  ) => void;
}

/**
 * Get the raw body from an Express request.
 * Supports Buffer (from express.raw()) or string.
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
 * Create Express middleware that verifies Anlyon webhook signatures.
 *
 * IMPORTANT: For proper signature verification, use express.raw() for
 * the webhook route to preserve the raw request body.
 *
 * @param config - Configuration options
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * import express from 'express'
 * import { verifySignature } from '@anlyonhq/sdk/express'
 *
 * const app = express()
 *
 * // Raw body for webhook routes
 * app.use('/webhook', express.raw({ type: 'application/json' }))
 *
 * app.post('/webhook', verifySignature(), (req, res) => {
 *   const data = JSON.parse(req.body.toString())
 *   console.log('Verified webhook:', data)
 *   res.json({ success: true })
 * })
 * ```
 *
 * @example
 * ```typescript
 * // With custom options
 * app.post('/webhook', verifySignature({
 *   signingSecret: process.env.MY_SECRET,
 *   clockTolerance: 600,
 *   onError: (error, req, res) => {
 *     console.error('Signature verification failed:', error)
 *     res.status(401).json({ error: error.message })
 *   }
 * }), handler)
 * ```
 */
export function verifySignature(
  config: VerifySignatureConfig = {}
): (req: ExpressRequest, res: ExpressResponse, next: ExpressNext) => void {
  const {
    signingSecret = process.env.ANLYON_SIGNING_SECRET,
    clockTolerance = 300,
    expectedEnvironmentId,
    onError,
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

  return (req: ExpressRequest, res: ExpressResponse, next: ExpressNext): void => {
    const body = getRawBody(req);
    const signature = req.get('anlyon-signature') ?? req.headers['anlyon-signature'];

    if (!body) {
      const error = new SignatureVerificationError(
        'Missing request body. Make sure to use express.raw() middleware for webhook routes.'
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
      next();
    } catch (error) {
      if (error instanceof SignatureVerificationError) {
        if (onError) {
          onError(error, req, res);
          return;
        }
        res.status(401).json({
          error: 'Invalid signature',
          message: error.message,
        });
        return;
      }
      next(error as Error);
    }
  };
}

export { Receiver, SignatureVerificationError };
