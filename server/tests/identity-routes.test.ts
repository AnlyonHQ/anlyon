import { describe, expect, it, vi } from "vitest";

const edition = vi.hoisted(() => ({ enabled: true, enforced: false }));
const calls = vi.hoisted(() => [] as string[]);

vi.mock("../src/core/edition/features.ts", () => ({ isFeatureEnabled: () => edition.enabled }));
vi.mock("../src/api/middleware/auth.ts", () => ({
  requireSession: vi.fn(async (_c: unknown, next: () => Promise<void>) => {
    calls.push("session");
    await next();
  }),
  requireWorkspaceAccess: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
  requirePermission: (permission: string) => async (_c: unknown, next: () => Promise<void>) => {
    calls.push(`permission:${permission}`);
    await next();
  },
}));
vi.mock("../src/core/sso/service.ts", () => ({
  createSsoConnection: vi.fn(),
  deleteSsoConnection: vi.fn(),
  getSsoConnection: vi.fn(async () => (edition.enforced ? { enforced: true } : null)),
  updateSsoConnection: vi.fn(),
  verifySsoDomains: vi.fn(),
}));
vi.mock("../src/core/scim/settings.ts", () => ({
  getScimSettings: vi.fn(),
  issueScimToken: vi.fn(),
  replaceRoleMappings: vi.fn(),
  revokeScimToken: vi.fn(),
  updateScimDefaultRole: vi.fn(),
}));
vi.mock("../src/core/scim/service.ts", () => ({ reapplyDirectoryRoles: vi.fn() }));
vi.mock("../src/core/workspace/service.ts", () => ({ getWorkspace: vi.fn() }));

const { default: identity } = await import("../src/api/routes/sso.ts");
const { errorHandler, buildErrorResponse } = await import("../src/api/middleware/error.ts");
const { Hono } = await import("hono");

describe("identity settings routes", () => {
  it("exposes exactly the SSO and SCIM settings operations", () => {
    const operations = [...new Set(identity.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`))].sort();
    expect(operations).toEqual([
      "DELETE /:workspaceId/scim/token",
      "DELETE /:workspaceId/sso",
      "GET /:workspaceId/scim",
      "GET /:workspaceId/sso",
      "PATCH /:workspaceId/scim",
      "PATCH /:workspaceId/sso",
      "POST /:workspaceId/scim/token",
      "POST /:workspaceId/sso",
      "POST /:workspaceId/sso/verify-domains",
      "PUT /:workspaceId/scim/role-mappings",
    ]);
  });

  it("requires a session and the identity.manage permission (owner and admin)", async () => {
    calls.length = 0;
    const res = await identity.request("/00000000-0000-4000-8000-000000000001/sso");
    expect(res.status).toBe(200);
    expect(calls).toEqual(["session", "permission:identity.manage"]);
  });

  const gated = () => {
    const app = new Hono();
    app.use("*", errorHandler);
    app.onError((err, c) => buildErrorResponse(err, c));
    app.route("/", identity);
    return app;
  };

  it("answers 404 when the edition does not include the feature, before authenticating", async () => {
    edition.enabled = false;
    calls.length = 0;
    try {
      expect((await gated().request("/00000000-0000-4000-8000-000000000001/scim")).status).toBe(404);
      expect((await gated().request("/00000000-0000-4000-8000-000000000001/sso/verify-domains", { method: "POST" })).status).toBe(404);
      expect(calls).toEqual([]);
    } finally {
      edition.enabled = true;
    }
  });

  it("tells admins when a required SSO stopped applying because the edition dropped it", async () => {
    edition.enabled = false;
    try {
      const plain = await gated().request("/00000000-0000-4000-8000-000000000001/sso");
      expect(plain.status).toBe(404);
      expect((await plain.json()).error.code).toBe("FEATURE_NOT_IN_EDITION");
      edition.enforced = true;
      const suspended = await gated().request("/00000000-0000-4000-8000-000000000001/sso");
      expect(suspended.status).toBe(404);
      expect((await suspended.json()).error.code).toBe("SSO_ENFORCEMENT_SUSPENDED");
    } finally {
      edition.enabled = true;
      edition.enforced = false;
    }
  });
});
