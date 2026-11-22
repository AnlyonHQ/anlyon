import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono, type Context, type Next } from "hono";

const WS = "11111111-1111-4111-8111-111111111111";
const ENV = "22222222-2222-4222-8222-222222222222";

const caller = vi.hoisted(() => ({ kind: "session" as "session" | "apiKey", role: "member", scopes: [] as string[] }));
const halt = vi.hoisted(() => ({ haltEnvironment: vi.fn(), resumeEnvironment: vi.fn() }));
const resolveMemberRole = vi.hoisted(() => vi.fn());

vi.mock("../src/db/index.ts", () => ({ db: {}, pool: {} }));
vi.mock("../src/lib/redis.ts", () => ({ redis: {}, RedisKeys: {} }));
vi.mock("../src/utils/auth.ts", () => ({
  auth: {}, AUTH_BASE_PATH: "/api/auth", OAUTH_ISSUER: "http://localhost/api/auth", MCP_RESOURCE_URL: "http://localhost/mcp",
}));
vi.mock("../src/lib/logger.ts", () => {
  const l = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => l };
  return { logger: l, apiLogger: l, createLogger: () => l };
});
vi.mock("../src/api/middleware/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/middleware/auth.ts")>();
  const asCaller = (c: Context) => {
    c.set("workspaceId", WS);
    c.set("environmentId", ENV);
    if (caller.kind === "session") {
      c.set("authType", "session");
      c.set("userId", "user_1");
    } else {
      c.set("authType", "apiKey");
      c.set("apiKeyId", "key_1");
      c.set("apiKeyScopes", caller.scopes);
    }
  };
  return {
    ...actual,
    requireApiKey: async (c: Context, next: Next) => { asCaller(c); await next(); },
    requireSession: async (c: Context, next: Next) => { asCaller(c); await next(); },
    requireWorkspaceAccess: async (_c: Context, next: Next) => next(),
  };
});
vi.mock("../src/api/middleware/rateLimit.ts", () => ({ rateLimitByWorkspace: async (_c: Context, next: Next) => next() }));
vi.mock("../src/core/workspace/roles.ts", () => ({ resolveMemberRole }));
vi.mock("../src/core/environments/halt.ts", () => halt);
vi.mock("../src/core/environments/service.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getEnvironment: async () => ({ id: ENV }),
  toPublicEnvironment: (env: unknown) => env,
}));

const { default: environmentRouter } = await import("../src/api/routes/environment.ts");
const { default: workspacesRouter } = await import("../src/api/routes/workspaces.ts");
const { buildErrorResponse } = await import("../src/api/middleware/error.ts");

const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/api/v2/environment", environmentRouter);
app.route("/api/v2/workspaces", workspacesRouter);

const post = (path: string, body: unknown = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const SURFACES = [
  ["the console route", `/api/v2/workspaces/${WS}/environments/${ENV}/halt`, `/api/v2/workspaces/${WS}/environments/${ENV}/resume`],
  ["/api/v2/environment", "/api/v2/environment/halt", "/api/v2/environment/resume"],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  caller.kind = "session";
  caller.scopes = [];
  halt.haltEnvironment.mockResolvedValue({ id: ENV, haltedAt: new Date() });
  halt.resumeEnvironment.mockResolvedValue({ id: ENV, haltedAt: null });
  resolveMemberRole.mockImplementation(async () => ({ workspaceRole: caller.role, role: caller.role, grantedInEnvironmentId: null }));
});

describe.each(SURFACES)("%s with a console session", (_name, haltPath, resumePath) => {
  it.each(["admin", "member"])("a %s can halt", async (role) => {
    caller.role = role;
    expect((await post(haltPath, { reason: "drill" })).status).toBe(200);
    expect(halt.haltEnvironment).toHaveBeenCalledWith(WS, ENV, expect.objectContaining({ actor: "user_1" }));
  });

  it.each(["approver", "viewer"])("a %s cannot halt", async (role) => {
    caller.role = role;
    expect((await post(haltPath)).status).toBe(403);
    expect(halt.haltEnvironment).not.toHaveBeenCalled();
  });

  it.each(["admin"])("a %s can resume", async (role) => {
    caller.role = role;
    expect((await post(resumePath)).status).toBe(200);
    expect(halt.resumeEnvironment).toHaveBeenCalled();
  });

  it.each(["member", "approver", "viewer"])("a %s cannot resume", async (role) => {
    caller.role = role;
    const res = await post(resumePath);
    expect(res.status).toBe(403);
    expect(halt.resumeEnvironment).not.toHaveBeenCalled();
  });

  it("checks the role in the environment being halted", async () => {
    caller.role = "member";
    await post(haltPath);
    expect(resolveMemberRole).toHaveBeenCalledWith(WS, "user_1", ENV);
  });
});

describe("/api/v2/environment with an API key", () => {
  it("halts and resumes on the environments:halt scope alone, with no role lookup", async () => {
    caller.kind = "apiKey";
    caller.scopes = ["environments:halt"];
    expect((await post("/api/v2/environment/halt")).status).toBe(200);
    expect((await post("/api/v2/environment/resume")).status).toBe(200);
    expect(halt.resumeEnvironment).toHaveBeenCalledWith(WS, ENV, expect.objectContaining({ actor: "key:key_1" }));
    expect(resolveMemberRole).not.toHaveBeenCalled();
  });

  it("refuses a key without the scope", async () => {
    caller.kind = "apiKey";
    expect((await post("/api/v2/environment/halt")).status).toBe(403);
    expect((await post("/api/v2/environment/resume")).status).toBe(403);
  });
});
