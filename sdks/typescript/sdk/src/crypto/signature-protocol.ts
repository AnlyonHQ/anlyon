export const SIGNATURE_HEX_PATTERN = /^[0-9a-f]{64}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^(0|[1-9][0-9]*)$/;
export const CANONICAL_ENVIRONMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface ParsedSignatureHeader {
  timestamp: number;
  signatures: string[];
  environmentIds: string[];
  environmentSignatures: string[];
}

/** Parse and validate the security-relevant fields in a delivery signature header. */
export function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  const timestamps: string[] = [];
  const signatures: string[] = [];
  const environmentIds: string[] = [];
  const environmentSignatures: string[] = [];

  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0 || separator !== part.lastIndexOf('=')) {
      return null;
    }

    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (key === 't') timestamps.push(value);
    else if (key === 'v1') signatures.push(value);
    else if (key === 'env') environmentIds.push(value);
    else if (key === 'v2') environmentSignatures.push(value);
  }

  if (
    timestamps.length !== 1 ||
    !CANONICAL_TIMESTAMP_PATTERN.test(timestamps[0]) ||
    signatures.some((value) => !SIGNATURE_HEX_PATTERN.test(value)) ||
    environmentSignatures.some((value) => !SIGNATURE_HEX_PATTERN.test(value)) ||
    environmentIds.some((value) => !CANONICAL_ENVIRONMENT_PATTERN.test(value))
  ) {
    return null;
  }

  const timestamp = Number(timestamps[0]);
  if (!Number.isSafeInteger(timestamp)) return null;

  return { timestamp, signatures, environmentIds, environmentSignatures };
}

export function legacySignedPayload(body: string, timestamp: number): string {
  return `${timestamp}.${body}`;
}

export function environmentSignedPayload(
  body: string,
  timestamp: number,
  environmentId: string
): string {
  return `anlyon-delivery-v2.${timestamp}.${environmentId}.${body}`;
}
