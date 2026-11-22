import { describe, expect, it, vi } from "vitest";
import { Hono, type Context, type Next } from "hono";

const store = vi.hoisted(() => new Map<string, string>());

vi.mock("../../src/lib/redis.ts", () => ({
  RedisKeys: { idempotency: (w: string, e: string, k: string) => `idem:${w}:${e}:${k}` },
  redis: {
    set: async (key: string, value: string, ..._args: unknown[]) => {
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    get: async (key: string) => store.get(key) ?? null,
    eval: async (_script: string, _n: number, key: string, token: string, completed?: string) => {
      const current = store.get(key);
      if (!current) return 0;
      const parsed = JSON.parse(current);
      if (parsed.state !== "pending" || parsed.token !== token) return 0;
      if (completed) store.set(key, completed);
      else store.delete(key);
      return 1;
    },
  },
}));

const { idempotencyMiddleware } = await import("../../src/api/middleware/idempotency.ts");
const { requireApiKeyScope } = await import("../../src/api/middleware/auth.ts");
const { buildErrorResponse } = await import("../../src/api/middleware/error.ts");

let executions = 0;

const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.use("*", async (c: Context, next: Next) => {
  const key = c.req.header("x-test-key") ?? "key_a";
  c.set("authType", "apiKey");
  c.set("apiKeyId", key);
  c.set("workspaceId", "ws_1");
  c.set("environmentId", "env_prod");
  c.set("apiKeyScopes", key === "key_a" ? ["actions:invoke"] : ["actions:read"]);
  await next();
});
app.use("*", idempotencyMiddleware);
app.post("/actions/refund/invoke", requireApiKeyScope("actions:invoke"), (c) => {
  executions += 1;
  return c.json({ success: true, data: { body: "upstream response for key_a: card ending 4242" } });
});

const invoke = (key: string) =>
  app.request("/actions/refund/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "refund-order-42", "x-test-key": key },
    body: JSON.stringify({ input: { orderId: 42 } }),
  });

describe("Idempotency-Key replay", () => {
  it("replays to the credential that created the result", async () => {
    store.clear();
    executions = 0;
    expect((await invoke("key_a")).status).toBe(200);
    const again = await invoke("key_a");
    expect(again.status).toBe(200);
    expect(again.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(executions).toBe(1);
  });

  it("never hands another credential that result, even one without the route's scope", async () => {
    store.clear();
    executions = 0;
    await invoke("key_a");
    const other = await invoke("key_b_without_invoke_scope");
    expect(other.status).not.toBe(200);
    expect(await other.text()).not.toContain("4242");
    expect(executions).toBe(1);
  });
});
