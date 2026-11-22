import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateApiKey,
  hashApiKey,
  verifyApiKey,
  hashPassword,
  verifyPassword,
  generateVerificationToken,
  generateMessageId,
  generateEffectId,
  generatePreviewId,
  generateLimitId,
  generateContentHash,
  signWebhook,
  verifyWebhookSignature,
  generateDeliverySecret,
  encryptSecret,
  decryptSecret,
  signDeliveryPayload,
  verifyDeliverySignature,
} from "../src/utils/crypto.ts";

describe("Crypto Utilities", () => {
  describe("generateApiKey", () => {
    it("should generate a live API key with correct format", () => {
      const { key, hash, prefix } = generateApiKey("live");

      expect(key).toMatch(/^anlyon_live_[a-zA-Z0-9_-]{32}$/);
      expect(hash).toHaveLength(64);
      expect(prefix).toBe(key.substring(0, 20));
    });

    it("should generate a test API key with correct format", () => {
      const { key, hash, prefix } = generateApiKey("test");

      expect(key).toMatch(/^anlyon_test_[a-zA-Z0-9_-]{32}$/);
      expect(hash).toHaveLength(64);
      expect(prefix).toBe(key.substring(0, 20));
    });

    it("should generate unique keys", () => {
      const key1 = generateApiKey("live");
      const key2 = generateApiKey("live");

      expect(key1.key).not.toBe(key2.key);
      expect(key1.hash).not.toBe(key2.hash);
    });

    it("should default to live mode", () => {
      const { key } = generateApiKey();

      expect(key).toMatch(/^anlyon_live_/);
    });
  });

  describe("hashApiKey", () => {
    it("should produce consistent hash for same input", () => {
      const key = "anlyon_live_fixture";
      const hash1 = hashApiKey(key);
      const hash2 = hashApiKey(key);

      expect(hash1).toBe(hash2);
    });

    it("should produce different hashes for different inputs", () => {
      const hash1 = hashApiKey("anlyon_live_abc123");
      const hash2 = hashApiKey("anlyon_live_xyz789");

      expect(hash1).not.toBe(hash2);
    });

    it("should return 64 character hex string", () => {
      const hash = hashApiKey("test");

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });
  });

  describe("verifyApiKey", () => {
    it("should verify valid API key", () => {
      const { key, hash } = generateApiKey("live");
      const isValid = verifyApiKey(key, hash);

      expect(isValid).toBe(true);
    });

    it("should reject invalid API key", () => {
      const { hash } = generateApiKey("live");
      const isValid = verifyApiKey("wrong_key", hash);

      expect(isValid).toBe(false);
    });

    it("should reject tampered hash", () => {
      const { key } = generateApiKey("live");
      const tamperedHash = "a".repeat(64);
      const isValid = verifyApiKey(key, tamperedHash);

      expect(isValid).toBe(false);
    });

    it("should use timing-safe comparison", () => {
      const { key, hash } = generateApiKey("live");

      const validResult = verifyApiKey(key, hash);
      const invalidResult = verifyApiKey("wrong", hash);

      expect(validResult).toBe(true);
      expect(invalidResult).toBe(false);
    });
  });

  describe("hashPassword / verifyPassword", () => {
    it("should hash and verify password correctly", async () => {
      const password = "MySecurePassword123!";
      const hash = await hashPassword(password);

      expect(hash).not.toBe(password);
      expect(await verifyPassword(password, hash)).toBe(true);
    });

    it("should reject wrong password", async () => {
      const password = "MySecurePassword123!";
      const hash = await hashPassword(password);

      expect(await verifyPassword("WrongPassword", hash)).toBe(false);
    });

    it("should generate different hashes for same password (salt)", async () => {
      const password = "SamePassword";
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);

      expect(hash1).not.toBe(hash2);
      expect(await verifyPassword(password, hash1)).toBe(true);
      expect(await verifyPassword(password, hash2)).toBe(true);
    });

    it("should handle empty password", async () => {
      const hash = await hashPassword("");
      expect(await verifyPassword("", hash)).toBe(true);
      expect(await verifyPassword("notEmpty", hash)).toBe(false);
    });

    it("should handle special characters", async () => {
      const password = "P@$$w0rd!@#$%^&*()_+{}|:<>?";
      const hash = await hashPassword(password);

      expect(await verifyPassword(password, hash)).toBe(true);
    });

    it("should handle unicode characters", async () => {
      const password = "密码🔐パスワード";
      const hash = await hashPassword(password);

      expect(await verifyPassword(password, hash)).toBe(true);
    });
  });

  describe("generateVerificationToken", () => {
    it("should generate 32 character token", () => {
      const token = generateVerificationToken();

      expect(token).toHaveLength(32);
    });

    it("should generate unique tokens", () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 100; i++) {
        tokens.add(generateVerificationToken());
      }

      expect(tokens.size).toBe(100);
    });
  });

  describe("ID generators", () => {
    describe("generateMessageId", () => {
      it("should generate message ID with correct prefix", () => {
        const id = generateMessageId();

        expect(id).toMatch(/^msg_[a-zA-Z0-9_-]{21}$/);
      });

      it("should generate unique IDs", () => {
        const ids = new Set<string>();
        for (let i = 0; i < 100; i++) {
          ids.add(generateMessageId());
        }

        expect(ids.size).toBe(100);
      });
    });

    describe("governed-effect ids", () => {
      it("generate effect, preview and limit ids with their public prefixes", () => {
        expect(generateEffectId()).toMatch(/^eff_[a-zA-Z0-9_-]{21}$/);
        expect(generatePreviewId()).toMatch(/^prv_[a-zA-Z0-9_-]{21}$/);
        expect(generateLimitId()).toMatch(/^lim_[a-zA-Z0-9_-]{21}$/);
      });
    });
  });

  describe("generateContentHash", () => {
    it("should generate consistent hash for same content", () => {
      const content = { url: "https://example.com", body: { data: 123 } };
      const hash1 = generateContentHash(content);
      const hash2 = generateContentHash(content);

      expect(hash1).toBe(hash2);
    });

    it("should generate different hash for different content", () => {
      const hash1 = generateContentHash({ url: "https://example1.com" });
      const hash2 = generateContentHash({ url: "https://example2.com" });

      expect(hash1).not.toBe(hash2);
    });

    it("should produce consistent hash regardless of key order", () => {
      const hash1 = generateContentHash({ a: 1, b: 2 });
      const hash2 = generateContentHash({ b: 2, a: 1 });

      expect(hash1).toBe(hash2);
    });

    it("should return 64 character hex string", () => {
      const hash = generateContentHash({ test: "data" });

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });
  });

  describe("signWebhook / verifyWebhookSignature", () => {
    const secret = "webhook_secret_123";
    const payload = '{"event":"test"}';

    it("should sign and verify payload correctly", () => {
      const signature = signWebhook(payload, secret);
      const isValid = verifyWebhookSignature(payload, signature, secret);

      expect(isValid).toBe(true);
    });

    it("should reject invalid signature", () => {
      const isValid = verifyWebhookSignature(payload, "invalid_signature", secret);

      expect(isValid).toBe(false);
    });

    it("should reject tampered payload", () => {
      const signature = signWebhook(payload, secret);
      const isValid = verifyWebhookSignature('{"event":"tampered"}', signature, secret);

      expect(isValid).toBe(false);
    });

    it("should reject wrong secret", () => {
      const signature = signWebhook(payload, secret);
      const isValid = verifyWebhookSignature(payload, signature, "wrong_secret");

      expect(isValid).toBe(false);
    });

    it("should handle empty payload", () => {
      const signature = signWebhook("", secret);
      const isValid = verifyWebhookSignature("", signature, secret);

      expect(isValid).toBe(true);
    });

    it("should produce 64 character hex signature", () => {
      const signature = signWebhook(payload, secret);

      expect(signature).toHaveLength(64);
      expect(signature).toMatch(/^[a-f0-9]+$/);
    });
  });

  describe("generateDeliverySecret", () => {
    it("should generate secret with whsec_ prefix", () => {
      const { secret, prefix } = generateDeliverySecret();

      expect(secret).toMatch(/^whsec_[a-zA-Z0-9_-]+$/);
      expect(prefix).toBe(secret.substring(0, 12));
    });

    it("should generate unique secrets", () => {
      const secrets = new Set<string>();
      for (let i = 0; i < 100; i++) {
        secrets.add(generateDeliverySecret().secret);
      }

      expect(secrets.size).toBe(100);
    });

    it("should generate sufficiently long secret", () => {
      const { secret } = generateDeliverySecret();

      expect(secret.length).toBeGreaterThanOrEqual(40);
    });
  });

  describe("encryptSecret / decryptSecret", () => {
    const masterKey = "super_secret_master_key_123";
    const secret = "whsec_fixture";

    it("should encrypt and decrypt secret correctly", () => {
      const encrypted = encryptSecret(secret, masterKey, { store: "vault", workspaceId: "ws_test" });
      const decrypted = decryptSecret(encrypted, masterKey, { store: "vault", workspaceId: "ws_test" });

      expect(decrypted).toBe(secret);
    });

    it("should produce different ciphertext each time (random IV)", () => {
      const encrypted1 = encryptSecret(secret, masterKey, { store: "vault", workspaceId: "ws_test" });
      const encrypted2 = encryptSecret(secret, masterKey, { store: "vault", workspaceId: "ws_test" });

      expect(encrypted1).not.toBe(encrypted2);
      expect(decryptSecret(encrypted1, masterKey, { store: "vault", workspaceId: "ws_test" })).toBe(secret);
      expect(decryptSecret(encrypted2, masterKey, { store: "vault", workspaceId: "ws_test" })).toBe(secret);
    });

    it("should fail with wrong master key", () => {
      const encrypted = encryptSecret(secret, masterKey, { store: "vault", workspaceId: "ws_test" });

      expect(() => decryptSecret(encrypted, "wrong_key", { store: "vault", workspaceId: "ws_test" })).toThrow();
    });

    it("should fail with tampered ciphertext", () => {
      const encrypted = encryptSecret(secret, masterKey, { store: "vault", workspaceId: "ws_test" });
      const tampered = encrypted.slice(0, -5) + "ZZZZZ";

      expect(() => decryptSecret(tampered, masterKey, { store: "vault", workspaceId: "ws_test" })).toThrow();
    });

    it("should handle empty secret", () => {
      const encrypted = encryptSecret("", masterKey, { store: "vault", workspaceId: "ws_test" });
      const decrypted = decryptSecret(encrypted, masterKey, { store: "vault", workspaceId: "ws_test" });

      expect(decrypted).toBe("");
    });

    it("should handle long secrets", () => {
      const longSecret = "a".repeat(10000);
      const encrypted = encryptSecret(longSecret, masterKey, { store: "vault", workspaceId: "ws_test" });
      const decrypted = decryptSecret(encrypted, masterKey, { store: "vault", workspaceId: "ws_test" });

      expect(decrypted).toBe(longSecret);
    });

    it("should handle special characters", () => {
      const specialSecret = "whsec_!@#$%^&*()_+{}|:<>?密码🔐";
      const encrypted = encryptSecret(specialSecret, masterKey, { store: "vault", workspaceId: "ws_test" });
      const decrypted = decryptSecret(encrypted, masterKey, { store: "vault", workspaceId: "ws_test" });

      expect(decrypted).toBe(specialSecret);
    });
  });

  describe("signDeliveryPayload", () => {
    const secret = "whsec_abc123";
    const payload = '{"event":"test"}';
    const timestamp = 1704067200;

    it("should produce signature in Stripe format", () => {
      const signature = signDeliveryPayload(payload, secret, timestamp);

      expect(signature).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
      expect(signature).toContain(`t=${timestamp}`);
    });

    it("should produce consistent signatures for same inputs", () => {
      const sig1 = signDeliveryPayload(payload, secret, timestamp);
      const sig2 = signDeliveryPayload(payload, secret, timestamp);

      expect(sig1).toBe(sig2);
    });

    it("should produce different signatures for different timestamps", () => {
      const sig1 = signDeliveryPayload(payload, secret, timestamp);
      const sig2 = signDeliveryPayload(payload, secret, timestamp + 1);

      expect(sig1).not.toBe(sig2);
    });

    it("should produce different signatures for different payloads", () => {
      const sig1 = signDeliveryPayload(payload, secret, timestamp);
      const sig2 = signDeliveryPayload('{"event":"other"}', secret, timestamp);

      expect(sig1).not.toBe(sig2);
    });
  });

  describe("verifyDeliverySignature", () => {
    const secret = "whsec_abc123";
    const payload = '{"event":"test"}';

    it("should verify valid signature", () => {
      const now = Math.floor(Date.now() / 1000);
      const signature = signDeliveryPayload(payload, secret, now);
      const result = verifyDeliverySignature(payload, signature, secret);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should reject invalid signature format - missing t=", () => {
      const result = verifyDeliverySignature(payload, "v1=abc123", secret);

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid signature format");
    });

    it("should reject invalid signature format - missing v1=", () => {
      const result = verifyDeliverySignature(payload, "t=123456", secret);

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid signature format");
    });

    it("should reject invalid timestamp", () => {
      const result = verifyDeliverySignature(payload, "t=abc,v1=def", secret);

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid timestamp");
    });

    it("should reject expired timestamp (too old)", () => {
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600;
      const signature = signDeliveryPayload(payload, secret, oldTimestamp);
      const result = verifyDeliverySignature(payload, signature, secret, 300);

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Timestamp outside tolerance window");
    });

    it("should reject future timestamp (too far ahead)", () => {
      const futureTimestamp = Math.floor(Date.now() / 1000) + 600;
      const signature = signDeliveryPayload(payload, secret, futureTimestamp);
      const result = verifyDeliverySignature(payload, signature, secret, 300);

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Timestamp outside tolerance window");
    });

    it("should reject wrong signature", () => {
      const now = Math.floor(Date.now() / 1000);
      const wrongSig = `t=${now},v1=${"a".repeat(64)}`;
      const result = verifyDeliverySignature(payload, wrongSig, secret);

      expect(result.valid).toBe(false);
    });

    it("should reject tampered payload", () => {
      const now = Math.floor(Date.now() / 1000);
      const signature = signDeliveryPayload(payload, secret, now);
      const result = verifyDeliverySignature('{"event":"tampered"}', signature, secret);

      expect(result.valid).toBe(false);
    });

    it("should accept signature within custom tolerance", () => {
      const timestamp = Math.floor(Date.now() / 1000) - 100;
      const signature = signDeliveryPayload(payload, secret, timestamp);

      const result = verifyDeliverySignature(payload, signature, secret, 300);

      expect(result.valid).toBe(true);
    });

    it("should handle signature mismatch length", () => {
      const now = Math.floor(Date.now() / 1000);
      const shortSig = `t=${now},v1=abc`;
      const result = verifyDeliverySignature(payload, shortSig, secret);

      expect(result.valid).toBe(false);
    });
  });
});

describe("master-key rotation (SECRET_RETIRED_MASTER_KEYS)", () => {
  const OLD = "old-master-key-0000000000000000000000";
  const NEW = "new-master-key-1111111111111111111111";
  const ctx = { store: "vault" as const, workspaceId: "ws-1", environmentId: "env-1", name: "STRIPE" };
  const saved = process.env.SECRET_RETIRED_MASTER_KEYS;
  afterEach(() => {
    if (saved === undefined) delete process.env.SECRET_RETIRED_MASTER_KEYS;
    else process.env.SECRET_RETIRED_MASTER_KEYS = saved;
  });

  it("a value written under the old key is unreadable under the new one until the old key is listed as retired", async () => {
    const { encryptSecret, decryptSecret } = await import("../src/utils/crypto.ts");
    const sealed = encryptSecret("sk_live_value", OLD, ctx);
    delete process.env.SECRET_RETIRED_MASTER_KEYS;
    expect(() => decryptSecret(sealed, NEW, ctx)).toThrow();
    process.env.SECRET_RETIRED_MASTER_KEYS = `some-other-retired-key-2222222222222222, ${OLD}`;
    expect(decryptSecret(sealed, NEW, ctx)).toBe("sk_live_value");
    expect(() => decryptSecret(sealed, NEW, { ...ctx, workspaceId: "ws-2" })).toThrow();
  });

  it("new values are always written under the current key, never a retired one", async () => {
    const { encryptSecret, decryptSecret, masterKeyId, isUnderAnotherMasterKey } = await import("../src/utils/crypto.ts");
    process.env.SECRET_RETIRED_MASTER_KEYS = OLD;
    const sealed = encryptSecret("value", NEW, ctx);
    expect(sealed.split(".")[1]).toBe(masterKeyId(NEW));
    expect(isUnderAnotherMasterKey(sealed, NEW)).toBe(false);
    delete process.env.SECRET_RETIRED_MASTER_KEYS;
    expect(decryptSecret(sealed, NEW, ctx)).toBe("value");
  });

  it("the re-encryption step rewrites a retired-key value under the current key, after which the retired key is not needed", async () => {
    const { encryptSecret, decryptSecret, upgradeSecretEnvelope, masterKeyId } = await import("../src/utils/crypto.ts");
    const sealed = encryptSecret("value", OLD, ctx);
    process.env.SECRET_RETIRED_MASTER_KEYS = OLD;
    const result = upgradeSecretEnvelope(sealed, NEW, ctx);
    expect(result).toMatchObject({ version: "v3", readable: true, retiredKey: true });
    expect(result.upgraded!.split(".")[1]).toBe(masterKeyId(NEW));
    delete process.env.SECRET_RETIRED_MASTER_KEYS;
    expect(decryptSecret(result.upgraded!, NEW, ctx)).toBe("value");
    expect(upgradeSecretEnvelope(result.upgraded!, NEW, ctx)).toMatchObject({ readable: true, upgraded: null, retiredKey: false });
  });

  it("without the retired key listed, the re-encryption step reports the value unreadable and rewrites nothing", async () => {
    const { encryptSecret, upgradeSecretEnvelope } = await import("../src/utils/crypto.ts");
    delete process.env.SECRET_RETIRED_MASTER_KEYS;
    expect(upgradeSecretEnvelope(encryptSecret("value", OLD, ctx), NEW, ctx)).toMatchObject({ readable: false, upgraded: null });
  });

  it("ignores a listed key too short to be a master key", async () => {
    const { encryptSecret, decryptSecret } = await import("../src/utils/crypto.ts");
    const sealed = encryptSecret("value", OLD, ctx);
    process.env.SECRET_RETIRED_MASTER_KEYS = "short";
    expect(() => decryptSecret(sealed, NEW, ctx)).toThrow();
  });
});
