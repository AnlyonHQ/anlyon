import { Hono, type Context, type Next } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { actionInvocationStatusEnum } from "../src/db/schema/actions.ts";

const list = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/redis.ts", () => ({ RedisKeys: { idempotency: () => "k" }, redis: {} }));
vi.mock("../src/api/middleware/auth.ts", async (original) => ({
  ...await original<typeof import("../src/api/middleware/auth.ts")>(),
  requireApiKey: async (c: Context, next: Next) => {
    c.set("authType", "apiKey");
    c.set("apiKeyId", "key_reader");
    c.set("workspaceId", "ws_1");
    c.set("environmentId", "env_prod");
    c.set("apiKeyScopes", ["actions:read"]);
    await next();
  },
}));
vi.mock("../src/api/middleware/rateLimit.ts", () => ({ rateLimitByWorkspace: async (_c: Context, next: Next) => next() }));
vi.mock("../src/api/middleware/halt.ts", () => ({ haltGuard: () => async (_c: Context, next: Next) => next() }));
vi.mock("../src/core/actions/service.ts", async (original) => ({
  ...await original<typeof import("../src/core/actions/service.ts")>(),
  listInvocations: list,
}));

const router = (await import("../src/api/routes/actions.ts")).default;
const { buildErrorResponse } = await import("../src/api/middleware/error.ts");
const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/actions", router);

beforeEach(() => {
  list.mockReset();
  list.mockResolvedValue({ invocations: [], total: 0 });
});

describe("GET invocations ?status=", () => {
  it.each(["/actions/invocations", "/actions/refund/invocations"])("accepts denied and expired on %s", async (path) => {
    for (const status of ["denied", "expired"] as const) {
      const res = await app.request(`${path}?status=${status}`);
      expect(res.status).toBe(200);
      expect(list).toHaveBeenLastCalledWith("ws_1", expect.objectContaining({ status }));
    }
  });

  it("accepts every status the column can hold", async () => {
    for (const status of actionInvocationStatusEnum.enumValues) {
      expect((await app.request(`/actions/invocations?status=${status}`)).status).toBe(200);
    }
    expect(list).toHaveBeenCalledTimes(actionInvocationStatusEnum.enumValues.length);
  });

  it("refuses a status no invocation can have", async () => {
    expect((await app.request("/actions/invocations?status=cancelled")).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });
});
