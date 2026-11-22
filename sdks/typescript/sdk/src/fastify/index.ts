/**
 * Anlyon Scheduler - Fastify Integration
 *
 * First-class support for Fastify with automatic signature
 * verification using Node.js crypto.
 *
 * @packageDocumentation
 * @module @anlyonhq/sdk/fastify
 *
 * @example
 * ```typescript
 * // Using the plugin (recommended)
 * import Fastify from 'fastify'
 * import { anlyonPlugin } from '@anlyonhq/sdk/fastify'
 *
 * const app = Fastify()
 *
 * app.register(anlyonPlugin, {
 *   signingSecret: process.env.ANLYON_SIGNING_SECRET,
 * })
 *
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
 * // Using serve() for automatic verification
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
 *   return { processed: true }
 * }))
 * ```
 *
 * @example
 * ```typescript
 * // Using Receiver directly
 * import Fastify from 'fastify'
 * import { Receiver } from '@anlyonhq/sdk/fastify'
 *
 * const receiver = new Receiver({
 *   signingSecret: process.env.ANLYON_SIGNING_SECRET!,
 * })
 *
 * app.post('/webhook', async (request, reply) => {
 *   const rawBody = request.rawBody as string
 *   const signature = request.headers['anlyon-signature'] as string
 *
 *   if (!receiver.verify({ signature, body: rawBody })) {
 *     return reply.code(401).send({ error: 'Unauthorized' })
 *   }
 *
 *   // Process verified request...
 *   return { ok: true }
 * })
 * ```
 */

export {
  anlyonPlugin,
  type AnlyonPluginOptions,
  type FastifyRequest,
  type FastifyReply,
  type FastifyInstance,
} from './plugin';

export { serve, type ServeOptions, type ServeHandler } from './serve';

export { Receiver, SignatureVerificationError } from '../receiver';
