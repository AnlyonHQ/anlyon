/**
 * Webhook Signature Verification (Legacy)
 *
 * This module provides the legacy `verifyWebhookSignature` function for
 * backward compatibility. For new implementations, consider using the
 * `Receiver` class instead.
 *
 * @example
 * ```typescript
 * // Legacy approach
 * import { verifyWebhookSignature } from '@anlyonhq/sdk';
 *
 * const result = verifyWebhookSignature(
 *   requestBody,
 *   request.headers['anlyon-signature'],
 *   webhookSecret
 * );
 *
 * // Recommended approach
 * import { Receiver } from '@anlyonhq/sdk';
 *
 * const receiver = new Receiver({ signingSecret: webhookSecret });
 * const isValid = receiver.verify({ signature, body });
 * ```
 */

import { Receiver, SignatureVerificationError } from './receiver';

/**
 * Verification result for webhook signature
 */
export interface WebhookVerificationResult {
  verified: boolean;
  error?: string;
  timestamp?: number;
}

/**
 * Verify webhook signature (legacy function)
 *
 * Verifies message delivery webhooks using the signature format:
 * `Anlyon-Signature: t=1234567890,v1=abc123...`
 *
 * This format includes timestamp validation to prevent replay attacks.
 * The signed payload is: `timestamp + "." + raw_body`
 *
 * @param payload - Raw request body as string
 * @param signatureHeader - Signature header value (format: "t=timestamp,v1=signature")
 * @param secret - Delivery secret configured for your workspace
 * @param toleranceSeconds - Maximum allowed time difference in seconds (default: 300 = 5 minutes)
 * @returns Verification result with `verified` boolean and optional error message
 *
 * @deprecated Use the `Receiver` class instead for a cleaner API
 *
 * @example
 * ```typescript
 * const result = verifyWebhookSignature(
 *   JSON.stringify(req.body),
 *   req.headers['anlyon-signature'],
 *   process.env.ANLYON_SIGNING_SECRET!,
 *   300 // 5 minutes tolerance
 * );
 *
 * if (!result.verified) {
 *   return res.status(401).json({ error: result.error });
 * }
 * ```
 */
export function verifyWebhookSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds: number = 300
): WebhookVerificationResult {
  if (!payload || !signatureHeader || !secret) {
    return {
      verified: false,
      error: 'Missing required parameters',
    };
  }

  const receiver = new Receiver({
    signingSecret: secret,
    clockTolerance: toleranceSeconds,
  });

  try {
    receiver.verifyOrThrow({
      signature: signatureHeader,
      body: payload,
    });

    const timestampMatch = signatureHeader.match(/t=(\d+)/);
    const timestamp = timestampMatch ? parseInt(timestampMatch[1], 10) : undefined;

    return {
      verified: true,
      timestamp,
    };
  } catch (error) {
    if (error instanceof SignatureVerificationError) {
      const timestampMatch = signatureHeader.match(/t=(\d+)/);
      const timestamp = timestampMatch ? parseInt(timestampMatch[1], 10) : undefined;

      return {
        verified: false,
        error: error.message,
        timestamp,
      };
    }

    return {
      verified: false,
      error: 'Unknown verification error',
    };
  }
}
