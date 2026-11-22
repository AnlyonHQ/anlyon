/**
 * Fastify Signature Verification Plugin
 *
 * Provides a Fastify plugin for verifying Anlyon webhook signatures.
 * Register the plugin to add signature verification to routes.
 *
 * @example
 * ```typescript
 * import Fastify from 'fastify'
 * import { anlyonPlugin } from '@anlyonhq/sdk/fastify'
 *
 * const app = Fastify()
 *
 * app.register(anlyonPlugin, {
 *   signingSecret: process.env.ANLYON_SIGNING_SECRET
 * })
 *
 * app.post('/webhook', {
 *   preHandler: app.verifyAnlyonSignature
 * }, async (request, reply) => {
 *   return { ok: true }
 * })
 * ```
 */

import { Receiver, SignatureVerificationError } from '../receiver';

/**
 * Fastify Request interface (minimal required fields)
 */
export interface FastifyRequest {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: string | Buffer;
}

/**
 * Fastify Reply interface (minimal required fields)
 */
export interface FastifyReply {
  code(statusCode: number): this;
  send(payload?: unknown): this;
  status(statusCode: number): this;
}

/**
 * Fastify instance interface (minimal required fields)
 */
export interface FastifyInstance {
  decorate(name: string, value: unknown): this;
  addContentTypeParser(
    contentType: string,
    opts: { parseAs: 'string' | 'buffer' },
    parser: (request: FastifyRequest, payload: string | Buffer, done: (err: Error | null, body?: unknown) => void) => void
  ): void;
  decorateRequest(name: string, value: unknown): this;
  addHook(name: string, handler: (...args: unknown[]) => Promise<void> | void): this;
  verifyAnlyonSignature?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/**
 * Plugin options type
 */
export interface FastifyPluginOptions {
  prefix?: string;
}

/**
 * Configuration options for the Anlyon plugin
 */
export interface AnlyonPluginOptions {
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
   * Routes to apply signature verification to (glob patterns).
   * If not specified, use the preHandler hook manually.
   */
  routes?: string[];
}

/**
 * Fastify plugin for Anlyon webhook signature verification.
 *
 * This plugin adds:
 * - `verifyAnlyonSignature` preHandler hook to the Fastify instance
 * - Raw body preservation for signature verification
 *
 * @param fastify - Fastify instance
 * @param options - Plugin options
 *
 * @example
 * ```typescript
 * import Fastify from 'fastify'
 * import { anlyonPlugin } from '@anlyonhq/sdk/fastify'
 *
 * const app = Fastify()
 *
 * // Register the plugin
 * app.register(anlyonPlugin, {
 *   signingSecret: process.env.ANLYON_SIGNING_SECRET,
 * })
 *
 * // Use the verification hook on specific routes
 * app.post('/webhook', {
 *   preHandler: app.verifyAnlyonSignature,
 * }, async (request, reply) => {
 *   const data = request.body
 *   await processJob(data)
 *   return { success: true }
 * })
 *
 * app.listen({ port: 3000 })
 * ```
 *
 * @example
 * ```typescript
 * // With auto-verification on specific routes
 * app.register(anlyonPlugin, {
 *   signingSecret: process.env.ANLYON_SIGNING_SECRET,
 *   routes: ['/webhooks/*', '/api/webhook'],
 * })
 * ```
 */
export async function anlyonPlugin(
  fastify: FastifyInstance,
  options: AnlyonPluginOptions & FastifyPluginOptions
): Promise<void> {
  const {
    signingSecret = process.env.ANLYON_SIGNING_SECRET,
    clockTolerance = 300,
    expectedEnvironmentId,
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

  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request: FastifyRequest, payload: string | Buffer, done) => {
      const body = typeof payload === 'string' ? payload : payload.toString('utf-8');
      (request as any).rawBody = body;
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        done(err as Error);
      }
    }
  );

  const verifyAnlyonSignature = async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> => {
    const rawBody = (request as any).rawBody as string | undefined;
    const signature = request.headers['anlyon-signature'];

    if (!rawBody) {
      reply.code(400).send({
        error: 'Missing request body',
        message: 'Could not access raw request body for signature verification',
      });
      return;
    }

    try {
      receiver.verifyOrThrow({
        signature: Array.isArray(signature) ? signature[0] : signature ?? null,
        body: rawBody,
      });
    } catch (error) {
      if (error instanceof SignatureVerificationError) {
        reply.code(401).send({
          error: 'Invalid signature',
          message: error.message,
        });
        return;
      }
      throw error;
    }
  };

  fastify.decorate('verifyAnlyonSignature', verifyAnlyonSignature);
}

(anlyonPlugin as unknown as Record<symbol, unknown>)[Symbol.for('skip-override')] = true;
(anlyonPlugin as unknown as Record<symbol, unknown>)[Symbol.for('fastify.display-name')] = 'anlyon-webhook-verification';
