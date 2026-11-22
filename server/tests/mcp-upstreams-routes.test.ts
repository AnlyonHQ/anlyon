import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const state = vi.hoisted(() => ({ featureOn: false, authType: "session" as string, denied: null as string | null }));
const inspect = vi.hoisted(() => ({ inspectUpstream: vi.fn(async () => ({ kind: "credential", host: "mcp.example", status: 401 })) }));
const service = vi.hoisted(() => ({
  listUpstreams: vi.fn(async () => []),
  assertMayAdopt: vi.fn(async () => undefined),
  registerUpstream: vi.fn(async (_w: string, _e: string, input: { name: string; url: string }) => ({ id: "mcpu_1", ...input, tools: [], toolsHash: "h", adopted: [] })),
  getUpstream: vi.fn(),
  refreshUpstream: vi.fn(),
  adoptTools: vi.fn(async () => ({ adopted: [], skipped: [] })),
  archiveUpstream: vi.fn(),
}));

vi.mock("../src/db/index.ts", () => ({ db: {}, pool: {} }));
vi.mock("../src/lib/redis.ts", () => ({ redis: {} }));
vi.mock("../src/utils/auth.ts", () => ({
  auth: {}, AUTH_BASE_PATH: "/api/auth", OAUTH_ISSUER: "http://localhost/api/auth", MCP_RESOURCE_URL: "http://localhost/mcp",
}));
vi.mock("../src/lib/logger.ts", () => {
  const l = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => l };
  return { logger: l, apiLogger: l, createLogger: () => l };
});
vi.mock("@anlyon/feature-flags", async (original) => ({
  ...(await original<typeof import("@anlyon/feature-flags")>()),
  isFeatureEnabled: (key: string) => (key === "mcp-upstreams" ? state.featureOn : true),
}));
vi.mock("../src/api/middleware/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/middleware/auth.ts")>();
  return {
    ...actual,
    requireApiKey: async (c: any, next: any) => {
      c.set("authType", state.authType);
      c.set("workspaceId", "ws-1");
      c.set("environmentId", "env-1");
      if (state.authType === "apiKey") c.set("apiKeyScopes", ["actions:write"]);
      await next();
    },
    requirePermission: (permission: string) => async (_c: any, next: any) => {
      if (state.denied === permission) throw new (await import("../src/utils/errors.ts")).AuthorizationError("Not allowed.");
      await next();
    },
  };
});
vi.mock("../src/api/middleware/rateLimit.ts", () => ({ rateLimitByWorkspace: async (_c: any, next: any) => next() }));
vi.mock("../src/api/audit-caller.ts", () => ({ auditRequest: vi.fn(), auditCaller: () => ({ actor: {}, context: {} }) }));
vi.mock("../src/core/mcp-upstreams/service.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...service,
}));

vi.mock("../src/core/mcp-upstreams/inspect.ts", () => inspect);

import mcpUpstreamsRouter from "../src/api/routes/mcp-upstreams.ts";
import { buildErrorResponse } from "../src/api/middleware/error.ts";

const app = new Hono();
app.onError((err, c) => buildErrorResponse(err, c));
app.route("/api/v2/mcp-upstreams", mcpUpstreamsRouter);

const post = (path: string, body: unknown) =>
  app.request(`/api/v2/mcp-upstreams${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  state.featureOn = false;
  state.authType = "session";
  state.denied = null;
  for (const fn of Object.values(service)) fn.mockClear();
  inspect.inspectUpstream.mockClear();
});

describe("/api/v2/mcp-upstreams", () => {
  it("answers 404 on every route while the feature is held, and reaches nothing behind it", async () => {
    expect((await app.request("/api/v2/mcp-upstreams")).status).toBe(404);
    expect((await post("", { name: "mailer", url: "https://mcp.example/mcp" })).status).toBe(404);
    expect((await post("/mcpu_1/adopt", { tools: { send_email: {} } })).status).toBe(404);
    expect(service.listUpstreams).not.toHaveBeenCalled();
    expect(service.registerUpstream).not.toHaveBeenCalled();
    expect(service.adoptTools).not.toHaveBeenCalled();
  });

  it("serves a console session", async () => {
    state.featureOn = true;
    expect((await app.request("/api/v2/mcp-upstreams")).status).toBe(200);
    const created = await post("", { name: "mailer", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer {{secret:MCP_TOKEN}}" } });
    expect(created.status).toBe(201);
    expect(service.registerUpstream).toHaveBeenCalledWith("ws-1", "env-1", {
      name: "mailer", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer {{secret:MCP_TOKEN}}" },
    }, { scopes: null });
    const adopted = await post("/mcpu_1/adopt", { tools: { send_email: { requiresApproval: true } } });
    expect(adopted.status).toBe(200);
    expect(service.adoptTools).toHaveBeenCalledWith("ws-1", "env-1", "mcpu_1", { send_email: { requiresApproval: true } }, { scopes: null });
  });

  describe("POST /inspect", () => {
    const body = { url: "https://mcp.example/mcp" };

    it("answers 404 where the feature is off", async () => {
      expect((await post("/inspect", body)).status).toBe(404);
      expect(inspect.inspectUpstream).not.toHaveBeenCalled();
    });

    it("takes a credential with actions:write: it stores nothing and sends no credential", async () => {
      state.featureOn = true;
      state.authType = "apiKey";
      expect((await post("/inspect", body)).status).toBe(200);
      expect(inspect.inspectUpstream).toHaveBeenCalledTimes(1);
    });

    it("asks for actions.manage, as registering does", async () => {
      state.featureOn = true;
      state.denied = "actions.manage";
      expect((await post("/inspect", body)).status).toBe(403);
      expect(inspect.inspectUpstream).not.toHaveBeenCalled();
    });

    it("returns what the server is, scoped to the caller's environment", async () => {
      state.featureOn = true;
      const answered = await post("/inspect", body);
      expect(answered.status).toBe(200);
      expect((await answered.json()).data).toEqual({ kind: "credential", host: "mcp.example", status: 401 });
      expect(inspect.inspectUpstream).toHaveBeenCalledWith({ workspaceId: "ws-1", environmentId: "env-1" }, body.url);
    });

    it("refuses a body that is not one URL", async () => {
      state.featureOn = true;
      expect((await post("/inspect", { url: "not a url" })).status).toBe(400);
      expect((await post("/inspect", { ...body, headers: { Authorization: "x" } })).status).toBe(400);
      expect(inspect.inspectUpstream).not.toHaveBeenCalled();
    });
  });

  it("validates the body before the service sees it", async () => {
    state.featureOn = true;
    expect((await post("", { name: "Mailer!", url: "https://mcp.example/mcp" })).status).toBe(400);
    expect((await post("", { name: "mailer", url: "https://mcp.example/mcp", extra: 1 })).status).toBe(400);
    expect((await post("/mcpu_1/adopt", { tools: {} })).status).toBe(400);
    expect((await post("/mcpu_1/adopt", { tools: { send_email: { verify: {} } } })).status).toBe(400);
    expect(service.registerUpstream).not.toHaveBeenCalled();
    expect(service.adoptTools).not.toHaveBeenCalled();
  });
});
