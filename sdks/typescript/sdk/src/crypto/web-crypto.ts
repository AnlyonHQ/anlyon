/**
 * Web Crypto API based signature verification
 *
 * This module provides signature verification using the Web Crypto API,
 * which is available in edge runtimes like Cloudflare Workers, Deno Deploy,
 * Vercel Edge Functions, and modern browsers.
 *
 * @packageDocumentation
 * @module @anlyonhq/sdk/crypto
 */

import {
  CANONICAL_ENVIRONMENT_PATTERN,
  environmentSignedPayload,
  legacySignedPayload,
  parseSignatureHeader,
} from './signature-protocol';

/**
 * Convert Uint8Array to hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compute HMAC-SHA256 signature using Web Crypto API
 */
export async function computeSignatureAsync(
  payload: string,
  timestamp: number,
  secret: string,
  environmentId?: string
): Promise<string> {
  const encoder = new TextEncoder();
  const signedPayload = environmentId === undefined
    ? legacySignedPayload(payload, timestamp)
    : environmentSignedPayload(payload, timestamp, environmentId);

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(signedPayload)
  );

  return bytesToHex(new Uint8Array(signature));
}

/**
 * Timing-safe comparison using Web Crypto API
 * Uses constant-time comparison to prevent timing attacks
 */
export async function timingSafeEqualAsync(
  a: string,
  b: string
): Promise<boolean> {
  if (a.length !== b.length) {
    return false;
  }

  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }

  return result === 0;
}

export { parseSignatureHeader } from './signature-protocol';

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
 * Configuration for the WebCryptoReceiver
 */
export interface WebCryptoReceiverConfig {
  /**
   * The signing secret used to verify webhook signatures.
   */
  signingSecret: string;

  /**
   * Maximum allowed time difference in seconds between the signature
   * timestamp and current time.
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
 * Web Crypto based Receiver for edge runtimes
 *
 * This receiver uses the Web Crypto API instead of Node.js crypto,
 * making it compatible with Cloudflare Workers, Deno Deploy, and other
 * edge environments.
 *
 * @example
 * ```typescript
 * import { WebCryptoReceiver } from '@anlyonhq/sdk/hono'
 *
 * const receiver = new WebCryptoReceiver({
 *   signingSecret: process.env.ANLYON_SIGNING_SECRET!,
 * })
 *
 * const isValid = await receiver.verify({
 *   signature: request.headers.get('anlyon-signature'),
 *   body: await request.text(),
 * })
 * ```
 */
export class WebCryptoReceiver {
  private readonly signingSecret: string;
  private readonly clockTolerance: number;
  private readonly expectedEnvironmentId?: string;

  constructor(config: WebCryptoReceiverConfig) {
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
   * Verify a webhook signature asynchronously
   *
   * @param request - The verification request containing signature and body
   * @returns Promise resolving to true if valid, false otherwise
   */
  async verify(request: VerifyRequest): Promise<boolean> {
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

      const expected = await computeSignatureAsync(
        body,
        timestamp,
        this.signingSecret,
        this.expectedEnvironmentId
      );
      for (const signatureValue of environmentSignatures) {
        if (await timingSafeEqualAsync(signatureValue, expected)) return true;
      }
      return false;
    }

    if (signatures.length === 0) return false;
    const expectedSignature = await computeSignatureAsync(
      body,
      timestamp,
      this.signingSecret
    );

    for (const sig of signatures) {
      const isValid = await timingSafeEqualAsync(sig, expectedSignature);
      if (isValid) {
        return true;
      }
    }

    return false;
  }

  /**
   * Verify a webhook signature, throwing an error on failure
   *
   * @param request - The verification request containing signature and body
   * @throws SignatureVerificationError if verification fails
   */
  async verifyOrThrow(request: VerifyRequest): Promise<void> {
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
      const expected = await computeSignatureAsync(
        body,
        timestamp,
        this.signingSecret,
        this.expectedEnvironmentId
      );
      for (const signatureValue of environmentSignatures) {
        if (await timingSafeEqualAsync(signatureValue, expected)) return;
      }
      throw new SignatureVerificationError('Environment signature mismatch');
    }

    if (signatures.length === 0) {
      throw new SignatureVerificationError('Missing v1 signature');
    }
    const expectedSignature = await computeSignatureAsync(
      body,
      timestamp,
      this.signingSecret
    );

    for (const sig of signatures) {
      const isValid = await timingSafeEqualAsync(sig, expectedSignature);
      if (isValid) {
        return;
      }
    }

    throw new SignatureVerificationError('Signature mismatch');
  }
}
