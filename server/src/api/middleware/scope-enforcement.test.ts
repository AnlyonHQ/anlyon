import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requireApiKeyResourceScopes, requireApiKeyScope } from "./auth.ts";
import { buildErrorResponse } from "./error.ts";
import type { ApiKeyScope } from "../../core/auth/api-key-scopes.ts";

type AuthType = "apiKey" | "oauth" | "session";
type Env = { Variables: { authType: AuthType; apiKeyScopes: string[] } };

function guarded(
  authType: AuthType,
  scopes: string[],
  guard: ReturnType<typeof requireApiKeyScope> | ReturnType<typeof requireApiKeyResourceScopes>,
): Hono<Env> {
  const app = new Hono<Env>();
  app.onError((error, c) => buildErrorResponse(error, c));
  app.use("*", async (c, next) => {
    c.set("authType", authType);
    c.set("apiKeyScopes", scopes);
    await next();
  });
  app.use("*", guard);
  app.all("/", (c) => c.json({ reached: true }));
  return app;
}

const call = (app: Hono<Env>, method = "GET") => app.request("/", { method });

describe("requireApiKeyScope", () => {
  it("allows an API key that holds the scope", async () => {
    const response = await call(guarded("apiKey", ["events:read"], requireApiKeyScope("events:read")));
    expect(response.status).toBe(200);
  });

  it("refuses an API key that does not", async () => {
    const response = await call(guarded("apiKey", ["runs:read"], requireApiKeyScope("events:read")));
    expect(response.status).toBe(403);
  });

  it("allows an OAuth token that holds the scope", async () => {
    const response = await call(guarded("oauth", ["events:read"], requireApiKeyScope("events:read")));
    expect(response.status).toBe(200);
  });

  it("refuses an OAuth token that does not", async () => {
    const response = await call(guarded("oauth", ["events:read"], requireApiKeyScope("secrets:read")));
    expect(response.status).toBe(403);
  });

  it("refuses an OAuth token carrying no scopes at all", async () => {
    const response = await call(guarded("oauth", [], requireApiKeyScope("events:read")));
    expect(response.status).toBe(403);
  });

  it("passes session auth through to the role checks", async () => {
    const response = await call(guarded("session", [], requireApiKeyScope("secrets:read")));
    expect(response.status).toBe(200);
  });
});

describe("requireApiKeyResourceScopes", () => {
  const guard = requireApiKeyResourceScopes("events:read", "events:write");

  it("requires the read scope for GET", async () => {
    expect((await call(guarded("oauth", ["events:read"], guard))).status).toBe(200);
    expect((await call(guarded("oauth", ["events:write"], guard))).status).toBe(403);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("requires the write scope for %s", async (method) => {
    expect((await call(guarded("oauth", ["events:write"], guard), method)).status).toBe(200);
    expect((await call(guarded("oauth", ["events:read"], guard), method)).status).toBe(403);
  });

  it("defaults the write scope to the read scope when only one is given", async () => {
    const single = requireApiKeyResourceScopes("logs:read");
    expect((await call(guarded("oauth", ["logs:read"], single), "POST")).status).toBe(200);
    expect((await call(guarded("oauth", [], single), "POST")).status).toBe(403);
  });

  it("enforces for API keys and OAuth alike, and skips sessions", async () => {
    expect((await call(guarded("apiKey", [], guard))).status).toBe(403);
    expect((await call(guarded("oauth", [], guard))).status).toBe(403);
    expect((await call(guarded("session", [], guard))).status).toBe(200);
  });
});

describe("a consented token cannot exceed its consent", () => {
  const consented: ApiKeyScope[] = ["events:read", "events:write", "runs:read", "runs:write"];

  it.each([
    ["secrets:read", "reading workspace secrets"],
    ["approvals:decide", "approving on the user's behalf"],
    ["budgets:write", "changing spend limits"],
  ] as const)("refuses %s (%s)", async (scope, _why) => {
    const response = await call(guarded("oauth", consented, requireApiKeyScope(scope)));
    expect(response.status).toBe(403);
  });

  it("permits what was consented to", async () => {
    expect((await call(guarded("oauth", consented, requireApiKeyScope("runs:write")))).status).toBe(200);
  });
});
