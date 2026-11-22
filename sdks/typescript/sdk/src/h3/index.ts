/**
 * Anlyon Scheduler - H3/Nuxt Integration
 *
 * First-class support for H3 and Nuxt 3 with automatic signature
 * verification using Web Crypto API. Compatible with all Nuxt deployment
 * targets including Node.js, Vercel, Netlify, and Cloudflare.
 *
 * @packageDocumentation
 * @module @anlyonhq/sdk/h3
 *
 * @example
 * ```typescript
 * // server/api/webhook.post.ts (Nuxt 3)
 * // Using serve() for automatic verification
 * import { serve } from '@anlyonhq/sdk/h3'
 *
 * export default serve(async (event) => {
 *   const body = await readBody(event)
 *   await processJob(body)
 *   return { success: true }
 * })
 * ```
 *
 * @example
 * ```typescript
 * // server/api/webhook.post.ts (Nuxt 3)
 * // Using verifySignature() wrapper
 * import { verifySignature } from '@anlyonhq/sdk/h3'
 *
 * export default verifySignature(async (event) => {
 *   const body = await readBody(event)
 *   return { ok: true }
 * })
 * ```
 *
 * @example
 * ```typescript
 * // server/middleware/anlyon.ts (Nuxt 3)
 * // Using defineAnlyonMiddleware for route-based verification
 * import { defineAnlyonMiddleware } from '@anlyonhq/sdk/h3'
 *
 * export default defineAnlyonMiddleware({
 *   routes: ['/api/webhook', '/api/scheduler/*'],
 * })
 * ```
 *
 * @example
 * ```typescript
 * // Standalone H3 app
 * import { createApp, createRouter } from 'h3'
 * import { serve } from '@anlyonhq/sdk/h3'
 *
 * const app = createApp()
 * const router = createRouter()
 *
 * router.post('/webhook', serve(async (event) => {
 *   const body = await readBody(event)
 *   return { processed: true }
 * }))
 *
 * app.use(router)
 * ```
 *
 * @example
 * ```typescript
 * // Using WebCryptoReceiver directly
 * import { WebCryptoReceiver } from '@anlyonhq/sdk/h3'
 *
 * const receiver = new WebCryptoReceiver({
 *   signingSecret: process.env.ANLYON_SIGNING_SECRET!,
 * })
 *
 * export default defineEventHandler(async (event) => {
 *   const body = await readRawBody(event)
 *   const signature = getHeader(event, 'anlyon-signature')
 *
 *   const isValid = await receiver.verify({ signature, body })
 *   if (!isValid) {
 *     throw createError({ statusCode: 401, message: 'Unauthorized' })
 *   }
 *
 *   // Process verified request...
 *   return { ok: true }
 * })
 * ```
 */

export {
  serve,
  getVerifiedBody,
  type ServeOptions,
  type ServeHandler,
  type H3Event,
} from './serve';

export {
  defineAnlyonMiddleware,
  verifySignature,
  WebCryptoReceiver,
  SignatureVerificationError,
  type MiddlewareConfig,
} from './middleware';
