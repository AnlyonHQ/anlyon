import { describe, it, expect } from 'vitest';
import {
  parseSignatureHeader,
  computeSignature,
  verifySignature,
} from './verification';

const SAMPLE_SECRET = 'whsec_testsecretforverification';
const SAMPLE_PAYLOAD = JSON.stringify({ event: 'message.delivered', id: 'msg_abc123' });

describe('parseSignatureHeader', () => {
  it('should parse a valid header and return timestamp and signatures', () => {
    const timestamp = 1700000000;
    const signature = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    const header = `t=${timestamp},v1=${signature}`;

    const result = parseSignatureHeader(header);

    expect(result).not.toBeNull();
    expect(result!.timestamp).toBe(timestamp);
    expect(result!.signatures).toContain(signature);
  });

  it('should return null when the t= part is missing', () => {
    const result = parseSignatureHeader('v1=abc123');
    expect(result).toBeNull();
  });

  it('should return null when the v1= part is missing', () => {
    const result = parseSignatureHeader('t=1700000000');
    expect(result).toBeNull();
  });

  it('should return null when the header has no = separator at all', () => {
    const result = parseSignatureHeader('malformedheader');
    expect(result).toBeNull();
  });

  it('should return null for an empty string', () => {
    const result = parseSignatureHeader('');
    expect(result).toBeNull();
  });

  it('should collect multiple v1 signatures when present', () => {
    const sigOne = 'a'.repeat(64);
    const sigTwo = 'b'.repeat(64);
    const header = `t=1700000000,v1=${sigOne},v1=${sigTwo}`;

    const result = parseSignatureHeader(header);

    expect(result).not.toBeNull();
    expect(result!.signatures).toHaveLength(2);
    expect(result!.signatures).toContain(sigOne);
    expect(result!.signatures).toContain(sigTwo);
  });
});

describe('computeSignature', () => {
  it('should return the same signature for identical inputs', () => {
    const timestamp = 1700000000;
    const first = computeSignature(SAMPLE_PAYLOAD, timestamp, SAMPLE_SECRET);
    const second = computeSignature(SAMPLE_PAYLOAD, timestamp, SAMPLE_SECRET);
    expect(first).toBe(second);
  });

  it('should return a different signature when the payload changes', () => {
    const timestamp = 1700000000;
    const original = computeSignature(SAMPLE_PAYLOAD, timestamp, SAMPLE_SECRET);
    const tampered = computeSignature('{"event":"tampered"}', timestamp, SAMPLE_SECRET);
    expect(original).not.toBe(tampered);
  });

  it('should return a different signature when the timestamp changes', () => {
    const first = computeSignature(SAMPLE_PAYLOAD, 1700000000, SAMPLE_SECRET);
    const second = computeSignature(SAMPLE_PAYLOAD, 1700000001, SAMPLE_SECRET);
    expect(first).not.toBe(second);
  });

  it('should return a different signature when the secret changes', () => {
    const timestamp = 1700000000;
    const first = computeSignature(SAMPLE_PAYLOAD, timestamp, 'whsec_secretone');
    const second = computeSignature(SAMPLE_PAYLOAD, timestamp, 'whsec_secrettwo');
    expect(first).not.toBe(second);
  });

  it('should return a lowercase hex string', () => {
    const signature = computeSignature(SAMPLE_PAYLOAD, 1700000000, SAMPLE_SECRET);
    expect(signature).toMatch(/^[0-9a-f]+$/);
  });
});

describe('verifySignature', () => {
  it('should return verified: true for a correctly signed payload', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = computeSignature(SAMPLE_PAYLOAD, timestamp, SAMPLE_SECRET);
    const header = `t=${timestamp},v1=${signature}`;

    const result = verifySignature(SAMPLE_PAYLOAD, header, SAMPLE_SECRET);

    expect(result.verified).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return the timestamp in the result for a valid signature', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = computeSignature(SAMPLE_PAYLOAD, timestamp, SAMPLE_SECRET);
    const header = `t=${timestamp},v1=${signature}`;

    const result = verifySignature(SAMPLE_PAYLOAD, header, SAMPLE_SECRET);

    expect(result.timestamp).toBe(timestamp);
  });

  it('should return verified: false when the timestamp is outside the tolerance window', () => {
    const expiredTimestamp = Math.floor(Date.now() / 1000) - 400;
    const signature = computeSignature(SAMPLE_PAYLOAD, expiredTimestamp, SAMPLE_SECRET);
    const header = `t=${expiredTimestamp},v1=${signature}`;

    const result = verifySignature(SAMPLE_PAYLOAD, header, SAMPLE_SECRET, 300);

    expect(result.verified).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should include the timestamp in the result even when the timestamp is expired', () => {
    const expiredTimestamp = Math.floor(Date.now() / 1000) - 400;
    const signature = computeSignature(SAMPLE_PAYLOAD, expiredTimestamp, SAMPLE_SECRET);
    const header = `t=${expiredTimestamp},v1=${signature}`;

    const result = verifySignature(SAMPLE_PAYLOAD, header, SAMPLE_SECRET, 300);

    expect(result.timestamp).toBe(expiredTimestamp);
  });

  it('should return verified: false when the payload has been tampered with', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = computeSignature(SAMPLE_PAYLOAD, timestamp, SAMPLE_SECRET);
    const header = `t=${timestamp},v1=${signature}`;

    const result = verifySignature('{"event":"tampered"}', header, SAMPLE_SECRET);

    expect(result.verified).toBe(false);
  });

  it('should return verified: false when the wrong secret is used', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = computeSignature(SAMPLE_PAYLOAD, timestamp, SAMPLE_SECRET);
    const header = `t=${timestamp},v1=${signature}`;

    const result = verifySignature(SAMPLE_PAYLOAD, header, 'whsec_wrong_secret');

    expect(result.verified).toBe(false);
  });

  it('should return verified: false with an error for a completely malformed header', () => {
    const result = verifySignature(SAMPLE_PAYLOAD, 'not-a-valid-header', SAMPLE_SECRET);

    expect(result.verified).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should return verified: false with an error when the header is an empty string', () => {
    const result = verifySignature(SAMPLE_PAYLOAD, '', SAMPLE_SECRET);

    expect(result.verified).toBe(false);
    expect(result.error).toBeDefined();
  });
});
