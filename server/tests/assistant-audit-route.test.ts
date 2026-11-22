import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const WS = "11111111-1111-4111-8111-111111111111";
const role = vi.hoisted(() => ({ current: "member" as "admin" | "member" | "approver" | "viewer" }));
const service = vi.hoisted(() => ({ recordAuditVerdict: vi.fn() }));

vi.mock("../src/db/index.ts", () => ({ db: {}, pool: {} }));
vi.mock("../src/lib/redis.ts", () => ({ redis: {} }));
vi.mock("../src/utils/auth.ts", () => ({
  auth: {}, AUTH_BASE_PATH: "/api/auth", OAUTH_ISSUER: "http://localhost/api/auth", MCP_RESOURCE_URL: "http://localhost/mcp",
}));
vi.mock("../src/lib/logger.ts", () => {
  const l = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => l };
  return { logger: l, apiLogger: l, createLogger: () => l };
});
vi.mock("../src/api/middleware/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/middleware/auth.ts")>();
  return {
    ...actual,
    requireSession: async (c: any, next: any) => { c.set("userId", "user-1"); c.set("authType", "session"); await next(); },
    requireWorkspaceAccess: async (c: any, next: any) => { c.set("workspaceId", c.req.param("workspaceId")); await next(); },
  };
});
vi.mock("../src/api/middleware/feature-gate.ts", () => ({ requireFeature: () => async (_c: any, next: any) => next() }));
vi.mock("../src/core/workspace/roles.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveMemberRole: vi.fn(async () => ({ workspaceRole: role.current, role: role.current, grantedInEnvironmentId: null })),
}));
vi.mock("../src/core/assistant/service.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordAuditVerdict: service.recordAuditVerdict,
}));

import workspacesRouter from "../src/api/routes/workspaces.ts";
import { buildErrorResponse } from "../src/api/middleware/error.ts";
import { ConflictError } from "../src/utils/errors.ts";

const app = new Hono();
app.onError((err, c) => buildErrorResponse(err, c));
app.route("/workspaces", workspacesRouter);

const audit = (verdict = "agree") =>
  app.request(`/workspaces/${WS}/approvals/apr_1/advice/audit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verdict }),
  });

beforeEach(() => {
  service.recordAuditVerdict.mockReset();
  role.current = "member";
});

describe("Vigil audit verdict route", () => {
  it("refuses a member with 403 before touching the verdict", async () => {
    const res = await audit("agree");
    expect(res.status).toBe(403);
    expect(service.recordAuditVerdict).not.toHaveBeenCalled();
  });

  it.each(["admin"] as const)("lets an %s record a verdict, as themselves", async (r) => {
    role.current = r;
    service.recordAuditVerdict.mockResolvedValue({ auditRequested: true, auditVerdict: "disagree" });
    const res = await audit("disagree");
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ auditVerdict: "disagree" });
    expect(service.recordAuditVerdict).toHaveBeenCalledWith(WS, "apr_1", "disagree", "user-1");
  });

  it("maps an already-audited or unsampled decision to 409", async () => {
    role.current = "admin";
    service.recordAuditVerdict.mockRejectedValue(new ConflictError("This Vigil decision has already been audited."));
    const res = await audit("agree");
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  it("answers 404 when there is no advice for the approval", async () => {
    role.current = "admin";
    service.recordAuditVerdict.mockResolvedValue(null);
    expect((await audit("agree")).status).toBe(404);
  });
});
