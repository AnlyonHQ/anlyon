/**
 * Anlyon Scheduler - Express Integration
 *
 * First-class support for Express.js with automatic signature
 * verification using Node.js crypto.
 *
 * @packageDocumentation
 * @module @anlyonhq/sdk/express
 *
 * @example
 * ```typescript
 * // Using serve() for automatic verification
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
 *     processJob(data)
 *     return { success: true }
 *   })
 * )
 *
 * app.listen(3000)
 * ```
 *
 * @example
 * ```typescript
 * // Using verifySignature() middleware
 * import express from 'express'
 * import { verifySignature } from '@anlyonhq/sdk/express'
 *
 * const app = express()
 *
 * app.use('/webhook', express.raw({ type: 'application/json' }))
 * app.post('/webhook', verifySignature(), (req, res) => {
 *   const data = JSON.parse(req.body.toString())
 *   res.json({ ok: true })
 * })
 * ```
 *
 * @example
 * ```typescript
 * // Using Receiver directly
 * import express from 'express'
 * import { Receiver } from '@anlyonhq/sdk/express'
 *
 * const receiver = new Receiver({
 *   signingSecret: process.env.ANLYON_SIGNING_SECRET!,
 * })
 *
 * app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
 *   const body = req.body.toString()
 *   const signature = req.get('anlyon-signature')
 *
 *   if (!receiver.verify({ signature, body })) {
 *     return res.status(401).json({ error: 'Unauthorized' })
 *   }
 *
 *   // Process verified request...
 *   res.json({ ok: true })
 * })
 * ```
 */

export { serve, type ServeOptions, type ServeHandler } from './serve';
export {
  verifySignature,
  Receiver,
  SignatureVerificationError,
  type VerifySignatureConfig,
  type ExpressRequest,
  type ExpressResponse,
  type ExpressNext,
} from './middleware';
