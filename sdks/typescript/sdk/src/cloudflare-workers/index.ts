/**
 * Anlyon Scheduler - Cloudflare Workers Integration
 *
 * First-class support for Cloudflare Workers with automatic signature
 * verification using Web Crypto API. Designed for edge computing with
 * minimal cold start times.
 *
 * @packageDocumentation
 * @module @anlyonhq/sdk/cloudflare-workers
 *
 * @example
 * ```typescript
 * // Using serve() for automatic verification
 * import { serve } from '@anlyonhq/sdk/cloudflare-workers'
 *
 * export default {
 *   fetch: serve(async (request, env, ctx) => {
 *     const data = await request.json()
 *     await processJob(data)
 *     return { success: true }
 *   })
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Using verifySignature() wrapper
 * import { verifySignature } from '@anlyonhq/sdk/cloudflare-workers'
 *
 * export default {
 *   fetch: verifySignature(async (request, env, ctx) => {
 *     const data = await request.json()
 *     return Response.json({ ok: true })
 *   })
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Using WebCryptoReceiver directly
 * import { WebCryptoReceiver } from '@anlyonhq/sdk/cloudflare-workers'
 *
 * const receiver = new WebCryptoReceiver({
 *   signingSecret: env.ANLYON_SIGNING_SECRET,
 * })
 *
 * export default {
 *   async fetch(request, env, ctx) {
 *     const body = await request.text()
 *     const signature = request.headers.get('anlyon-signature')
 *
 *     const isValid = await receiver.verify({ signature, body })
 *     if (!isValid) {
 *       return Response.json({ error: 'Unauthorized' }, { status: 401 })
 *     }
 *
 *     // Process verified request...
 *     return Response.json({ ok: true })
 *   }
 * }
 * ```
 */

export {
  serve,
  type ServeOptions,
  type ServeHandler,
  type CloudflareEnv,
  type CloudflareContext,
} from './serve';

export {
  verifySignature,
  WebCryptoReceiver,
  SignatureVerificationError,
  type VerifySignatureConfig,
} from './verify-signature';
