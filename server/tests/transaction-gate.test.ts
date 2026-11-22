import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildErrorResponse, isDatabaseUnavailable } from "../src/api/middleware/error.ts";
import { asTransactionTenant, TransactionGate } from "../src/db/transaction-gate.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("the transaction gate", () => {
  it("runs at most its permits at once, and everything in the end", async () => {
    const gate = new TransactionGate(3, 5_000);
    let open = 0;
    let peak = 0;
    const done = await Promise.all(Array.from({ length: 20 }, (_, i) => gate.run(async () => {
      peak = Math.max(peak, ++open);
      await tick();
      open--;
      return i;
    })));
    expect(peak).toBe(3);
    expect(done).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(gate.state).toEqual({ active: 0, waiting: 0 });
  });

  it("starts waiters in the order they arrived", async () => {
    const gate = new TransactionGate(1, 5_000);
    const started: number[] = [];
    await Promise.all([1, 2, 3, 4].map((n) => gate.run(async () => { started.push(n); await tick(); })));
    expect(started).toEqual([1, 2, 3, 4]);
  });

  it("frees its permit when the work throws", async () => {
    const gate = new TransactionGate(1, 5_000);
    await expect(gate.run(async () => { throw new Error("rolled back"); })).rejects.toThrow("rolled back");
    expect(gate.state).toEqual({ active: 0, waiting: 0 });
    expect(await gate.run(async () => "next")).toBe("next");
  });

  it("gives up after its wait with an error that says it was not started, and leaves the queue clean", async () => {
    const gate = new TransactionGate(1, 20);
    let release!: () => void;
    const held = gate.run(() => new Promise<void>((resolve) => { release = resolve; }));
    await expect(gate.run(async () => "never")).rejects.toThrow(/waited 20 ms to begin and was not started\./);
    expect(gate.state).toEqual({ active: 1, waiting: 0 });
    release();
    await held;
    expect(await gate.run(async () => "after")).toBe("after");
  });

  it("gives up with an error the API answers as 503 database-unavailable, not 500", async () => {
    const gate = new TransactionGate(1, 10);
    let release!: () => void;
    const held = gate.run(() => new Promise<void>((resolve) => { release = resolve; }));
    const refused = await gate.run(async () => "never").catch((error: unknown) => error);
    expect(isDatabaseUnavailable(refused)).toBe(true);
    release();
    await held;
  });

  it("holds one tenant to its share, so another tenant begins at once behind its backlog", async () => {
    const gate = new TransactionGate(10, 5_000, 7);
    const releases: Array<() => void> = [];
    const hold = () => new Promise<void>((resolve) => { releases.push(resolve); });
    let begunA = 0;
    const backlog = Array.from({ length: 40 }, () => gate.run(async () => { begunA++; await hold(); }, "A"));
    await tick();
    expect(begunA).toBe(7);
    expect(gate.state).toEqual({ active: 7, waiting: 33 });
    expect(await gate.run(async () => "b", "B")).toBe("b");
    expect(await gate.run(async () => "unnamed", undefined)).toBe("unnamed");
    while (releases.length > 0) {
      releases.shift()!();
      await tick();
      expect(gate.state.active).toBeLessThanOrEqual(7);
    }
    await Promise.all(backlog);
    expect(begunA).toBe(40);
    expect(gate.state).toEqual({ active: 0, waiting: 0 });
  });

  it("never opens more than its permits across tenants, and passes over only a tenant at its share", async () => {
    const gate = new TransactionGate(4, 5_000, 3);
    let open = 0;
    let peak = 0;
    const perTenantPeak = new Map<string, number>();
    const openBy = new Map<string, number>();
    const started: string[] = [];
    const work = (tenant: string, n: number) => gate.run(async () => {
      started.push(`${tenant}${n}`);
      peak = Math.max(peak, ++open);
      openBy.set(tenant, (openBy.get(tenant) ?? 0) + 1);
      perTenantPeak.set(tenant, Math.max(perTenantPeak.get(tenant) ?? 0, openBy.get(tenant)!));
      await tick();
      await tick();
      openBy.set(tenant, openBy.get(tenant)! - 1);
      open--;
    }, tenant);
    await Promise.all([...Array.from({ length: 12 }, (_, n) => work("A", n)), ...Array.from({ length: 12 }, (_, n) => work("B", n))]);
    expect(peak).toBe(4);
    expect(perTenantPeak.get("A")).toBeLessThanOrEqual(3);
    expect(perTenantPeak.get("B")).toBeLessThanOrEqual(3);
    expect(started.length).toBe(24);
    expect(started.indexOf("B0")).toBeLessThan(5);
    expect(gate.state).toEqual({ active: 0, waiting: 0 });
  });

  it("takes the tenant from the request it runs in", async () => {
    const gate = new TransactionGate(3, 5_000, 1);
    const releases: Array<() => void> = [];
    const first = asTransactionTenant("A", () => gate.run(() => new Promise<void>((resolve) => { releases.push(resolve); })));
    await tick();
    let second = false;
    const waiting = asTransactionTenant("A", () => gate.run(async () => { second = true; }));
    await tick();
    expect(second).toBe(false);
    expect(await asTransactionTenant("B", () => gate.run(async () => "b"))).toBe("b");
    releases[0]();
    await Promise.all([first, waiting]);
    expect(second).toBe(true);
  });

  it("frees a tenant's share when its work throws or its wait runs out", async () => {
    const gate = new TransactionGate(2, 20, 1);
    await expect(gate.run(async () => { throw new Error("rolled back"); }, "A")).rejects.toThrow("rolled back");
    let release!: () => void;
    const held = gate.run(() => new Promise<void>((resolve) => { release = resolve; }), "A");
    await expect(gate.run(async () => "never", "A")).rejects.toThrow(/was not started/);
    expect(gate.state).toEqual({ active: 1, waiting: 0 });
    release();
    await held;
    expect(await gate.run(async () => "after", "A")).toBe("after");
    expect(gate.state).toEqual({ active: 0, waiting: 0 });
  });

  it("refuses a share that is no permits or more than all of them", () => {
    expect(() => new TransactionGate(3, 1, 0)).toThrow();
    expect(() => new TransactionGate(3, 1, 4)).toThrow();
  });

  it("refuses a gate with no permits", () => {
    expect(() => new TransactionGate(0, 1)).toThrow();
  });
});

describe("the transaction gate, as the API answers it", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers a transaction that could not begin with 503, Retry-After and SERVICE_UNAVAILABLE", async () => {
    vi.useFakeTimers();
    const { db, transactionGate } = await import("../src/db/index.ts");
    const releases: Array<() => void> = [];
    const held = Array.from({ length: transactionGate.permits }, () =>
      transactionGate.run(() => new Promise<void>((resolve) => { releases.push(resolve); })));
    await vi.advanceTimersByTimeAsync(0);
    expect(transactionGate.state).toEqual({ active: transactionGate.permits, waiting: 0 });

    let began = false;
    const app = new Hono();
    app.onError((error, c) => buildErrorResponse(error, c));
    app.post("/write", async (c) => {
      await db.transaction(async () => { began = true; });
      return c.json({ success: true });
    });

    const pending = app.request("/write", { method: "POST" });
    await vi.advanceTimersByTimeAsync(0);
    expect(transactionGate.state.waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    const res = await pending;

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(await res.json()).toMatchObject({ success: false, error: { code: "SERVICE_UNAVAILABLE" } });
    expect(began).toBe(false);
    expect(transactionGate.state).toEqual({ active: transactionGate.permits, waiting: 0 });

    for (const release of releases) release();
    await Promise.all(held);
    expect(transactionGate.state).toEqual({ active: 0, waiting: 0 });
  });
});
