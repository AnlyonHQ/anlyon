import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";

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

const flush = () => new Promise((r) => setTimeout(r, 40));

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("realtime stream (real Redis)", () => {
  let pub: typeof import("../src/core/realtime/publisher.ts");

  beforeAll(async () => {
    pub = await import("../src/core/realtime/publisher.ts");
  });

  afterEach(async () => {
    if (!available) return;
    const keys = await probe.keys("realtime:ws_*");
    if (keys.length > 0) await probe.del(...keys);
  });

  it("publishes events and replays them in order from the start", async () => {
    const ws = `ws_${randomUUID()}`;
    pub.publishRealtime(ws, { type: "run.started", environmentId: "env_a", data: { runId: "run_1" } });
    pub.publishRealtime(ws, { type: "run.ended", environmentId: "env_a", data: { runId: "run_1" } });
    await flush();

    const events = await pub.replaySince(ws, null);
    expect(events.map((e) => e.type)).toEqual(["run.started", "run.ended"]);
    expect(events[0].data).toEqual({ runId: "run_1" });
    expect(events[0].id).toMatch(/^\d+-\d+$/);
    expect(events[0].v).toBe(pub.REALTIME_SCHEMA_VERSION);
  });

  it("resumes strictly after a cursor with no gap and no repeat", async () => {
    const ws = `ws_${randomUUID()}`;
    pub.publishRealtime(ws, { type: "a", data: {} });
    pub.publishRealtime(ws, { type: "b", data: {} });
    await flush();

    const firstBatch = await pub.replaySince(ws, null);
    const cursor = firstBatch[0].id;

    pub.publishRealtime(ws, { type: "c", data: {} });
    await flush();

    const resumed = await pub.replaySince(ws, cursor);
    expect(resumed.map((e) => e.type)).toEqual(["b", "c"]);
  });

  it("isolates events between workspaces", async () => {
    const a = `ws_${randomUUID()}`;
    const b = `ws_${randomUUID()}`;
    pub.publishRealtime(a, { type: "a-only", data: {} });
    pub.publishRealtime(b, { type: "b-only", data: {} });
    await flush();

    expect((await pub.replaySince(a, null)).map((e) => e.type)).toEqual(["a-only"]);
    expect((await pub.replaySince(b, null)).map((e) => e.type)).toEqual(["b-only"]);
  });

  it("tails live events published after the tail starts", async () => {
    const ws = `ws_${randomUUID()}`;
    const tailPromise = pub.tailAfter(ws, "$", 3000);
    await new Promise((r) => setTimeout(r, 50));
    pub.publishRealtime(ws, { type: "live", environmentId: "env_a", data: { n: 1 } });

    const events = await tailPromise;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("live");
    expect(events[0].environmentId).toBe("env_a");
  });

  it("returns [] on a tail timeout so the caller can heartbeat", async () => {
    const ws = `ws_${randomUUID()}`;
    const events = await pub.tailAfter(ws, "$", 200);
    expect(events).toEqual([]);
  });

  it("carries a null environment for workspace-wide events", async () => {
    const ws = `ws_${randomUUID()}`;
    pub.publishRealtime(ws, { type: "system", data: { ok: true } });
    await flush();
    const [event] = await pub.replaySince(ws, null);
    expect(event.environmentId).toBeNull();
  });
});
