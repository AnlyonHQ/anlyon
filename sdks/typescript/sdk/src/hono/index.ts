/**
 * Anlyon Scheduler - Hono Integration
 *
 * First-class support for Hono framework with automatic signature
 * verification using Web Crypto API. Works on Cloudflare Workers,
 * Deno, Bun, Node.js, Vercel Edge, and any other Hono-supported runtime.
 *
 * @packageDocumentation
 * @module @anlyonhq/sdk/hono
 *
 * @example
 * ```typescript
 * // Using serve() for automatic verification
 * import { Hono } from 'hono'
 * import { serve } from '@anlyonhq/sdk/hono'
 *
 * const app = new Hono()
 *
 * app.post('/webhook', serve(async (c) => {
 *   const data = await c.req.json()
 *   await processJob(data)
 *   return { success: true }
 * }))
 *
 * export default app
 * ```
 *
 * @example
 * ```typescript
 * // Using verifySignature() middleware
 * import { Hono } from 'hono'
 * import { verifySignature } from '@anlyonhq/sdk/hono'
 *
 * const app = new Hono()
 *
 * app.use('/webhooks/*', verifySignature())
 *
 * app.post('/webhooks/scheduler', async (c) => {
 *   const data = await c.req.json()
 *   return c.json({ ok: true })
 * })
 * ```
 *
 * @example
 * ```typescript
 * // Cloudflare Workers with bindings
 * import { Hono } from 'hono'
 * import { serve } from '@anlyonhq/sdk/hono'
 *
 * type Bindings = { ANLYON_SIGNING_SECRET: string }
 * const app = new Hono<{ Bindings: Bindings }>()
 *
 * app.post('/webhook', (c) => serve(
 *   async (ctx) => {
 *     const data = await ctx.req.json()
 *     return { processed: true }
 *   },
 *   { signingSecret: c.env.ANLYON_SIGNING_SECRET }
 * )(c))
 * ```
 */

export { serve, type ServeOptions, type ServeHandler, type HonoContext } from './serve';
export {
  verifySignature,
  getVerifiedBody,
  WebCryptoReceiver,
  SignatureVerificationError,
  type VerifySignatureConfig,
  type HonoNext,
} from './middleware';
