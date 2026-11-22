/**
 * Anlyon Scheduler - Next.js Integration
 *
 * First-class support for Next.js App Router with automatic
 * signature verification and convenient handler patterns.
 *
 * @packageDocumentation
 * @module @anlyonhq/sdk/nextjs
 *
 * @example
 * ```typescript
 * // Using serve() for automatic verification
 * import { serve } from '@anlyonhq/sdk/nextjs'
 *
 * export const { POST } = serve(async (request) => {
 *   const data = await request.json()
 *   await processJob(data)
 *   return { success: true }
 * })
 * ```
 *
 * @example
 * ```typescript
 * // Using verifySignature() middleware
 * import { verifySignature } from '@anlyonhq/sdk/nextjs'
 *
 * export const POST = verifySignature(async (request) => {
 *   const data = await request.json()
 *   return Response.json({ ok: true })
 * })
 * ```
 */

export { serve, type ServeOptions, type ServeHandler } from './serve';
export { verifySignature, type VerifySignatureConfig } from './verify-signature';
