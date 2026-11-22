/**
 * Anlyon Scheduler - SvelteKit Integration
 *
 * First-class support for SvelteKit with automatic signature
 * verification using Web Crypto API. Compatible with all SvelteKit
 * adapters including Node, Vercel Edge, Cloudflare Pages, and Netlify.
 *
 * @packageDocumentation
 * @module @anlyonhq/sdk/sveltekit
 *
 * @example
 * ```typescript
 * // src/routes/api/webhook/+server.ts
 * // Using serve() for automatic verification
 * import { serve } from '@anlyonhq/sdk/sveltekit'
 *
 * export const POST = serve(async ({ request }) => {
 *   const data = await request.json()
 *   await processJob(data)
 *   return { success: true }
 * })
 * ```
 *
 * @example
 * ```typescript
 * // src/routes/api/webhook/+server.ts
 * // Using verifySignature() wrapper
 * import { verifySignature } from '@anlyonhq/sdk/sveltekit'
 *
 * export const POST = verifySignature(async ({ request }) => {
 *   const data = await request.json()
 *   return new Response(JSON.stringify({ ok: true }), {
 *     headers: { 'Content-Type': 'application/json' }
 *   })
 * })
 * ```
 *
 * @example
 * ```typescript
 * // Using WebCryptoReceiver directly
 * import { WebCryptoReceiver } from '@anlyonhq/sdk/sveltekit'
 * import { ANLYON_SIGNING_SECRET } from '$env/static/private'
 *
 * const receiver = new WebCryptoReceiver({
 *   signingSecret: ANLYON_SIGNING_SECRET,
 * })
 *
 * export async function POST({ request }) {
 *   const body = await request.text()
 *   const signature = request.headers.get('anlyon-signature')
 *
 *   const isValid = await receiver.verify({ signature, body })
 *   if (!isValid) {
 *     return new Response(JSON.stringify({ error: 'Unauthorized' }), {
 *       status: 401
 *     })
 *   }
 *
 *   // Process verified request...
 *   return new Response(JSON.stringify({ ok: true }))
 * }
 * ```
 */

export { serve, type ServeOptions, type ServeHandler, type RequestEvent } from './serve';
export {
  verifySignature,
  WebCryptoReceiver,
  SignatureVerificationError,
  type VerifySignatureConfig,
} from './verify-signature';
