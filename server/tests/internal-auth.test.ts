import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

const SECRET = "internal-auth-test-secret-0000000000000";

async function load() {
  vi.resetModules();
  const { env } = await import("../src/config/env.ts");
  const { requireInternalAuth } = await import("../src/api/middleware/auth.ts");
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error.message }, 401));
  app.get("/status", requireInternalAuth, (c) => c.json({ ok: true }));
  return { env, app };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("INTERNAL_AUTH_SECRET", () => {
  it("lets in only a request that sends it as X-Internal-Auth", async () => {
    vi.stubEnv("INTERNAL_AUTH_SECRET", SECRET);
    const { env, app } = await load();
    expect(env.INTERNAL_AUTH_SECRET).toBe(SECRET);
    expect((await app.request("/status", { headers: { "X-Internal-Auth": SECRET } })).status).toBe(200);
    const wrong = await app.request("/status", { headers: { "X-Internal-Auth": `${SECRET}x` } });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "Invalid internal authentication token" });
    expect(await (await app.request("/status")).json()).toEqual({ error: "Internal authentication required" });
  });

  it("refuses every request when it is unset, so the endpoints are never open by accident", async () => {
    const { env, app } = await load();
    expect(env.INTERNAL_AUTH_SECRET).toBeUndefined();
    const response = await app.request("/status", { headers: { "X-Internal-Auth": SECRET } });
    expect(await response.json()).toEqual({ error: "Internal endpoint is not configured" });
  });

  it("must be at least 32 characters", async () => {
    vi.stubEnv("INTERNAL_AUTH_SECRET", "too-short");
    await expect(load()).rejects.toThrow(/INTERNAL_AUTH_SECRET/);
  });
});

describe("MAINTENANCE_SWEEP_INTERVAL_MS", () => {
  it("is hourly by default, and may be set to a minute or more", async () => {
    expect((await load()).env.MAINTENANCE_SWEEP_INTERVAL_MS).toBe(3_600_000);
    vi.stubEnv("MAINTENANCE_SWEEP_INTERVAL_MS", "120000");
    expect((await load()).env.MAINTENANCE_SWEEP_INTERVAL_MS).toBe(120_000);
    vi.stubEnv("MAINTENANCE_SWEEP_INTERVAL_MS", "1000");
    await expect(load()).rejects.toThrow(/MAINTENANCE_SWEEP_INTERVAL_MS/);
  });
});
