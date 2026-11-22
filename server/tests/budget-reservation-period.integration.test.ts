import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BudgetReservationInput, PutBudgetInput } from "../src/core/billing/budgets.ts";

const zero = { messages: 0, eventPublishes: 0, actionInvokes: 0 };
describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("durable budget reservations", () => {
  let pool: Pool;
  let budgets: typeof import("../src/core/billing/budgets.ts");
  const workspaces: string[] = [];
  const users: string[] = [];
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    budgets = await import("../src/core/billing/budgets.ts");
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = ANY($1::uuid[])", [workspaces]);
    await pool.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [users]);
    await pool.end();
  });
  async function account(config: PutBudgetInput = { dimensionCaps: { messages: 10 } }) {
    const userId = `user_${randomUUID()}`;
    users.push(userId);
    await pool.query('INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, \'T\', $2, false, now(), now())', [userId, `${userId}@test.dev`]);
    const { rows: [ws] } = await pool.query("INSERT INTO workspaces (name, slug) VALUES ('budget', $1) RETURNING id", [randomUUID()]);
    workspaces.push(ws.id);
    const { ensureDefaultEnvironment } = await import("../src/core/environments/service.ts");
    const { createApiKey } = await import("../src/core/auth/api-keys.ts");
    const env = await ensureDefaultEnvironment(ws.id);
    const { apiKey } = await createApiKey(ws.id, userId, "budget", undefined, undefined, env.id);
    await budgets.putBudget(ws.id, apiKey.id, config);
    return { workspaceId: ws.id as string, environmentId: env.id, apiKeyId: apiKey.id };
  }
  function input(scope: Awaited<ReturnType<typeof account>>, amount = 1): BudgetReservationInput {
    return { ...scope, dimension: "messages", amount, effectId: randomUUID(), fingerprint: "body" };
  }
  async function period(apiKeyId: string, month: string) {
    return (await pool.query("SELECT * FROM budget_periods WHERE api_key_id = $1 AND month = $2", [apiKeyId, month])).rows[0];
  }

  it("atomically admits only whole quantities under concurrent requests", async () => {
    const scope = await account();
    const results = await Promise.all(Array.from({ length: 10 }, () => budgets.reserveBudget(input(scope, 3))));
    expect(results.filter(r => r.allowed)).toHaveLength(3);
    expect((await budgets.getBudgetUsage(scope.apiKeyId)).messages).toBe(9);
    expect((await budgets.reserveBudget(input(scope, 2))).allowed).toBe(false);
    expect((await budgets.reserveBudget(input(scope))).allowed).toBe(true);
  });

  it("serializes mixed dimensions against one precise fractional spend cap", async () => {
    const scope = await account({ monthlyCostCentsCap: 1 });
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => budgets.reserveBudget({
      ...input(scope, i % 2 ? 2000 : 1000), dimension: i % 2 ? "messages" : "eventPublishes",
    })));
    expect(results.filter(r => r.allowed)).toHaveLength(2);
    const view = await budgets.getBudget(scope.workspaceId, scope.apiKeyId);
    expect(view.estimatedCostCents).toBe(1);
    expect((await budgets.reserveBudget(input(scope))).allowed).toBe(false);
  });

  it("deduplicates concurrent effects, rejects different work, and retains identity after disabling caps", async () => {
    const scope = await account();
    const request = input(scope, 3);
    const results = await Promise.all(Array.from({ length: 8 }, () => budgets.reserveBudget(request)));
    expect(results.filter(r => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map(r => r.reservationId)).size).toBe(1);
    expect((await budgets.getBudgetUsage(scope.apiKeyId)).messages).toBe(3);
    await expect(budgets.reserveBudget({ ...request, fingerprint: "different" })).rejects.toMatchObject({ statusCode: 409 });
    await budgets.putBudget(scope.workspaceId, scope.apiKeyId, { enabled: false });
    expect((await budgets.reserveBudget(request)).replayed).toBe(true);
  });

  it("refunds the original month exactly once without erasing another admission", async () => {
    const scope = await account();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-31T23:59:59Z"));
    const old = await budgets.reserveBudget(input(scope, 3));
    vi.setSystemTime(new Date("2026-09-01T00:00:01Z"));
    await budgets.reserveBudget(input(scope, 2));
    await Promise.all(Array.from({ length: 5 }, () => budgets.refundBudget(old.reservationId!)));
    expect((await period(scope.apiKeyId, "2026-08")).messages).toBe("0");
    expect((await period(scope.apiKeyId, "2026-09")).messages).toBe("2");
    expect((await period(scope.apiKeyId, "2026-09")).cost_microcents).toBe("500");
  });

  it("late refunds cannot credit a new attempt and settled work cannot be refunded", async () => {
    const scope = await account();
    const request = input(scope, 3);
    const first = await budgets.reserveBudget(request);
    await budgets.refundBudget(first.reservationId!);
    const second = await budgets.reserveBudget(request);
    expect(second.reservationId).not.toBe(first.reservationId);
    expect(second.replayed).toBe(false);
    await budgets.refundBudget(first.reservationId!);
    await budgets.settleBudget(second.reservationId!);
    await budgets.refundBudget(second.reservationId!);
    expect((await budgets.getBudgetUsage(scope.apiKeyId)).messages).toBe(3);
    expect((await budgets.reserveBudget(request)).reservationId).toBe(second.reservationId);
    await expect(budgets.refundBudget(randomUUID())).rejects.toMatchObject({ statusCode: 404 });
  });

  it("holds unknown legacy usage and only reconciles complete, monotonic verified floors", async () => {
    const scope = await account();
    const month = (await import("../src/lib/workspace-cache.ts")).getMonthKey();
    await pool.query("INSERT INTO budget_periods (api_key_id, month, reconciliation_required) VALUES ($1, $2, true)", [scope.apiKeyId, month]);
    await expect(budgets.reserveBudget(input(scope))).rejects.toMatchObject({ code: "BUDGET_RECONCILIATION_REQUIRED" });
    expect((await budgets.getBudget(scope.workspaceId, scope.apiKeyId)).reconciliationRequired).toBe(true);
    await expect(budgets.reconcileBudgetPeriod(scope.apiKeyId, month, { ...zero, messages: NaN }, "unknown")).rejects.toMatchObject({ statusCode: 400 });
    await budgets.reconcileBudgetPeriod(scope.apiKeyId, month, { ...zero, messages: 8 }, "verified export");
    await budgets.reserveBudget(input(scope));
    await budgets.reconcileBudgetPeriod(scope.apiKeyId, month, { ...zero, messages: 2 }, "older evidence cannot erase usage");
    expect((await budgets.getBudgetUsage(scope.apiKeyId)).messages).toBe(9);
    expect((await budgets.reserveBudget(input(scope, 2))).allowed).toBe(false);
  });

  it("requires explicit complete evidence and quiescence through the operator CLI", async () => {
    const scope = await account();
    const month = (await import("../src/lib/workspace-cache.ts")).getMonthKey();
    const { redis, RedisKeys } = await import("../src/lib/redis.ts");
    const counter = RedisKeys.keyBudgetCounter(scope.apiKeyId, "messages", month);
    const directory = await mkdtemp(join(tmpdir(), "budget-evidence-"));
    const file = join(directory, "floor.json");
    const command = (args: string[]) => promisify(execFile)(process.execPath, ["--import", "tsx",
      fileURLToPath(new URL("../scripts/reconcile-budget.ts", import.meta.url)), ...args], { timeout: 15_000 });
    await pool.query("INSERT INTO budget_periods (api_key_id, month, reconciliation_required) VALUES ($1, $2, true)", [scope.apiKeyId, month]);
    await redis.set(counter, "4");
    try {
      let evidence = { apiKeyId: scope.apiKeyId, month, floor: { ...zero, messages: 3 }, note: "test verified export" };
      await writeFile(file, JSON.stringify(evidence), { mode: 0o600 });
      await expect(command(["plan", file])).rejects.toMatchObject({ code: 1 });
      evidence = { ...evidence, floor: { ...zero, messages: 4 } };
      await writeFile(file, JSON.stringify(evidence));
      await command(["plan", file]);
      expect((await period(scope.apiKeyId, month)).reconciliation_required).toBe(true);
      await expect(command(["apply", file])).rejects.toMatchObject({ code: 1 });
      await command(["apply", file, "--writers-quiesced"]);
      expect((await period(scope.apiKeyId, month)).reconciliation_required).toBe(false);
      expect((await budgets.getBudgetUsage(scope.apiKeyId)).messages).toBe(4);
      await writeFile(file, JSON.stringify({ ...evidence, floor: { messages: 4 } }));
      await expect(command(["apply", file, "--writers-quiesced"])).rejects.toMatchObject({ code: 1 });
    } finally { await redis.del(counter); await rm(directory, { recursive: true, force: true }); }
  }, 60_000);

  it("checks trusted key scope and the latest cap without cached configuration", async () => {
    const scope = await account();
    await expect(budgets.reserveBudget({ ...input(scope), environmentId: randomUUID() })).rejects.toMatchObject({ statusCode: 404 });
    await expect(budgets.reserveBudget({ ...input(scope), workspaceId: randomUUID() })).rejects.toMatchObject({ statusCode: 404 });
    await budgets.reserveBudget(input(scope, 2));
    await budgets.putBudget(scope.workspaceId, scope.apiKeyId, { dimensionCaps: { messages: 2 } });
    expect((await budgets.reserveBudget(input(scope))).allowed).toBe(false);
    await budgets.deleteBudget(scope.workspaceId, scope.apiKeyId);
    await budgets.putBudget(scope.workspaceId, scope.apiKeyId, { dimensionCaps: { messages: 2 } });
    expect((await budgets.reserveBudget(input(scope))).allowed).toBe(false);
  });
});
