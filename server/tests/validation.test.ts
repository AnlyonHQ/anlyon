import { describe, it, expect } from "vitest";
import {
  httpMethodSchema,
  createWorkspaceSchema,
  updateWorkspaceSchema,
  inviteMemberSchema,
  createApiKeySchema,
  paginationSchema,
  analyticsQuerySchema,
  signupSchema,
  loginSchema,
} from "../src/utils/validation.ts";

describe("Validation Schemas", () => {
  describe("httpMethodSchema", () => {
    it("should accept valid HTTP methods", () => {
      const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];

      for (const method of validMethods) {
        expect(httpMethodSchema.parse(method)).toBe(method);
      }
    });

    it("should reject invalid methods", () => {
      expect(() => httpMethodSchema.parse("OPTIONS")).toThrow();
      expect(() => httpMethodSchema.parse("HEAD")).toThrow();
      expect(() => httpMethodSchema.parse("get")).toThrow();
      expect(() => httpMethodSchema.parse("")).toThrow();
    });
  });

  describe("createWorkspaceSchema", () => {
    it("should accept valid workspace", () => {
      const result = createWorkspaceSchema.parse({
        name: "My Workspace",
      });

      expect(result.name).toBe("My Workspace");
    });

    it("should accept optional slug", () => {
      const result = createWorkspaceSchema.parse({
        name: "My Workspace",
        slug: "my-workspace",
      });

      expect(result.slug).toBe("my-workspace");
    });

    it("should reject invalid slug format", () => {
      expect(() =>
        createWorkspaceSchema.parse({
          name: "Test",
          slug: "Invalid Slug!",
        })
      ).toThrow();
    });

    it("should reject slug less than 3 chars", () => {
      expect(() =>
        createWorkspaceSchema.parse({
          name: "Test",
          slug: "ab",
        })
      ).toThrow();
    });

    it("should reject slug more than 50 chars", () => {
      expect(() =>
        createWorkspaceSchema.parse({
          name: "Test",
          slug: "a".repeat(51),
        })
      ).toThrow();
    });

    it("should accept valid slug patterns", () => {
      const validSlugs = ["my-workspace", "test123", "a-b-c-d", "123"];

      for (const slug of validSlugs) {
        const result = createWorkspaceSchema.parse({
          name: "Test",
          slug,
        });
        expect(result.slug).toBe(slug);
      }
    });
  });

  describe("inviteMemberSchema", () => {
    it("should accept valid invitation", () => {
      const result = inviteMemberSchema.parse({
        email: "user@example.com",
        role: "member",
      });

      expect(result.email).toBe("user@example.com");
      expect(result.role).toBe("member");
    });

    it("should accept all role types", () => {
      const roles = ["admin", "member", "approver", "viewer"];

      for (const role of roles) {
        const result = inviteMemberSchema.parse({
          email: "test@example.com",
          role,
        });
        expect(result.role).toBe(role);
      }
    });

    it("should refuse the retired owner role", () => {
      expect(() => inviteMemberSchema.parse({ email: "test@example.com", role: "owner" })).toThrow();
    });

    it("should reject invalid email", () => {
      expect(() =>
        inviteMemberSchema.parse({
          email: "not-an-email",
          role: "member",
        })
      ).toThrow();
    });

    it("should reject invalid role", () => {
      expect(() =>
        inviteMemberSchema.parse({
          email: "test@example.com",
          role: "superadmin",
        })
      ).toThrow();
    });
  });

  describe("createApiKeySchema", () => {
    it("should accept valid API key creation", () => {
      const result = createApiKeySchema.parse({
        name: "Production Key",
      });

      expect(result.name).toBe("Production Key");
    });

    it("should accept optional expiresAt", () => {
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      const result = createApiKeySchema.parse({
        name: "Temporary Key",
        expiresAt,
      });

      expect(result.expiresAt).toBe(expiresAt);
    });

    it("should reject expiresAt in the past", () => {
      expect(() =>
        createApiKeySchema.parse({
          name: "Expired Key",
          expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
        })
      ).toThrow();
    });

    it("should reject empty name", () => {
      expect(() => createApiKeySchema.parse({ name: "" })).toThrow();
    });

    it("should reject name exceeding 100 chars", () => {
      expect(() =>
        createApiKeySchema.parse({ name: "a".repeat(101) })
      ).toThrow();
    });

    it("should reject invalid datetime for expiresAt", () => {
      expect(() =>
        createApiKeySchema.parse({
          name: "Test",
          expiresAt: "not-a-date",
        })
      ).toThrow();
    });
  });

  describe("paginationSchema", () => {
    it("should accept valid pagination", () => {
      const result = paginationSchema.parse({
        page: 2,
        limit: 50,
      });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(50);
    });

    it("should use defaults when not provided", () => {
      const result = paginationSchema.parse({});

      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it("should coerce string to number", () => {
      const result = paginationSchema.parse({
        page: "3",
        limit: "25",
      });

      expect(result.page).toBe(3);
      expect(result.limit).toBe(25);
    });

    it("should reject page less than 1", () => {
      expect(() => paginationSchema.parse({ page: 0 })).toThrow();
    });

    it("should reject limit exceeding 100", () => {
      expect(() => paginationSchema.parse({ limit: 101 })).toThrow();
    });
  });

  describe("analyticsQuerySchema", () => {
    it("should accept valid query", () => {
      const result = analyticsQuerySchema.parse({
        startDate: "2024-01-01T00:00:00Z",
        endDate: "2024-01-31T23:59:59Z",
        granularity: "day",
      });

      expect(result.granularity).toBe("day");
    });

    it("should default granularity to day", () => {
      const result = analyticsQuerySchema.parse({});

      expect(result.granularity).toBe("day");
    });

    it("should accept all granularity values", () => {
      const granularities = ["hour", "day", "week", "month"];

      for (const granularity of granularities) {
        const result = analyticsQuerySchema.parse({ granularity });
        expect(result.granularity).toBe(granularity);
      }
    });
  });

  describe("signupSchema", () => {
    it("should accept valid signup", () => {
      const result = signupSchema.parse({
        email: "user@example.com",
        password: "securepassword123",
        name: "John Doe",
      });

      expect(result.email).toBe("user@example.com");
      expect(result.name).toBe("John Doe");
    });

    it("should accept optional workspace name", () => {
      const result = signupSchema.parse({
        email: "user@example.com",
        password: "password123",
        name: "John",
        workspaceName: "My Company",
      });

      expect(result.workspaceName).toBe("My Company");
    });

    it("should reject password less than 8 chars", () => {
      expect(() =>
        signupSchema.parse({
          email: "user@example.com",
          password: "short",
          name: "John",
        })
      ).toThrow();
    });

    it("should reject password more than 100 chars", () => {
      expect(() =>
        signupSchema.parse({
          email: "user@example.com",
          password: "a".repeat(101),
          name: "John",
        })
      ).toThrow();
    });

    it("should reject invalid email", () => {
      expect(() =>
        signupSchema.parse({
          email: "not-an-email",
          password: "password123",
          name: "John",
        })
      ).toThrow();
    });
  });

  describe("loginSchema", () => {
    it("should accept valid login", () => {
      const result = loginSchema.parse({
        email: "user@example.com",
        password: "password123",
      });

      expect(result.email).toBe("user@example.com");
    });

    it("should reject empty password", () => {
      expect(() =>
        loginSchema.parse({
          email: "user@example.com",
          password: "",
        })
      ).toThrow();
    });

    it("should reject invalid email", () => {
      expect(() =>
        loginSchema.parse({
          email: "invalid",
          password: "password123",
        })
      ).toThrow();
    });
  });
});
