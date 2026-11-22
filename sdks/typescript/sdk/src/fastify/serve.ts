/**
 * Fastify Handler Factory
 *
 * Provides a convenient way to create Fastify route handlers that
 * automatically verify Anlyon webhook signatures.
 *
 * @example
 * ```typescript
 * import Fastify from 'fastify'
 * import { serve } from '@anlyonhq/sdk/fastify'
 *
 * const app = Fastify()
 *
 * app.post('/webhook', serve(async (request, reply) => {
 *   const data = request.body
 *   await processJob(data)
 *   return { success: true }
 * }))
 * ```
 */

import { Receiver, SignatureVerificationError } from '../receiver';
import type { FastifyRequest, FastifyReply } from './plugin';

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
  onError?: (error: Error, request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;
}

/**
 * The handler function that processes verified requests.
 */
export type ServeHandler<T = unknown> = (
  request: FastifyRequest,
  reply: FastifyReply
) => T | Promise<T>;

/**
 * Create a Fastify route handler that automatically verifies
 * Anlyon webhook signatures.
 *
 * NOTE: You must configure Fastify to preserve raw body. Use
 * `addContentTypeParser` to capture the raw body string.
 *
 * @param handler - The function to handle verified requests
 * @param options - Configuration options
 * @returns Fastify route handler
 *
 * @example
 * ```typescript
 * import Fastify from 'fastify'
 * import { serve } from '@anlyonhq/sdk/fastify'
 *
 * const app = Fastify()
 *
 * // Configure raw body capture
 * app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, payload, done) => {
 *   req.rawBody = payload
 *   done(null, JSON.parse(payload))
 * })
 *
 * app.post('/webhook', serve(async (request, reply) => {
 *   const data = request.body
 *   console.log('Received webhook:', data)
 *   return { processed: true }
 * }))
 *
 * app.listen({ port: 3000 })
 * ```
 *
 * @example
 * ```typescript
 * // With custom options
 * app.post('/webhook', serve(
 *   async (request, reply) => {
 *     return { ok: true }
 *   },
 *   {
 *     signingSecret: process.env.CUSTOM_SECRET,
 *     clockTolerance: 600,
 *     onError: (error, request, reply) => {
 *       console.error('Webhook error:', error)
 *       reply.code(500).send({ error: 'Processing failed' })
 *     },
 *   }
 * ))
 * ```
 */
export function serve<T = unknown>(
  handler: ServeHandler<T>,
  options: ServeOptions = {}
): (request: FastifyRequest, reply: FastifyReply) => Promise<T | void> {
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

  return async (request: FastifyRequest, reply: FastifyReply): Promise<T | void> => {
    let rawBody: string;
    if (typeof request.rawBody === 'string') {
      rawBody = request.rawBody;
    } else if (Buffer.isBuffer(request.rawBody)) {
      rawBody = request.rawBody.toString('utf-8');
    } else if (typeof request.body === 'string') {
      rawBody = request.body;
    } else if (request.body && typeof request.body === 'object') {
      rawBody = JSON.stringify(request.body);
    } else {
      const error = new Error(
        'Missing request body. Configure raw body capture with addContentTypeParser.'
      );
      if (onError) {
        await onError(error, request, reply);
        return;
      }
      reply.code(400).send({ error: error.message });
      return;
    }

    const signature = request.headers['anlyon-signature'];

    try {
      receiver.verifyOrThrow({
        signature: Array.isArray(signature) ? signature[0] : signature ?? null,
        body: rawBody,
      });
    } catch (error) {
      if (error instanceof SignatureVerificationError) {
        reply.code(401).send({ error: 'Invalid signature' });
        return;
      }
      throw error;
    }

    try {
      const result = await handler(request, reply);
      return result;
    } catch (error) {
      if (onError) {
        await onError(error as Error, request, reply);
        return;
      }

      console.error('[Anlyon] Handler error:', error);
      reply.code(500).send({ error: 'Internal server error' });
    }
  };
}
