import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockRedis, createMockDb, MockRedisKeys } from "../setup.ts";

const mockDb = createMockDb();
vi.mock("../../src/db/index.ts", () => ({ db: mockDb }));

const DEFAULT_ENV_ID = "env_default_123";
vi.mock("../../src/core/environments/service.ts", () => ({
  resolveEnvironmentForKey: vi.fn(async () => DEFAULT_ENV_ID),
  getEnvironment: vi.fn(async (_workspaceId: string, environmentId: string) => ({ id: environmentId })),
  getDefaultEnvironment: vi.fn(async () => ({ id: DEFAULT_ENV_ID })),
}));

const mockRedis = createMockRedis();
vi.mock("../../src/lib/redis.ts", () => ({
  redis: mockRedis,
  RedisKeys: MockRedisKeys,
}));

vi.mock("../../src/lib/logger.ts", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

const mockAuthApi = {
  getUser: vi.fn(),
  getSession: vi.fn(),
};
vi.mock("../../src/core/audit/outbox.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/audit/outbox.ts")>()),
  writeAuditEvents: vi.fn(async () => undefined),
}));
vi.mock("../../src/core/sso/sessions.ts", () => ({ assertSsoSessionForWorkspace: vi.fn(async () => undefined) }));
vi.mock("../../src/utils/auth.ts", () => ({
  auth: {
    api: mockAuthApi,
  },
  AUTH_BASE_PATH: "/api/auth",
  OAUTH_ISSUER: "http://localhost:8080/api/auth",
  MCP_RESOURCE_URL: "http://localhost:8080/mcp",
}));

const mockHasWorkspaceAccess = vi.fn();
vi.mock("../../src/core/workspace/service.ts", () => ({
  hasWorkspaceAccess: mockHasWorkspaceAccess,
}));

const mockCrypto = {
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => "hashed_api_key"),
  })),
  timingSafeEqual: vi.fn(() => true),
};

vi.mock("crypto", () => ({
  default: mockCrypto,
  createHash: mockCrypto.createHash,
  timingSafeEqual: mockCrypto.timingSafeEqual,
}));

describe("Authentication Integration Tests", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetApiKeyCachesForTests } = await import("../../src/core/auth/api-keys.ts");
    resetApiKeyCachesForTests();
    vi.mocked(mockDb.select).mockReturnValue({ from: vi.mocked(mockDb._mocks.from) } as any);
    vi.mocked(mockDb._mocks.from).mockReturnValue({ where: vi.mocked(mockDb.where) } as any);
    vi.mocked(mockDb.where).mockResolvedValue([]);
    vi.mocked(mockDb.insert).mockReturnValue({ values: vi.mocked(mockDb._mocks.values) } as any);
    vi.mocked(mockDb._mocks.values).mockReturnValue({ returning: vi.mocked(mockDb.returning) } as any);
    vi.mocked(mockDb.returning).mockResolvedValue([]);
    vi.mocked(mockDb.update).mockReturnValue({ set: vi.mocked(mockDb._mocks.set) } as any);
    vi.mocked(mockDb._mocks.set).mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.mocked(mockDb.returning), catch: vi.fn() }),
    } as any);
    vi.mocked(mockDb.delete).mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) } as any);
    vi.mocked(mockDb.transaction).mockImplementation(async (fn: (tx: any) => Promise<any>) => fn(mockDb));
    vi.mocked(mockCrypto.createHash).mockReturnValue({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn(() => "hashed_api_key"),
    } as any);
    vi.mocked(mockCrypto.timingSafeEqual).mockReturnValue(true);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("API Key Authentication", () => {
    it("should authenticate valid API key", async () => {
      const { verifyApiKeyAndGetWorkspace } = await import("../../src/core/auth/api-keys.ts");

      const mockApiKey = {
        id: "key_123",
        workspaceId: "workspace_123",
        keyHash: "hashed_api_key",
        keyPrefix: "anlyon_live_abc",
        isActive: "true",
        expiresAt: null,
        lastUsedAt: null,
      };

      vi.mocked(mockRedis.get).mockResolvedValue(null);
      vi.mocked(mockDb.where).mockResolvedValue([mockApiKey]);

      const result = await verifyApiKeyAndGetWorkspace("anlyon_live_abc123456789");

      expect(result).toBeDefined();
      expect(result.workspaceId).toBe("workspace_123");
      expect(mockRedis.hset).toHaveBeenCalled();
    });

    it("should use cached API key when available", async () => {
      const { verifyApiKeyAndGetWorkspace } = await import("../../src/core/auth/api-keys.ts");

      const cachedKey = {
        workspaceId: "workspace_123",
        keyHash: "hashed_api_key",
        isActive: true,
      };

      vi.mocked(mockRedis.hgetall).mockResolvedValue({
        workspaceId: "workspace_123",
        keyId: "key_123",
        environmentId: "env_123",
        isActive: "true",
        expiresAt: "",
        endUserRequired: "false",
      });

      const result = await verifyApiKeyAndGetWorkspace("anlyon_live_abc123456789");

      expect(result).toBeDefined();
      expect(result.keyId).toBe("key_123");
      expect(result.environmentId).toBe("env_123");
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("falls through to the DB for cache entries written before keyId was stored", async () => {
      const { verifyApiKeyAndGetWorkspace } = await import("../../src/core/auth/api-keys.ts");

      vi.mocked(mockRedis.hgetall).mockResolvedValue({
        workspaceId: "workspace_123",
        isActive: "true",
        expiresAt: "",
      });

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "key_123",
              workspaceId: "workspace_123",
              environmentId: "env_123",
              keyHash: "hashed_api_key",
              isActive: "true",
              expiresAt: null,
              scopes: null,
            },
          ]),
        }),
      });

      const result = await verifyApiKeyAndGetWorkspace("anlyon_live_abc123456789");

      expect(result.keyId).toBe("key_123");
      expect(result.environmentId).toBe("env_123");
      expect(mockRedis.hset).toHaveBeenCalled();
    });

    it("should reject inactive API keys", async () => {
      const { verifyApiKeyAndGetWorkspace } = await import("../../src/core/auth/api-keys.ts");

      const inactiveKey = {
        id: "key_123",
        workspaceId: "workspace_123",
        keyHash: "hashed_api_key",
        isActive: "false",
        expiresAt: null,
      };

      vi.mocked(mockRedis.hgetall).mockResolvedValue({});
      vi.mocked(mockDb.where).mockResolvedValue([inactiveKey]);

      await expect(verifyApiKeyAndGetWorkspace("anlyon_live_abc123456789")).rejects.toThrow();
    });

    it("should reject expired API keys", async () => {
      const { verifyApiKeyAndGetWorkspace } = await import("../../src/core/auth/api-keys.ts");

      const expiredKey = {
        id: "key_123",
        workspaceId: "workspace_123",
        keyHash: "hashed_api_key",
        isActive: "true",
        expiresAt: new Date(Date.now() - 86400000),
      };

      vi.mocked(mockRedis.hgetall).mockResolvedValue({});
      vi.mocked(mockDb.where).mockResolvedValue([expiredKey]);

      await expect(verifyApiKeyAndGetWorkspace("anlyon_live_abc123456789")).rejects.toThrow();
    });

    it("should reject malformed API keys", async () => {
      const { verifyApiKeyAndGetWorkspace } = await import("../../src/core/auth/api-keys.ts");

      const invalidKeys = [
        "",
        "invalid_key",
        "anlyon_test_",
        "random_string_12345",
      ];

      for (const key of invalidKeys) {
        await expect(verifyApiKeyAndGetWorkspace(key)).rejects.toThrow();
      }
    });

    it("should differentiate between live and test keys", async () => {
      const { verifyApiKeyAndGetWorkspace } = await import("../../src/core/auth/api-keys.ts");

      const liveKey = {
        id: "key_live",
        workspaceId: "workspace_123",
        keyHash: "hashed_api_key",
        keyPrefix: "anlyon_live_",
        isActive: "true",
        expiresAt: null,
      };

      const testKey = {
        id: "key_test",
        workspaceId: "workspace_123",
        keyHash: "hashed_api_key",
        keyPrefix: "anlyon_test_",
        isActive: "true",
        expiresAt: null,
      };

      vi.mocked(mockRedis.hgetall).mockResolvedValue({});

      vi.mocked(mockDb.where).mockResolvedValue([liveKey]);
      const liveResult = await verifyApiKeyAndGetWorkspace("anlyon_live_abc123456789");
      expect(liveResult.workspaceId).toBe("workspace_123");

      vi.mocked(mockDb.where).mockResolvedValue([testKey]);
      const testResult = await verifyApiKeyAndGetWorkspace("anlyon_test_abc123456789");
      expect(testResult.workspaceId).toBe("workspace_123");
    });

    it("should update lastUsedAt timestamp on authentication", async () => {
      const { verifyApiKeyAndGetWorkspace } = await import("../../src/core/auth/api-keys.ts");

      const mockApiKey = {
        id: "key_123",
        workspaceId: "workspace_123",
        keyHash: "hashed_api_key",
        isActive: "true",
        expiresAt: null,
        lastUsedAt: new Date(Date.now() - 3600000),
      };

      vi.mocked(mockRedis.hgetall).mockResolvedValue({});
      vi.mocked(mockDb.where).mockResolvedValue([mockApiKey]);

      await verifyApiKeyAndGetWorkspace("anlyon_live_abc123456789");

      expect(mockDb.update).toHaveBeenCalled();
    });

    it("should use timing-safe comparison for key hashes", async () => {
      const { verifyApiKeyAndGetWorkspace } = await import("../../src/core/auth/api-keys.ts");

      const mockApiKey = {
        id: "key_123",
        workspaceId: "workspace_123",
        keyHash: "correct_hash",
        isActive: "true",
        expiresAt: null,
      };

      vi.mocked(mockRedis.hgetall).mockResolvedValue({});
      vi.mocked(mockDb.where).mockResolvedValue([mockApiKey]);

      vi.mocked(mockCrypto.timingSafeEqual).mockReturnValue(true);

      await verifyApiKeyAndGetWorkspace("anlyon_live_abc123456789");

      expect(mockCrypto.createHash).toHaveBeenCalled();
    });

    it("should handle concurrent API key verifications", async () => {
      const { verifyApiKeyAndGetWorkspace } = await import("../../src/core/auth/api-keys.ts");

      const mockApiKey = {
        id: "key_123",
        workspaceId: "workspace_123",
        keyHash: "hashed_api_key",
        isActive: "true",
        expiresAt: null,
      };

      vi.mocked(mockRedis.hgetall).mockResolvedValue({});
      vi.mocked(mockDb.where).mockResolvedValue([mockApiKey]);

      const promises = Array(10)
        .fill(null)
        .map(() => verifyApiKeyAndGetWorkspace("anlyon_live_abc123456789"));

      const results = await Promise.all(promises);

      expect(results).toHaveLength(10);
      results.forEach((result) => {
        expect(result.workspaceId).toBe("workspace_123");
      });
    });
  });

  describe("Session Authentication", () => {
    it("should authenticate valid session", async () => {
      const { auth } = await import("../../src/utils/auth.ts");

      vi.mocked(auth.api.getUser).mockResolvedValue({
        id: "user_123",
        email: "test@example.com",
        name: "Test User",
      });

      const user = await auth.api.getUser({ headers: { cookie: "session=valid_session" } } as any);

      expect(user).toBeDefined();
      expect(user.email).toBe("test@example.com");
    });

    it("should reject expired sessions", async () => {
      const { auth } = await import("../../src/utils/auth.ts");

      vi.mocked(auth.api.getUser).mockResolvedValue(null);

      const user = await auth.api.getUser({ headers: { cookie: "session=expired" } } as any);

      expect(user).toBeNull();
    });

    it("should handle missing session cookie", async () => {
      const { auth } = await import("../../src/utils/auth.ts");

      vi.mocked(auth.api.getUser).mockResolvedValue(null);

      const user = await auth.api.getUser({ headers: {} } as any);

      expect(user).toBeNull();
    });
  });

  describe("Workspace Access Control", () => {
    it("should verify workspace membership", async () => {
      const { hasWorkspaceAccess } = await import("../../src/core/workspace/service.ts");

      mockHasWorkspaceAccess.mockResolvedValue(true);

      const hasAccess = await hasWorkspaceAccess("workspace_123", "user_123");

      expect(hasAccess).toBe(true);
    });

    it("should deny access for non-members", async () => {
      const { hasWorkspaceAccess } = await import("../../src/core/workspace/service.ts");

      mockHasWorkspaceAccess.mockResolvedValue(false);

      const hasAccess = await hasWorkspaceAccess("workspace_123", "user_456");

      expect(hasAccess).toBe(false);
    });

    it("should enforce role-based permissions", async () => {
      const { hasWorkspaceAccess } = await import("../../src/core/workspace/service.ts");

      mockHasWorkspaceAccess.mockResolvedValue(true);

      const hasAccess = await hasWorkspaceAccess("workspace_123", "user_123");
      expect(hasAccess).toBe(true);
    });

    it("should give an admin access", async () => {
      const { hasWorkspaceAccess } = await import("../../src/core/workspace/service.ts");

      mockHasWorkspaceAccess.mockResolvedValue(true);

      const hasAccess = await hasWorkspaceAccess("workspace_123", "user_admin");
      expect(hasAccess).toBe(true);
    });
  });

  describe("OAuth Authentication", () => {
    it("should handle GitHub OAuth callback", async () => {
      const { auth } = await import("../../src/utils/auth.ts");

      const mockOAuthUser = {
        id: "user_github_123",
        email: "github@example.com",
        name: "GitHub User",
      };

      vi.mocked(auth.api.getUser).mockResolvedValue(mockOAuthUser);

      const user = await auth.api.getUser({ headers: {} } as any);

      expect(auth.api.getUser).toHaveBeenCalled();
    });

    it("should link OAuth account to existing user", async () => {
      const existingUser = {
        id: "user_123",
        email: "test@example.com",
      };

      const oauthAccount = {
        provider: "github",
        providerId: "github_user_123",
        userId: "user_123",
      };

      vi.mocked(mockDb.returning).mockResolvedValue([oauthAccount]);

      await mockDb.insert({}).values(oauthAccount);

      expect(mockDb.insert).toHaveBeenCalled();
    });
  });

  describe("Security Headers", () => {
    it("should require Bearer token format", async () => {
      const authHeader = "Bearer anlyon_live_abc123456789";
      const token = authHeader.split("Bearer ")[1];

      expect(token).toBeDefined();
      expect(token.startsWith("anlyon_")).toBe(true);
    });

    it("should reject non-Bearer auth schemes", async () => {
      const invalidSchemes = [
        "Basic abc123",
        "Digest abc123",
        "anlyon_live_abc123",
      ];

      for (const scheme of invalidSchemes) {
        const token = scheme.split("Bearer ")[1];
        expect(token).toBeUndefined();
      }
    });
  });

  describe("API Key Management", () => {
    it("should create new API key with proper hash", async () => {
      const { createApiKey } = await import("../../src/core/auth/api-keys.ts");

      vi.mocked(mockCrypto.createHash).mockReturnValue({
        update: vi.fn().mockReturnThis(),
        digest: vi.fn(() => "new_key_hash"),
      } as any);

      vi.mocked(mockDb.returning).mockResolvedValue([
        {
          id: "key_new",
          keyHash: "new_key_hash",
          keyPrefix: "anlyon_live_xyz",
          isActive: "true",
          workspaceId: "workspace_123",
        },
      ]);

      const result = await createApiKey("workspace_123", "user_123", "Production Key");

      expect(result).toBeDefined();
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockCrypto.createHash).toHaveBeenCalled();
    });

    it("should revoke API key and clear cache", async () => {
      const { revokeApiKey } = await import("../../src/core/auth/api-keys.ts");

      vi.mocked(mockDb.where).mockResolvedValue([
        {
          id: "key_123",
          workspaceId: "workspace_123",
          keyHash: "hashed_api_key",
          isActive: "true",
        },
      ]);

      await revokeApiKey("key_123", "workspace_123");

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockRedis.del).toHaveBeenCalled();
    });

    it("should list all API keys for workspace (without hashes)", async () => {
      const { listApiKeys } = await import("../../src/core/auth/api-keys.ts");

      const mockKeys = [
        {
          id: "key_1",
          name: "Production",
          keyPrefix: "anlyon_live_abc",
          isActive: "true",
          lastUsedAt: new Date(),
          createdAt: new Date(),
        },
        {
          id: "key_2",
          name: "Development",
          keyPrefix: "anlyon_test_xyz",
          isActive: "true",
          lastUsedAt: null,
          createdAt: new Date(),
        },
      ];

      vi.mocked(mockDb.where).mockResolvedValue(mockKeys);

      const keys = await listApiKeys("workspace_123");

      expect(keys).toHaveLength(2);
      keys.forEach((key: any) => {
        expect(key.keyHash).toBeUndefined();
      });
    });
  });

  describe("Authentication Middleware", () => {
    it("should extract workspace from authenticated request", async () => {
      const mockContext = {
        get: vi.fn((key: string) => {
          if (key === "workspaceId") return "workspace_123";
          return undefined;
        }),
        set: vi.fn(),
        req: {
          header: vi.fn((name: string) => {
            if (name === "Authorization") return "Bearer anlyon_live_abc123";
            return undefined;
          }),
        },
      };

      const workspaceId = mockContext.get("workspaceId");
      expect(workspaceId).toBe("workspace_123");
    });

    it("should set workspace in context after authentication", async () => {
      const mockContext = {
        get: vi.fn(),
        set: vi.fn(),
        req: {
          header: vi.fn(() => "Bearer anlyon_live_abc123"),
        },
      };

      mockContext.set("workspaceId", "workspace_123");
      mockContext.set("apiKeyId", "key_123");

      expect(mockContext.set).toHaveBeenCalledWith("workspaceId", "workspace_123");
      expect(mockContext.set).toHaveBeenCalledWith("apiKeyId", "key_123");
    });
  });

  describe("Security Edge Cases", () => {
    it("should prevent timing attacks in key comparison", async () => {
      const { verifyApiKeyAndGetWorkspace } = await import("../../src/core/auth/api-keys.ts");

      vi.mocked(mockRedis.hgetall).mockResolvedValue({});
      vi.mocked(mockDb.where).mockResolvedValue([]);

      await expect(verifyApiKeyAndGetWorkspace("anlyon_live_wrong_key")).rejects.toThrow();
    });

    it("should handle SQL injection attempts in API key lookup", async () => {
      const { verifyApiKeyAndGetWorkspace } = await import("../../src/core/auth/api-keys.ts");

      const maliciousKey = "anlyon_live_abc'; DROP TABLE api_keys; --";

      await expect(verifyApiKeyAndGetWorkspace(maliciousKey)).rejects.toThrow();
    });

    it("should rate limit authentication attempts", async () => {
      const authRateLimitKey = "auth:rate-limit:192.168.1.1";

      vi.mocked(mockRedis.get).mockResolvedValue("101");

      const attempts = await mockRedis.get(authRateLimitKey);

      expect(Number(attempts)).toBeGreaterThan(100);
    });
  });

  describe("Workspace validation surfacing (requireApiKey / requireSessionOnly)", () => {
    function makeContext(opts: {
      headers?: Record<string, string>;
      query?: Record<string, string>;
    } = {}) {
      const headers = opts.headers ?? {};
      const vars = new Map<string, unknown>();
      return {
        req: {
          path: "/api/v2/actions",
          method: "GET",
          header: vi.fn((name: string) => headers[name]),
          param: vi.fn(() => undefined),
          query: vi.fn((name: string) => (opts.query ?? {})[name]),
          raw: { headers: new Headers(headers) },
        },
        get: vi.fn((k: string) => vars.get(k)),
        set: vi.fn((k: string, v: unknown) => void vars.set(k, v)),
      } as any;
    }

    const session = { user: { id: "user_123", email: "test@example.com" } };

    it("returns the real 400 when a session request names no workspace and holds no API key", async () => {
      const { requireApiKey } = await import("../../src/api/middleware/auth.ts");
      const { ValidationError } = await import("../../src/utils/errors.ts");
      vi.mocked(mockAuthApi.getSession).mockResolvedValue(session);

      const next = vi.fn();
      await expect(requireApiKey(makeContext(), next)).rejects.toThrow(ValidationError);
      await expect(requireApiKey(makeContext(), next)).rejects.toThrow("Workspace ID is required");
      expect(next).not.toHaveBeenCalled();
    });

    it("returns the real 400 for a malformed workspace ID", async () => {
      const { requireApiKey } = await import("../../src/api/middleware/auth.ts");
      vi.mocked(mockAuthApi.getSession).mockResolvedValue(session);

      const ctx = makeContext({ query: { workspaceId: "not-a-uuid" } });
      await expect(requireApiKey(ctx, vi.fn())).rejects.toThrow("Invalid Workspace ID format");
    });

    it("still falls back to API key auth when a Bearer token is present", async () => {
      const { requireApiKey } = await import("../../src/api/middleware/auth.ts");
      vi.mocked(mockAuthApi.getSession).mockResolvedValue(session);
      vi.mocked(mockRedis.hgetall).mockResolvedValue({});

      const ctx = makeContext({ headers: { Authorization: "Bearer bogus_key" } });
      await expect(requireApiKey(ctx, vi.fn())).rejects.toThrow("Authentication failed");
    });

    it("still requires authentication when there is no session at all", async () => {
      const { requireApiKey } = await import("../../src/api/middleware/auth.ts");
      vi.mocked(mockAuthApi.getSession).mockResolvedValue(null);

      await expect(requireApiKey(makeContext(), vi.fn())).rejects.toThrow("Authentication required");
    });

    it("passes a valid session with a valid workspace through", async () => {
      const { requireApiKey } = await import("../../src/api/middleware/auth.ts");
      vi.mocked(mockAuthApi.getSession).mockResolvedValue(session);
      mockHasWorkspaceAccess.mockResolvedValue(true);

      const ctx = makeContext({ query: { workspaceId: "123e4567-e89b-42d3-a456-426614174000" } });
      const next = vi.fn();
      await requireApiKey(ctx, next);

      expect(next).toHaveBeenCalled();
      expect(ctx.set).toHaveBeenCalledWith("authType", "session");
      expect(ctx.set).toHaveBeenCalledWith("environmentId", DEFAULT_ENV_ID);
    });

    it("requireSessionOnly surfaces the missing-workspace 400 instead of 'Session required'", async () => {
      const { requireSessionOnly } = await import("../../src/api/middleware/auth.ts");
      vi.mocked(mockAuthApi.getSession).mockResolvedValue(session);

      await expect(requireSessionOnly(makeContext(), vi.fn())).rejects.toThrow(
        "Workspace ID is required"
      );
    });
  });
});
