import crypto from "crypto";

export function parseSignatureHeader(header: string): {
  timestamp: number;
  signatures: string[];
} | null {
  const parts = header.split(",");
  let timestamp: number | undefined;
  const signatures: string[] = [];

  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key === "t") {
      timestamp = parseInt(value, 10);
    } else if (key === "v1") {
      signatures.push(value);
    }
  }

  if (timestamp === undefined || signatures.length === 0) {
    return null;
  }

  return { timestamp, signatures };
}

export function computeSignature(
  payload: string,
  timestamp: number,
  secret: string
): string {
  const signedPayload = `${timestamp}.${payload}`;
  return crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
}

export function verifySignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds: number = 300
): VerificationResult {
  const parsed = parseSignatureHeader(signatureHeader);

  if (!parsed) {
    return {
      verified: false,
      error: "Invalid signature header format",
    };
  }

  const { timestamp, signatures } = parsed;

  const now = Math.floor(Date.now() / 1000);
  const difference = Math.abs(now - timestamp);

  if (difference > toleranceSeconds) {
    return {
      verified: false,
      error: `Timestamp outside tolerance window (${difference}s > ${toleranceSeconds}s)`,
      timestamp,
    };
  }

  const expectedSignature = computeSignature(payload, timestamp, secret);

  for (const sig of signatures) {
    try {
      const isValid = crypto.timingSafeEqual(
        Buffer.from(sig, "hex"),
        Buffer.from(expectedSignature, "hex")
      );

      if (isValid) {
        return {
          verified: true,
          timestamp,
        };
      }
    } catch {
    }
  }

  return {
    verified: false,
    error: "Signature mismatch",
    timestamp,
  };
}

export interface VerificationResult {
  verified: boolean;
  error?: string;
  timestamp?: number;
}
