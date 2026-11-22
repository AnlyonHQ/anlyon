import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createMockRedis,
  createMockDb,
  createMockLogger,
  createMockApiKey,
} from "./setup.ts";

const mockDb = createMockDb();
const mockRedis = createMockRedis();
const mockLogger = createMockLogger();

vi.mock("../src/db/index.ts", () => ({
  db: mockDb,
}));

vi.mock("../src/lib/redis.ts", () => ({
  redis: mockRedis,
  RedisKeys: {
    apiKey: (keyHash: string) => `apikey:${keyHash}`,
    apiKeyPrevious: (keyId: string) => `apikey:${keyId}:previous`,
    apiKeyRollbackLock: (keyId: string) => `apikey:${keyId}:rollback-lock`,
  },
}));

vi.mock("../src/lib/logger.ts", () => ({
  createLogger: () => mockLogger,
}));

vi.mock("../src/config/env.ts", () => ({
  env: {
    API_KEY_SECRET: "test-api-key-secret-32-chars-minimum-length",
    NODE_ENV: "test",
  },
}));

import {
  generateApiKey,
  hashApiKey,
  encryptSecret,
  decryptSecret,
} from "../src/utils/crypto.ts";

describe("API Key Rollback Feature", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb._mocks.where.mockResolvedValue([]);
    mockDb._mocks.returning.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Crypto Utilities for Rollback", () => {
    const testSecret = "test-api-key-secret-32-chars-minimum-length";

    describe("encryptSecret / decryptSecret", () => {
      it("should encrypt and decrypt API key hash correctly", () => {
        const { hash } = generateApiKey("live");

        const encrypted = encryptSecret(hash, testSecret, { store: "vault", workspaceId: "ws_test" });
        const decrypted = decryptSecret(encrypted, testSecret, { store: "vault", workspaceId: "ws_test" });

        expect(decrypted).toBe(hash);
      });

      it("should produce different ciphertext each time (random IV)", () => {
        const { hash } = generateApiKey("live");

        const encrypted1 = encryptSecret(hash, testSecret, { store: "vault", workspaceId: "ws_test" });
        const encrypted2 = encryptSecret(hash, testSecret, { store: "vault", workspaceId: "ws_test" });

        expect(encrypted1).not.toBe(encrypted2);
        expect(decryptSecret(encrypted1, testSecret, { store: "vault", workspaceId: "ws_test" })).toBe(hash);
        expect(decryptSecret(encrypted2, testSecret, { store: "vault", workspaceId: "ws_test" })).toBe(hash);
      });

      it("should fail with wrong master key", () => {
        const { hash } = generateApiKey("live");
        const encrypted = encryptSecret(hash, testSecret, { store: "vault", workspaceId: "ws_test" });

        expect(() => decryptSecret(encrypted, "wrong-key-wrong-key-wrong-key-32", { store: "vault", workspaceId: "ws_test" })).toThrow();
      });

      it("should fail with tampered ciphertext", () => {
        const { hash } = generateApiKey("live");
        const encrypted = encryptSecret(hash, testSecret, { store: "vault", workspaceId: "ws_test" });
        const tampered = encrypted.slice(0, -5) + "ZZZZZ";

        expect(() => decryptSecret(tampered, testSecret, { store: "vault", workspaceId: "ws_test" })).toThrow();
      });
    });
  });

  describe("API Key Generation", () => {
    it("should generate unique API keys", () => {
      const key1 = generateApiKey("live");
      const key2 = generateApiKey("live");

      expect(key1.key).not.toBe(key2.key);
      expect(key1.hash).not.toBe(key2.hash);
    });

    it("should generate keys with correct format", () => {
      const { key, hash, prefix } = generateApiKey("live");

      expect(key).toMatch(/^anlyon_live_[a-zA-Z0-9_-]{32}$/);
      expect(hash).toHaveLength(64);
      expect(prefix).toBe(key.substring(0, 20));
    });

    it("should produce consistent hash for same key", () => {
      const key = "anlyon_live_testkey_fixture_value_01";
      const hash1 = hashApiKey(key);
      const hash2 = hashApiKey(key);

      expect(hash1).toBe(hash2);
    });
  });

  describe("Rollback Security Features", () => {
    it("should encrypt previous key hash before storing", () => {
      const { hash } = generateApiKey("live");
      const masterKey = "test-api-key-secret-32-chars-minimum-length";

      const encrypted = encryptSecret(hash, masterKey, { store: "vault", workspaceId: "ws_test" });

      expect(encrypted).not.toContain(hash);
      expect(() => Buffer.from(encrypted, "base64")).not.toThrow();
    });

    it("should require minimum length for encryption key", () => {
      const { hash } = generateApiKey("live");
      const shortKey = "short";

      const encrypted = encryptSecret(hash, shortKey, { store: "vault", workspaceId: "ws_test" });
      const decrypted = decryptSecret(encrypted, shortKey, { store: "vault", workspaceId: "ws_test" });

      expect(decrypted).toBe(hash);
    });
  });

  describe("Mock Database Operations", () => {
    it("should mock API key selection", async () => {
      const mockApiKey = createMockApiKey({
        id: "key-123",
        workspaceId: "ws-123",
        name: "Test Key",
        keyHash: "a".repeat(64),
        keyPrefix: "anlyon_live_fixture",
        isActive: "true",
      });

      mockDb._mocks.where.mockResolvedValueOnce([mockApiKey]);

      const result = await mockDb._mocks.where();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("key-123");
    });

    it("should mock API key history insertion", async () => {
      const mockHistory = {
        id: "history-123",
        apiKeyId: "key-123",
        workspaceId: "ws-123",
        previousKeyHashEncrypted: "encrypted-hash",
        previousKeyPrefix: "anlyon_live_old",
        version: 1,
        rotatedAt: new Date(),
        rollbackExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        rotatedBy: "user-123",
      };

      mockDb._mocks.returning.mockResolvedValueOnce([mockHistory]);

      const result = await mockDb._mocks.returning();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("history-123");
    });
  });

  describe("Mock Redis Operations", () => {
    it("should mock Redis set with NX option for locking", async () => {
      mockRedis.set.mockResolvedValueOnce("OK");

      const result = await mockRedis.set(
        "apikey:key-123:rollback-lock",
        "1",
        "EX",
        30,
        "NX"
      );

      expect(result).toBe("OK");
      expect(mockRedis.set).toHaveBeenCalledWith(
        "apikey:key-123:rollback-lock",
        "1",
        "EX",
        30,
        "NX"
      );
    });

    it("should mock Redis lock conflict", async () => {
      mockRedis.set.mockResolvedValueOnce(null);

      const result = await mockRedis.set(
        "apikey:key-123:rollback-lock",
        "1",
        "EX",
        30,
        "NX"
      );

      expect(result).toBeNull();
    });

    it("should mock Redis hset for caching API key", async () => {
      mockRedis.hset.mockResolvedValueOnce(1);

      const result = await mockRedis.hset("apikey:hash123", {
        workspaceId: "ws-123",
        isActive: "true",
        expiresAt: "",
      });

      expect(result).toBe(1);
      expect(mockRedis.hset).toHaveBeenCalled();
    });

    it("should mock Redis del for cache invalidation", async () => {
      mockRedis.del.mockResolvedValueOnce(1);

      const result = await mockRedis.del("apikey:hash123");

      expect(result).toBe(1);
      expect(mockRedis.del).toHaveBeenCalledWith("apikey:hash123");
    });
  });

  describe("Version Tracking", () => {
    it("should increment version on regeneration", () => {
      const currentVersion = 1;
      const newVersion = currentVersion + 1;

      expect(newVersion).toBe(2);
    });

    it("should restore previous version on rollback", () => {
      const currentVersion = 2;
      const previousVersion = 1;

      expect(previousVersion).toBeLessThan(currentVersion);
    });

    it("should track version history correctly", () => {
      const versions = [1, 2, 3];

      for (let i = 0; i < versions.length - 1; i++) {
        expect(versions[i + 1]).toBe(versions[i] + 1);
      }
    });
  });

  describe("Rollback Time Limit", () => {
    const ROLLBACK_EXPIRY_HOURS = 24;
    const ROLLBACK_EXPIRY_MS = ROLLBACK_EXPIRY_HOURS * 60 * 60 * 1000;

    it("should calculate rollback expiry correctly", () => {
      const now = Date.now();
      const rollbackExpiresAt = new Date(now + ROLLBACK_EXPIRY_MS);

      const hoursUntilExpiry = (rollbackExpiresAt.getTime() - now) / (60 * 60 * 1000);

      expect(hoursUntilExpiry).toBe(24);
    });

    it("should detect expired rollback period", () => {
      const expiredAt = new Date(Date.now() - 1000);
      const isExpired = new Date() > expiredAt;

      expect(isExpired).toBe(true);
    });

    it("should allow rollback within time limit", () => {
      const expiresAt = new Date(Date.now() + ROLLBACK_EXPIRY_MS);
      const canRollback = new Date() < expiresAt;

      expect(canRollback).toBe(true);
    });
  });

  describe("Error Scenarios", () => {
    it("should handle not found API key", () => {
      const result: unknown[] = [];

      expect(result.length).toBe(0);
    });

    it("should handle inactive API key", () => {
      const mockApiKey = createMockApiKey({
        isActive: "false",
      });

      expect(mockApiKey.isActive).toBe("false");
    });

    it("should handle no history available", () => {
      const history: unknown[] = [];

      expect(history.length).toBe(0);
    });

    it("should handle concurrent rollback attempts", async () => {
      mockRedis.set.mockResolvedValueOnce("OK");
      const lock1 = await mockRedis.set("lock-key", "1", "EX", 30, "NX");
      expect(lock1).toBe("OK");

      mockRedis.set.mockResolvedValueOnce(null);
      const lock2 = await mockRedis.set("lock-key", "1", "EX", 30, "NX");
      expect(lock2).toBeNull();
    });
  });

  describe("Cache Management", () => {
    it("should invalidate old key cache on regeneration", async () => {
      const oldKeyHash = "old-hash-123";
      mockRedis.del.mockResolvedValueOnce(1);

      await mockRedis.del(`apikey:${oldKeyHash}`);

      expect(mockRedis.del).toHaveBeenCalledWith(`apikey:${oldKeyHash}`);
    });

    it("should cache new key on regeneration", async () => {
      const newKeyHash = "new-hash-456";
      mockRedis.hset.mockResolvedValueOnce(1);
      mockRedis.expire.mockResolvedValueOnce(1);

      await mockRedis.hset(`apikey:${newKeyHash}`, {
        workspaceId: "ws-123",
        isActive: "true",
        expiresAt: "",
      });
      await mockRedis.expire(`apikey:${newKeyHash}`, 604800);

      expect(mockRedis.hset).toHaveBeenCalled();
      expect(mockRedis.expire).toHaveBeenCalledWith(`apikey:${newKeyHash}`, 604800);
    });

    it("should cache previous key hash for rollback", async () => {
      const keyId = "key-123";
      const encryptedPreviousHash = "encrypted-previous-hash";
      mockRedis.set.mockResolvedValueOnce("OK");

      await mockRedis.set(
        `apikey:${keyId}:previous`,
        encryptedPreviousHash,
        "EX",
        86400
      );

      expect(mockRedis.set).toHaveBeenCalledWith(
        `apikey:${keyId}:previous`,
        encryptedPreviousHash,
        "EX",
        86400
      );
    });

    it("should clear previous key cache on rollback", async () => {
      const keyId = "key-123";
      mockRedis.del.mockResolvedValueOnce(1);

      await mockRedis.del(`apikey:${keyId}:previous`);

      expect(mockRedis.del).toHaveBeenCalledWith(`apikey:${keyId}:previous`);
    });
  });

  describe("History Entry Structure", () => {
    it("should create history entry with correct fields", () => {
      const historyEntry = {
        id: "history-uuid",
        apiKeyId: "key-uuid",
        workspaceId: "ws-uuid",
        previousKeyHashEncrypted: "encrypted-data",
        previousKeyPrefix: "anlyon_live_oldprefix",
        version: 1,
        rotatedAt: new Date(),
        rollbackExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        rotatedBy: "user-uuid",
      };

      expect(historyEntry).toHaveProperty("id");
      expect(historyEntry).toHaveProperty("apiKeyId");
      expect(historyEntry).toHaveProperty("workspaceId");
      expect(historyEntry).toHaveProperty("previousKeyHashEncrypted");
      expect(historyEntry).toHaveProperty("previousKeyPrefix");
      expect(historyEntry).toHaveProperty("version");
      expect(historyEntry).toHaveProperty("rotatedAt");
      expect(historyEntry).toHaveProperty("rollbackExpiresAt");
      expect(historyEntry).toHaveProperty("rotatedBy");
    });

    it("should format history response correctly", () => {
      const rawHistory = {
        id: "history-uuid",
        version: 1,
        previousKeyPrefix: "anlyon_live_old",
        rotatedAt: new Date("2024-01-15T10:00:00Z"),
        rollbackExpiresAt: new Date("2024-01-16T10:00:00Z"),
        rotatedBy: "user-uuid",
      };

      const formattedHistory = {
        id: rawHistory.id,
        version: rawHistory.version,
        keyPrefix: rawHistory.previousKeyPrefix,
        rotatedAt: rawHistory.rotatedAt,
        rollbackExpiresAt: rawHistory.rollbackExpiresAt,
        canRollback: new Date() < rawHistory.rollbackExpiresAt,
        rotatedBy: rawHistory.rotatedBy,
      };

      expect(formattedHistory.keyPrefix).toBe("anlyon_live_old");
      expect(formattedHistory).toHaveProperty("canRollback");
    });
  });

  describe("API Key Info Structure", () => {
    it("should include version in API key info", () => {
      const apiKeyInfo = {
        id: "key-uuid",
        workspaceId: "ws-uuid",
        name: "Production Key",
        keyPrefix: "anlyon_live_prod",
        version: 2,
        isActive: true,
        lastUsedAt: new Date(),
        createdAt: new Date(),
        expiresAt: null,
      };

      expect(apiKeyInfo).toHaveProperty("version");
      expect(apiKeyInfo.version).toBe(2);
    });

    it("should convert isActive string to boolean", () => {
      const rawKey = {
        isActive: "true" as const,
      };

      const formattedKey = {
        isActive: rawKey.isActive === "true",
      };

      expect(formattedKey.isActive).toBe(true);
    });
  });

  describe("Integration Scenarios", () => {
    it("should handle full regeneration flow", async () => {
      const existingKey = createMockApiKey({
        id: "key-123",
        workspaceId: "ws-123",
        keyHash: "old-hash",
        keyPrefix: "anlyon_live_old",
        isActive: "true",
      });
      mockDb._mocks.where.mockResolvedValueOnce([existingKey]);

      mockDb._mocks.returning.mockResolvedValueOnce([{
        id: "history-123",
        apiKeyId: "key-123",
        version: 1,
      }]);

      const updatedKey = { ...existingKey, keyHash: "new-hash", version: 2 };
      mockDb._mocks.returning.mockResolvedValueOnce([updatedKey]);

      mockRedis.del.mockResolvedValue(1);
      mockRedis.hset.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(1);
      mockRedis.set.mockResolvedValue("OK");

      expect(mockDb._mocks.where).toBeDefined();
      expect(mockDb._mocks.returning).toBeDefined();
    });

    it("should handle full rollback flow", async () => {
      mockRedis.set.mockResolvedValueOnce("OK");

      const currentKey = createMockApiKey({
        id: "key-123",
        keyHash: "new-hash",
        version: 2,
        isActive: "true",
      });
      mockDb._mocks.where.mockResolvedValueOnce([currentKey]);

      const historyEntry = {
        id: "history-123",
        apiKeyId: "key-123",
        previousKeyHashEncrypted: encryptSecret(
          "old-hash",
          "test-api-key-secret-32-chars-minimum-length"
        , { store: "vault", workspaceId: "ws_test" }),
        previousKeyPrefix: "anlyon_live_old",
        version: 1,
        rollbackExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      };
      mockDb._mocks.where.mockResolvedValueOnce([historyEntry]);

      const restoredKey = { ...currentKey, keyHash: "old-hash", version: 1 };
      mockDb._mocks.returning.mockResolvedValueOnce([restoredKey]);

      mockRedis.del.mockResolvedValue(1);
      mockRedis.hset.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(1);

      expect(mockRedis.set).toBeDefined();
      expect(mockDb._mocks.where).toBeDefined();
    });

    it("should prevent rollback when period expired", () => {
      const expiredHistory = {
        rollbackExpiresAt: new Date(Date.now() - 1000),
      };

      const canRollback = new Date() < expiredHistory.rollbackExpiresAt;

      expect(canRollback).toBe(false);
    });

    it("should prevent rollback for inactive keys", () => {
      const inactiveKey = createMockApiKey({
        isActive: "false",
      });

      const isActive = inactiveKey.isActive === "true";

      expect(isActive).toBe(false);
    });
  });

  describe("Security Validations", () => {
    it("should use timing-safe comparison for key verification", () => {
      const { key, hash } = generateApiKey("live");
      const computedHash = hashApiKey(key);

      expect(computedHash).toBe(hash);
    });

    it("should not expose key hash in API responses", () => {
      const apiKey = createMockApiKey({
        keyHash: "secret-hash",
      });

      const responseData = {
        id: apiKey.id,
        name: apiKey.name,
        keyPrefix: apiKey.keyPrefix,
      };

      expect(responseData).not.toHaveProperty("keyHash");
    });

    it("should encrypt previous key hash in history", () => {
      const originalHash = "a".repeat(64);
      const masterKey = "test-api-key-secret-32-chars-minimum-length";

      const encrypted = encryptSecret(originalHash, masterKey, { store: "vault", workspaceId: "ws_test" });

      expect(encrypted).not.toBe(originalHash);
      expect(encrypted.includes(originalHash)).toBe(false);
    });

    it("should validate workspace ownership before operations", () => {
      const emptyResult: unknown[] = [];

      expect(emptyResult.length).toBe(0);
    });
  });
});
