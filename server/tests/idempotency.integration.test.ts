import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let available = false;
let probe: Redis;

beforeAll(async () => {
  probe = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await probe.connect();
    await probe.ping();
    available = true;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  await probe?.quit().catch(() => {});
});

async function makeApp() {
  const { idempotencyMiddleware } = await import("../src/api/middleware/idempotency.ts");
  const state = { handlerCalls: 0 };

  const app = new Hono();
  app.use("*", async (c, next) => {
    const ws = c.req.header("X-Test-Workspace");
    if (ws) c.set("workspaceId", ws);
    await next();
  });
  app.use("*", idempotencyMiddleware);

  app.post("/thing", async (c) => {
    state.handlerCalls += 1;
    const body = await c.req.json().catch(() => ({}));
    await new Promise((r) => setTimeout(r, 50));
    return c.json({ success: true, data: { id: state.handlerCalls, echo: body } }, 201);
  });

  app.post("/maybe-fails", async (c) => {
    state.handlerCalls += 1;
    return c.json({ success: false, error: { code: "boom" } }, 500);
  });

  app.post("/huge", async (c) => {
    state.handlerCalls += 1;
    return c.json({ success: true, data: { blob: "x".repeat(300 * 1024) } }, 201);
  });

  return { app, state };
}

const headers = (key: string, ws = "ws_a") => ({
  "Content-Type": "application/json",
  "Idempotency-Key": key,
  "X-Test-Workspace": ws,
});

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("idempotency middleware (real Redis)", () => {
  afterEach(async () => {
    if (!available) return;
    const keys = await probe.keys("idempotency:ws_*");
    if (keys.length > 0) await probe.del(...keys);
  });

  it("runs the handler exactly once under concurrent identical requests", async () => {
    const { app, state } = await makeApp();
    const key = `k-${Date.now()}-concurrent`;
    const req = () =>
      app.request("/thing", { method: "POST", headers: headers(key), body: JSON.stringify({ a: 1 }) });

    const responses = await Promise.all([req(), req(), req(), req(), req()]);

    expect(state.handlerCalls).toBe(1);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    for (const body of bodies) {
      expect(body).toEqual({ success: true, data: { id: 1, echo: { a: 1 } } });
    }
    for (const r of responses) expect(r.status).toBe(201);
    const replays = responses.filter((r) => r.headers.get("X-Idempotent-Replay") === "true");
    expect(replays.length).toBe(4);
  });

  it("replays a completed result on a later identical request", async () => {
    const { app, state } = await makeApp();
    const key = `k-${Date.now()}-replay`;

    const first = await app.request("/thing", {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify({ a: 1 }),
    });
    const second = await app.request("/thing", {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify({ a: 1 }),
    });

    expect(state.handlerCalls).toBe(1);
    expect(second.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(await first.json()).toEqual(await second.json());
    expect(second.status).toBe(201);
  });

  it("rejects the same key reused for a different body with 409", async () => {
    const { app, state } = await makeApp();
    const key = `k-${Date.now()}-conflict`;

    await app.request("/thing", { method: "POST", headers: headers(key), body: JSON.stringify({ a: 1 }) });
    const conflicting = await app.request("/thing", {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify({ a: 2 }),
    });

    expect(conflicting.status).toBe(409);
    expect((await conflicting.json()).error.code).toBe("idempotency_key_reuse");
    expect(state.handlerCalls).toBe(1);
  });

  it("treats reordered JSON keys as the same request", async () => {
    const { app, state } = await makeApp();
    const key = `k-${Date.now()}-order`;

    await app.request("/thing", {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify({ a: 1, b: 2 }),
    });
    const reordered = await app.request("/thing", {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify({ b: 2, a: 1 }),
    });

    expect(reordered.status).toBe(201);
    expect(reordered.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(state.handlerCalls).toBe(1);
  });

  it("releases the key after a failed request so a retry can run", async () => {
    const { app, state } = await makeApp();
    const key = `k-${Date.now()}-fail`;

    const failed = await app.request("/maybe-fails", { method: "POST", headers: headers(key) });
    expect(failed.status).toBe(500);

    const retry = await app.request("/maybe-fails", { method: "POST", headers: headers(key) });
    expect(retry.status).toBe(500);
    expect(state.handlerCalls).toBe(2);
  });

  it("isolates the same key across workspaces", async () => {
    const { app, state } = await makeApp();
    const key = `k-${Date.now()}-tenant`;

    await app.request("/thing", { method: "POST", headers: headers(key, "ws_a"), body: JSON.stringify({ a: 1 }) });
    const other = await app.request("/thing", {
      method: "POST",
      headers: headers(key, "ws_b"),
      body: JSON.stringify({ a: 1 }),
    });

    expect(other.headers.get("X-Idempotent-Replay")).toBeNull();
    expect(state.handlerCalls).toBe(2);
  });

  it("returns the real response first but refuses to replay an oversized result", async () => {
    const { app, state } = await makeApp();
    const key = `k-${Date.now()}-huge`;

    const first = await app.request("/huge", { method: "POST", headers: headers(key) });
    expect(first.status).toBe(201);
    expect((await first.json()).data.blob.length).toBe(300 * 1024);

    const replay = await app.request("/huge", { method: "POST", headers: headers(key) });
    expect(replay.status).toBe(409);
    expect((await replay.json()).error.code).toBe("idempotency_result_not_stored");
    expect(state.handlerCalls).toBe(1);
  });

  it("makes an overlapping duplicate wait for the first, then replay it", async () => {
    const { app, state } = await makeApp();
    const key = `k-${Date.now()}-wait`;
    const first = app.request("/thing", { method: "POST", headers: headers(key), body: JSON.stringify({ a: 9 }) });
    await new Promise((r) => setTimeout(r, 20));
    const second = await app.request("/thing", {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify({ a: 9 }),
    });
    await first;

    expect(state.handlerCalls).toBe(1);
    expect(second.status).toBe(201);
    expect(second.headers.get("X-Idempotent-Replay")).toBe("true");
  });

  it("runs every time when no key is supplied", async () => {
    const { app, state } = await makeApp();
    const noKey = { "Content-Type": "application/json", "X-Test-Workspace": "ws_a" };

    await app.request("/thing", { method: "POST", headers: noKey, body: JSON.stringify({ a: 1 }) });
    await app.request("/thing", { method: "POST", headers: noKey, body: JSON.stringify({ a: 1 }) });

    expect(state.handlerCalls).toBe(2);
  });
});
