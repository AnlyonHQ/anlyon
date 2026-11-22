import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  generateDeliverySecret,
  encryptSecret,
  decryptSecret,
  signDeliveryPayload,
  verifyDeliverySignature,
  appendDeliverySignature,
  isLegacySecretEnvelope,
  masterKeyId,
} from './crypto';

const MASTER_KEY = 'test-master-key-for-unit-tests';
const SAMPLE_PAYLOAD = JSON.stringify({ event: 'message.delivered', id: 'msg_abc123' });

describe('generateDeliverySecret', () => {
  it('should return a secret that starts with whsec_', () => {
    const { secret } = generateDeliverySecret();
    expect(secret.startsWith('whsec_')).toBe(true);
  });

  it('should return a prefix that is the first 12 characters of the secret', () => {
    const { secret, prefix } = generateDeliverySecret();
    expect(prefix).toBe(secret.substring(0, 12));
  });

  it('should return a prefix that starts with whsec_', () => {
    const { prefix } = generateDeliverySecret();
    expect(prefix.startsWith('whsec_')).toBe(true);
  });

  it('should return a secret longer than the prefix', () => {
    const { secret, prefix } = generateDeliverySecret();
    expect(secret.length).toBeGreaterThan(prefix.length);
  });

  it('should generate unique secrets on each call', () => {
    const first = generateDeliverySecret();
    const second = generateDeliverySecret();
    expect(first.secret).not.toBe(second.secret);
  });
});

describe('encryptSecret and decryptSecret', () => {
  it('should decrypt back to the original secret with the same master key', () => {
    const { secret } = generateDeliverySecret();
    const encrypted = encryptSecret(secret, MASTER_KEY, { store: "vault", workspaceId: "ws_test" });
    const decrypted = decryptSecret(encrypted, MASTER_KEY, { store: "vault", workspaceId: "ws_test" });
    expect(decrypted).toBe(secret);
  });

  it('should encrypt to a different value than the original secret', () => {
    const { secret } = generateDeliverySecret();
    const encrypted = encryptSecret(secret, MASTER_KEY, { store: "vault", workspaceId: "ws_test" });
    expect(encrypted).not.toBe(secret);
  });

  it('should produce different ciphertext on each call due to random IV', () => {
    const { secret } = generateDeliverySecret();
    const firstEncrypted = encryptSecret(secret, MASTER_KEY, { store: "vault", workspaceId: "ws_test" });
    const secondEncrypted = encryptSecret(secret, MASTER_KEY, { store: "vault", workspaceId: "ws_test" });
    expect(firstEncrypted).not.toBe(secondEncrypted);
  });

  it('should throw when decrypting with a different master key', () => {
    const { secret } = generateDeliverySecret();
    const encrypted = encryptSecret(secret, MASTER_KEY, { store: "vault", workspaceId: "ws_test" });
    expect(() => decryptSecret(encrypted, 'wrong-master-key', { store: "vault", workspaceId: "ws_test" })).toThrow();
  });

  it('should roundtrip arbitrary UTF-8 string values', () => {
    const arbitrarySecret = 'some-plain-string-value-to-encrypt';
    const encrypted = encryptSecret(arbitrarySecret, MASTER_KEY, { store: "vault", workspaceId: "ws_test" });
    const decrypted = decryptSecret(encrypted, MASTER_KEY, { store: "vault", workspaceId: "ws_test" });
    expect(decrypted).toBe(arbitrarySecret);
  });
});

describe('signDeliveryPayload', () => {
  it('should return a string starting with t=', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const header = signDeliveryPayload(SAMPLE_PAYLOAD, 'whsec_testsecret', timestamp);
    expect(header.startsWith('t=')).toBe(true);
  });

  it('should include ,v1= in the returned header', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const header = signDeliveryPayload(SAMPLE_PAYLOAD, 'whsec_testsecret', timestamp);
    expect(header).toContain(',v1=');
  });

  it('should embed the provided timestamp in the header', () => {
    const timestamp = 1700000000;
    const header = signDeliveryPayload(SAMPLE_PAYLOAD, 'whsec_testsecret', timestamp);
    expect(header.startsWith(`t=${timestamp}`)).toBe(true);
  });

  it('should produce a deterministic signature for the same inputs', () => {
    const timestamp = 1700000000;
    const secret = 'whsec_deterministic';
    const first = signDeliveryPayload(SAMPLE_PAYLOAD, secret, timestamp);
    const second = signDeliveryPayload(SAMPLE_PAYLOAD, secret, timestamp);
    expect(first).toBe(second);
  });

  it('should produce a different signature when the payload changes', () => {
    const timestamp = 1700000000;
    const secret = 'whsec_deterministic';
    const original = signDeliveryPayload(SAMPLE_PAYLOAD, secret, timestamp);
    const tampered = signDeliveryPayload('{"event":"tampered"}', secret, timestamp);
    expect(original).not.toBe(tampered);
  });
});

describe('verifyDeliverySignature', () => {
  it('should return valid: true for a correctly signed payload', () => {
    const secret = 'whsec_testsecret';
    const timestamp = Math.floor(Date.now() / 1000);
    const header = signDeliveryPayload(SAMPLE_PAYLOAD, secret, timestamp);

    const result = verifyDeliverySignature(SAMPLE_PAYLOAD, header, secret);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return valid: false with an error when the timestamp is outside the tolerance window', () => {
    const secret = 'whsec_testsecret';
    const expiredTimestamp = Math.floor(Date.now() / 1000) - 400;
    const header = signDeliveryPayload(SAMPLE_PAYLOAD, secret, expiredTimestamp);

    const result = verifyDeliverySignature(SAMPLE_PAYLOAD, header, secret, 300);

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should return valid: false when the signature does not match the payload', () => {
    const secret = 'whsec_testsecret';
    const timestamp = Math.floor(Date.now() / 1000);
    const header = signDeliveryPayload(SAMPLE_PAYLOAD, secret, timestamp);

    const result = verifyDeliverySignature('{"event":"tampered"}', header, secret);

    expect(result.valid).toBe(false);
  });

  it('should return valid: false when the wrong secret is used for verification', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const header = signDeliveryPayload(SAMPLE_PAYLOAD, 'whsec_correct', timestamp);

    const result = verifyDeliverySignature(SAMPLE_PAYLOAD, header, 'whsec_wrong');

    expect(result.valid).toBe(false);
  });

  it('should return valid: false with an error for a malformed signature header', () => {
    const result = verifyDeliverySignature(SAMPLE_PAYLOAD, 'not-a-valid-header', 'whsec_testsecret');

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should return valid: false with an error when the t= part is missing', () => {
    const result = verifyDeliverySignature(SAMPLE_PAYLOAD, 'v1=abc123', 'whsec_testsecret');

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should return valid: false with an error when the v1= part is missing', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const result = verifyDeliverySignature(SAMPLE_PAYLOAD, `t=${timestamp}`, 'whsec_testsecret');

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("secret envelope (v2)", () => {
  const KEY = "a-master-key-that-is-at-least-32-chars";
  const vault = { store: "vault" as const, workspaceId: "ws_1" };

  it("writes a versioned, key-identified envelope", () => {
    const ct = encryptSecret("hunter2", KEY, vault);
    expect(ct.startsWith(`v3.${masterKeyId(KEY)}.`)).toBe(true);
    expect(decryptSecret(ct, KEY, vault)).toBe("hunter2");
  });

  it("publishes a key id that does not expose the encryption key", () => {
    const id = masterKeyId(KEY);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(masterKeyId(KEY + "x")).not.toBe(id);
  });

  it("still reads legacy v1 ciphertexts", () => {
    const legacyKey = crypto.createHash("sha256").update(KEY).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", legacyKey, iv);
    const enc = Buffer.concat([cipher.update("legacy", "utf8"), cipher.final()]);
    const legacy = Buffer.concat([iv, enc, cipher.getAuthTag()]).toString("base64");

    expect(isLegacySecretEnvelope(legacy)).toBe(true);
    expect(decryptSecret(legacy, KEY, vault)).toBe("legacy");
  });

  it("marks v2 ciphertexts as current so they are not needlessly rewritten", () => {
    expect(isLegacySecretEnvelope(encryptSecret("x", KEY, vault))).toBe(false);
  });

  it("refuses a ciphertext moved to a different store", () => {
    const ct = encryptSecret("hunter2", KEY, vault);
    expect(() =>
      decryptSecret(ct, KEY, { store: "delivery", workspaceId: "ws_1" })
    ).toThrow();
  });

  it("refuses a ciphertext moved to another workspace", () => {
    const ct = encryptSecret("hunter2", KEY, vault);
    expect(() => decryptSecret(ct, KEY, { store: "vault", workspaceId: "ws_2" })).toThrow();
  });

  it("rejects a ciphertext too short to hold an IV and tag", () => {
    expect(() => decryptSecret("YWJj", KEY, vault)).toThrow(/too short/i);
  });
});

describe("appendDeliverySignature", () => {
  it("carries both signatures under one timestamp during rotation", () => {
    const t = 1_700_000_000;
    const merged = appendDeliverySignature(
      signDeliveryPayload("{}", "secretA", t),
      signDeliveryPayload("{}", "secretB", t)
    );

    expect(merged.split("t=").length - 1).toBe(1);
    expect(merged.split("v1=").length - 1).toBe(2);
    expect(merged.startsWith(`t=${t},`)).toBe(true);
  });

  it("is a no-op when the other header carries no signature", () => {
    const base = signDeliveryPayload("{}", "secretA", 1);
    expect(appendDeliverySignature(base, "t=1")).toBe(base);
  });
});
