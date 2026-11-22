/**
 * Receiver - Webhook Signature Verification
 *
 * The Receiver class provides a simple interface for verifying
 * webhook signatures sent by Anlyon Scheduler.
 *
 * @example
 * ```typescript
 * import { Receiver } from '@anlyonhq/sdk'
 *
 * const receiver = new Receiver({
 *   signingSecret: process.env.ANLYON_SIGNING_SECRET!,
 * })
 *
 * const isValid = receiver.verify({
 *   signature: req.headers.get('anlyon-signature'),
 *   body: rawBody,
 * })
 * ```
 */

import { createHmac, timingSafeEqual } from 'crypto';
import {
  CANONICAL_ENVIRONMENT_PATTERN,
  environmentSignedPayload,
  legacySignedPayload,
  parseSignatureHeader,
} from './crypto/signature-protocol';

/**
 * Configuration for the Receiver
 */
export interface ReceiverConfig {
  /**
   * The signing secret used to verify webhook signatures.
   * Can be found in your Anlyon dashboard.
   */
  signingSecret: string;

  /**
   * Maximum allowed time difference in seconds between the signature
   * timestamp and current time. Helps prevent replay attacks.
   * @default 300 (5 minutes)
   */
  clockTolerance?: number;

  /** Require a v2 signature bound to this environment identifier. */
  expectedEnvironmentId?: string;
}

/**
 * Request data for signature verification
 */
export interface VerifyRequest {
  /**
   * The signature header value (format: "t=timestamp,v1=signature")
   */
  signature: string | null;

  /**
   * The raw request body as a string
   */
  body: string;
}

/**
 * Error thrown when signature verification fails
 */
export class SignatureVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureVerificationError';
  }
}

/**
 * Compute the expected signature for a webhook payload
 */
function computeSignature(
  payload: string,
  timestamp: number,
  secret: string
): string {
  return createHmac('sha256', secret)
    .update(legacySignedPayload(payload, timestamp))
    .digest('hex');
}

function computeEnvironmentSignature(
  payload: string,
  timestamp: number,
  environmentId: string,
  secret: string
): string {
  return createHmac('sha256', secret)
    .update(environmentSignedPayload(payload, timestamp, environmentId))
    .digest('hex');
}

function matchesAnySignature(signatures: string[], expected: string): boolean {
  const expectedBytes = Buffer.from(expected, 'hex');
  return signatures.some((signature) =>
    timingSafeEqual(Buffer.from(signature, 'hex'), expectedBytes)
  );
}

/**
 * Receiver for verifying Anlyon webhook signatures
 *
 * Provides methods to verify that incoming webhook requests are authentic
 * and haven't been tampered with.
 *
 * @example
 * ```typescript
 * import { Receiver } from '@anlyonhq/sdk'
 *
 * const receiver = new Receiver({
 *   signingSecret: process.env.ANLYON_SIGNING_SECRET!,
 * })
 *
 * // Boolean check
 * if (receiver.verify({ signature, body })) {
 *   // Process verified request
 * }
 *
 * // Or throw on failure
 * receiver.verifyOrThrow({ signature, body })
 * ```
 */
export class Receiver {
  private readonly signingSecret: string;
  private readonly clockTolerance: number;
  private readonly expectedEnvironmentId?: string;

  constructor(config: ReceiverConfig) {
    if (!config.signingSecret) {
      throw new Error('signingSecret is required');
    }
    if (
      config.expectedEnvironmentId !== undefined &&
      !CANONICAL_ENVIRONMENT_PATTERN.test(config.expectedEnvironmentId)
    ) {
      throw new Error('expectedEnvironmentId must be a canonical environment identifier');
    }
    this.signingSecret = config.signingSecret;
    this.clockTolerance = config.clockTolerance ?? 300;
    this.expectedEnvironmentId = config.expectedEnvironmentId;
  }

  /**
   * Verify a webhook signature
   *
   * @param request - The verification request containing signature and body
   * @returns true if the signature is valid, false otherwise
   *
   * @example
   * ```typescript
   * const isValid = receiver.verify({
   *   signature: req.headers.get('anlyon-signature'),
   *   body: await req.text(),
   * })
   *
   * if (!isValid) {
   *   return new Response('Unauthorized', { status: 401 })
   * }
   * ```
   */
  verify(request: VerifyRequest): boolean {
    const { signature, body } = request;

    if (!signature || typeof body !== 'string') {
      return false;
    }

    const parsed = parseSignatureHeader(signature);
    if (!parsed) {
      return false;
    }

    const { timestamp, signatures, environmentIds, environmentSignatures } = parsed;

    const now = Math.floor(Date.now() / 1000);
    const difference = Math.abs(now - timestamp);

    if (difference > this.clockTolerance) {
      return false;
    }

    if (this.expectedEnvironmentId !== undefined) {
      if (
        environmentIds.length !== 1 ||
        environmentIds[0] !== this.expectedEnvironmentId ||
        environmentSignatures.length === 0
      ) return false;

      return matchesAnySignature(
        environmentSignatures,
        computeEnvironmentSignature(body, timestamp, this.expectedEnvironmentId, this.signingSecret)
      );
    }

    if (signatures.length === 0) return false;
    const expectedSignature = computeSignature(body, timestamp, this.signingSecret);
    return matchesAnySignature(signatures, expectedSignature);
  }

  /**
   * Verify a webhook signature, throwing an error on failure
   *
   * @param request - The verification request containing signature and body
   * @throws SignatureVerificationError if verification fails
   *
   * @example
   * ```typescript
   * try {
   *   receiver.verifyOrThrow({
   *     signature: req.headers.get('anlyon-signature'),
   *     body: await req.text(),
   *   })
   *   // Signature is valid, process request
   * } catch (error) {
   *   if (error instanceof SignatureVerificationError) {
   *     return new Response('Unauthorized', { status: 401 })
   *   }
   *   throw error
   * }
   * ```
   */
  verifyOrThrow(request: VerifyRequest): void {
    const { signature, body } = request;

    if (!signature) {
      throw new SignatureVerificationError('Missing signature header');
    }

    if (typeof body !== 'string') {
      throw new SignatureVerificationError('Missing request body');
    }

    const parsed = parseSignatureHeader(signature);
    if (!parsed) {
      throw new SignatureVerificationError('Invalid signature header format');
    }

    const { timestamp, signatures, environmentIds, environmentSignatures } = parsed;

    const now = Math.floor(Date.now() / 1000);
    const difference = Math.abs(now - timestamp);

    if (difference > this.clockTolerance) {
      throw new SignatureVerificationError(
        `Timestamp outside tolerance window (${difference}s > ${this.clockTolerance}s)`
      );
    }

    if (this.expectedEnvironmentId !== undefined) {
      if (environmentIds.length === 0 || environmentSignatures.length === 0) {
        throw new SignatureVerificationError('Missing signed environment attribution');
      }
      if (environmentIds.length !== 1 || environmentIds[0] !== this.expectedEnvironmentId) {
        throw new SignatureVerificationError('Delivery environment mismatch');
      }
      if (matchesAnySignature(
        environmentSignatures,
        computeEnvironmentSignature(body, timestamp, this.expectedEnvironmentId, this.signingSecret)
      )) return;
      throw new SignatureVerificationError('Environment signature mismatch');
    }

    if (signatures.length === 0) {
      throw new SignatureVerificationError('Missing v1 signature');
    }
    const expectedSignature = computeSignature(body, timestamp, this.signingSecret);
    if (matchesAnySignature(signatures, expectedSignature)) return;
    throw new SignatureVerificationError('Signature mismatch');
  }
}
