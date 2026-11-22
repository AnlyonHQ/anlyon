import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined }));

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client) };
});

const { db } = await import("../src/db/index.ts");
const lifecycle = await import("../src/core/audit/lifecycle.ts");
const { sweepAuditRetention } = await import("../src/core/audit/retention.ts");
const service = await import("../src/core/audit/service.ts");
const { writeAuditEvents } = await import("../src/core/audit/outbox.ts");
const { setAuditArchiveStoreForTest } = await import("../src/core/audit/archive-store.ts");
const { erasedEndUserId } = await import("../src/core/end-users/identity.ts");
const { AUDIT_RETENTION_GRACE_DAYS } = await import("../src/core/plans/limits.ts");
const { usePlanFixture } = await import("./support/plan-fixture.ts");
usePlanFixture({
  free: { auditRetentionMonths: 6 },
  starter: { auditRetentionMonths: 6 },
  production: { auditRetentionMonths: 6 },
  paygo: { auditRetentionMonths: 6 },
  growth: { auditRetentionMonths: 12 },
  enterprise: { auditRetentionMonths: 12 },
});
type Store = import("../src/core/audit/archive-store.ts").AuditArchiveStore;

const DAY = 86_400_000;
const ws = "00000000-0000-4000-8000-00000000d0a1";
const env = "00000000-0000-4000-8000-00000000d0b1";
const sql = (text: string, params: unknown[] = []) => state.client!.query<Record<string, unknown>>(text, params);

function memoryStore() {
  const objects = new Map<string, Buffer>();
  const store: Store = {
    async put(key, body) { objects.set(key, Buffer.from(body)); },
    async get(key) { return objects.get(key) ?? null; },
    async head(key) { const body = objects.get(key); return body ? { sizeBytes: body.length } : null; },
    async delete(key) { objects.delete(key); },
  };
  return { store, objects };
}

let bucket = memoryStore();
const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const later = (days: number) => new Date(now.getTime() + days * DAY);

async function seed(type: string, occurredAt: Date, extra: { endUserId?: string; environmentId?: string | null; data?: Record<string, unknown> } = {}) {
  await writeAuditEvents(db, [{
    workspaceId: ws, environmentId: extra.environmentId === undefined ? env : extra.environmentId, type,
    actor: { type: "user", id: "user_1" }, data: extra.data ?? {}, occurredAt, endUserId: extra.endUserId ?? null,
  }]);
}
const rows = async () => (await sql("SELECT type, occurred_at FROM audit_events WHERE workspace_id = $1 ORDER BY occurred_at, seq", [ws])).rows;
const types = async (prefix: string) => (await rows()).map((r) => r.type as string).filter((t) => t.startsWith(prefix));
const lifecycleEvents = async (type: string) =>
  (await sql("SELECT data, actor_type FROM audit_events WHERE workspace_id = $1 AND type = $2 ORDER BY seq", [ws, type])).rows;
async function exported(filter: Parameters<typeof service.iterateAuditEvents>[1] = {}) {
  const all: Array<{ type: string; occurredAt: string; endUserId?: string | null }> = [];
  for await (const chunk of service.iterateAuditEvents(ws, filter)) all.push(...(chunk as typeof all));
  return all;
}
const run = (at: Date) => lifecycle.runAuditLifecycle({ now: at, workspaceIds: [ws], store: bucket.store });

async function clear() {
  await state.client!.transaction(async (tx) => {
    await tx.query("SELECT set_config('anlyon.audit_removal', 'retention', true)");
    await tx.query("DELETE FROM audit_events WHERE workspace_id = $1", [ws]);
  });
  await sql("DELETE FROM audit_archives WHERE workspace_id = $1", [ws]);
  await sql("DELETE FROM audit_lifecycle WHERE workspace_id = $1", [ws]);
  await sql("DELETE FROM audit_sinks WHERE workspace_id = $1", [ws]);
  await sql("DELETE FROM end_user_erasures WHERE workspace_id = $1", [ws]);
}

beforeAll(async () => {
  await sql("INSERT INTO workspaces (id, name, slug, plan) VALUES ($1, 'ws', 'ws-lifecycle', 'growth')", [ws]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug) VALUES ($1, $2, 'prod', 'prod')", [env, ws]);
}, 120_000);

beforeEach(async () => {
  await clear();
  await sql("UPDATE workspaces SET plan = 'growth' WHERE id = $1", [ws]);
  bucket = memoryStore();
  setAuditArchiveStoreForTest(bucket.store);
});

afterEach(() => {
  setAuditArchiveStoreForTest(undefined);
  delete process.env.AUDIT_ARCHIVE_PAUSED;
  delete process.env.AUDIT_HOT_DAYS;
});

describe("retention rules", () => {
  const seen = (planRetentionMonths: number, floorMonths: number | null = null, floorUntil: Date | null = null) =>
    ({ planRetentionMonths, floorMonths, floorUntil });

  it("keeps everything for the grace period the first time a plan retention applies", () => {
    const decision = lifecycle.resolveRetention(6, null, now);
    expect(decision.effectiveMonths).toBeNull();
    expect(decision.next).toEqual({ planRetentionMonths: 6, floorMonths: null, floorUntil: later(AUDIT_RETENTION_GRACE_DAYS) });
    expect(decision.change).toMatchObject({ fromMonths: null, toMonths: 6 });
    expect(lifecycle.resolveRetention(6, decision.next, later(29)).effectiveMonths).toBeNull();
    expect(lifecycle.resolveRetention(6, decision.next, later(31)).effectiveMonths).toBe(6);
  });

  it("keeps the longer retention for the grace period after a downgrade, then the shorter", () => {
    const decision = lifecycle.resolveRetention(6, seen(12), now);
    expect(decision.effectiveMonths).toBe(12);
    expect(decision.change).toEqual({ fromMonths: 12, toMonths: 6, takesEffectAt: later(AUDIT_RETENTION_GRACE_DAYS) });
    expect(lifecycle.resolveRetention(6, decision.next, later(29)).effectiveMonths).toBe(12);
    expect(lifecycle.resolveRetention(6, decision.next, later(31)).effectiveMonths).toBe(6);
  });

  it("applies an upgrade at once", () => {
    const decision = lifecycle.resolveRetention(12, seen(6), now);
    expect(decision.effectiveMonths).toBe(12);
    expect(decision.change).toEqual({ fromMonths: 6, toMonths: 12, takesEffectAt: now });
  });

  it("does not shorten a grace that is still running", () => {
    const first = lifecycle.resolveRetention(12, null, now);
    const downgraded = lifecycle.resolveRetention(6, first.next, later(10));
    expect(downgraded.effectiveMonths).toBeNull();
    expect(downgraded.next?.floorUntil).toEqual(later(10 + AUDIT_RETENTION_GRACE_DAYS));
  });

  it("deletes nothing for a plan without a retention (self-hosted)", () => {
    expect(lifecycle.resolveRetention(null, seen(6), now)).toEqual({ effectiveMonths: null, next: null, change: null });
  });

  it("counts calendar months and takes the later of the plan's and the workspace's cutoff", () => {
    expect(lifecycle.monthsBefore(new Date("2026-08-31T12:00:00Z"), 6).toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect(lifecycle.monthsBefore(new Date("2027-01-15T00:00:00Z"), 12).toISOString()).toBe("2026-01-15T00:00:00.000Z");
    const at = new Date("2026-10-28T00:00:00Z");
    expect(lifecycle.deleteBefore(at, 6, 30)?.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(lifecycle.deleteBefore(at, 6, 3650)?.toISOString()).toBe("2026-04-28T00:00:00.000Z");
    expect(lifecycle.deleteBefore(at, null, null)).toBeNull();
  });
});

describe("the delete guard", () => {
  it("refuses a plain DELETE or TRUNCATE, and UPDATE stays refused", async () => {
    await seed("member.added", ago(1));
    await expect(sql("DELETE FROM audit_events WHERE workspace_id = $1", [ws])).rejects.toThrow(/removed only by the audit lifecycle/);
    await expect(sql("TRUNCATE audit_events")).rejects.toThrow(/removed only by the audit lifecycle/);
    await expect(sql("UPDATE audit_events SET type = 'x' WHERE workspace_id = $1", [ws])).rejects.toThrow(/immutable/);
    expect(await types("member.")).toEqual(["member.added"]);
  });

  it("refuses a removal path named outside the transaction, or an unknown one", async () => {
    await seed("member.added", ago(1));
    await sql("SELECT set_config('anlyon.audit_removal', 'archive', true)");
    await expect(sql("DELETE FROM audit_events WHERE workspace_id = $1", [ws])).rejects.toThrow(/audit lifecycle/);
    await expect(state.client!.transaction(async (tx) => {
      await tx.query("SELECT set_config('anlyon.audit_removal', 'cleanup', true)");
      await tx.query("DELETE FROM audit_events WHERE workspace_id = $1", [ws]);
    })).rejects.toThrow(/audit lifecycle/);
    expect(await types("member.")).toEqual(["member.added"]);
  });

  it("lets a deleted workspace take its records with it", async () => {
    const other = "00000000-0000-4000-8000-00000000d0a9";
    await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'gone', 'ws-gone')", [other]);
    await writeAuditEvents(db, [{ workspaceId: other, type: "member.added", occurredAt: now }]);
    await sql("DELETE FROM workspaces WHERE id = $1", [other]);
    expect((await sql("SELECT count(*)::int AS n FROM audit_events WHERE workspace_id = $1", [other])).rows[0].n).toBe(0);
  });
});

describe("archive, read back, delete", () => {
  it("moves records past the hot window to the archive, verified, and records each object", async () => {
    await seed("member.added", ago(200));
    await seed("member.updated", ago(100));
    await seed("member.removed", ago(100));
    await seed("member.invited", ago(10));

    const result = await run(now);
    expect(result).toMatchObject({ archive: "available", archiveObjects: 2, archived: 3, deleted: 0 });
    expect(bucket.objects.size).toBe(4);
    expect(await types("member.")).toEqual(["member.invited"]);

    const archived = await lifecycleEvents("audit.records.archived");
    expect(archived).toHaveLength(2);
    expect(archived[0].actor_type).toBe("system");
    expect(archived.map((e) => (e.data as { recordCount: number }).recordCount).sort()).toEqual([1, 2]);
    const manifest = JSON.parse(bucket.objects.get([...bucket.objects.keys()].find((k) => k.endsWith(".manifest.json"))!)!.toString());
    expect(manifest).toMatchObject({ format: "anlyon.audit.archive.v1", workspaceId: ws, environmentId: env, order: "occurredAt,sequence" });

    expect((await run(now)).archiveObjects).toBe(0);
  });

  it("exports across the hot and archived records in one order", async () => {
    await seed("member.added", ago(200));
    await seed("member.updated", ago(100));
    await seed("member.removed", new Date(ago(100).getTime() + 1000));
    await seed("member.invited", ago(10));
    await run(now);

    const all = await exported({ types: ["member.*"] });
    expect(all.map((e) => e.type)).toEqual(["member.added", "member.updated", "member.removed", "member.invited"]);

    const ranged = await exported({ types: ["member.*"], from: ago(150), to: ago(5) });
    expect(ranged.map((e) => e.type)).toEqual(["member.updated", "member.removed", "member.invited"]);
    expect(await exported({ types: ["member.updated"] })).toHaveLength(1);
  });

  it("refuses an altered object, and an export when the archive cannot be reached", async () => {
    await seed("member.added", ago(200));
    await run(now);
    const key = [...bucket.objects.keys()].find((k) => k.endsWith(".jsonl.gz"))!;
    bucket.objects.set(key, Buffer.concat([bucket.objects.get(key)!, Buffer.from("x")]));
    await expect(exported()).rejects.toMatchObject({ code: "AUDIT_ARCHIVE_INTEGRITY" });

    setAuditArchiveStoreForTest(null);
    await expect(service.assertExportReadable(ws, {})).rejects.toMatchObject({ statusCode: 503, code: "AUDIT_ARCHIVE_UNAVAILABLE" });
    await expect(service.assertExportReadable(ws, { from: ago(30), to: now })).resolves.toBeUndefined();
  });

  it("exports an erased end user's archived records under the erased id", async () => {
    await seed("action.succeeded", ago(200), { endUserId: "eu_1", data: { actionName: "refund" } });
    await seed("action.succeeded", ago(200), { endUserId: "eu_2", data: { actionName: "refund" } });
    await run(now);
    const erasedAs = erasedEndUserId(ws, "eu_1");
    await sql("INSERT INTO end_user_erasures (workspace_id, environment_id, erased_as, erased_at) VALUES ($1, $2, $3, now())", [ws, env, erasedAs]);
    const all = await exported({ types: ["action.*"] });
    expect(all.map((e) => e.endUserId).sort()).toEqual([erasedAs, "eu_2"].sort());
    expect(await exported({ endUserId: "eu_1" })).toHaveLength(0);
  });

  it("deletes archived records when retention ends, after the first-time grace", async () => {
    await seed("member.added", ago(400));
    await seed("member.updated", ago(200));
    expect((await run(now)).archiveObjects).toBe(2);
    expect(await lifecycleEvents("audit.retention.changed")).toHaveLength(1);

    expect((await run(later(10))).expiredObjects).toBe(0);

    const result = await run(later(AUDIT_RETENTION_GRACE_DAYS + 1));
    expect(result).toMatchObject({ expiredObjects: 1, expiredRecords: 1 });
    expect(bucket.objects.size).toBe(2);
    const expired = await lifecycleEvents("audit.records.expired");
    expect(expired[0].data).toMatchObject({ source: "archive", recordCount: 1, retentionMonths: 12 });
    expect((await exported({ types: ["member.*"] })).map((e) => e.type)).toEqual(["member.updated"]);
    expect((await sql("SELECT count(*)::int AS n FROM audit_archives WHERE workspace_id = $1 AND expired_at IS NOT NULL", [ws])).rows[0].n).toBe(1);
  });

  it("waits out the grace after a downgrade, and an upgrade keeps what is still there", async () => {
    await seed("member.added", ago(250));
    const settled = later(AUDIT_RETENTION_GRACE_DAYS + 1);
    await run(now);
    await run(settled);

    await sql("UPDATE workspaces SET plan = 'starter' WHERE id = $1", [ws]);
    expect((await run(settled)).expiredObjects).toBe(0);
    const change = (await lifecycleEvents("audit.retention.changed")).at(-1)!.data as Record<string, unknown>;
    expect(change).toMatchObject({ fromMonths: 12, toMonths: 6 });
    expect((await service.getAuditSettings(ws))).toMatchObject({ planRetentionMonths: 6, hotDays: 90, archiveAvailable: true });

    await sql("UPDATE workspaces SET plan = 'growth' WHERE id = $1", [ws]);
    expect((await run(later(AUDIT_RETENTION_GRACE_DAYS + 40))).expiredObjects).toBe(0);
    expect(await exported({ types: ["member.*"] })).toHaveLength(1);

    await sql("UPDATE workspaces SET plan = 'starter' WHERE id = $1", [ws]);
    await run(later(AUDIT_RETENTION_GRACE_DAYS + 40));
    expect((await run(later(2 * AUDIT_RETENTION_GRACE_DAYS + 41))).expiredObjects).toBe(1);
    expect(await exported({ types: ["member.*"] })).toHaveLength(0);
  });

  it("keeps records a sink has not received in Postgres, and deletes them there when retention ends", async () => {
    await seed("member.added", ago(400));
    await sql(`INSERT INTO audit_sinks (sink_id, workspace_id, name, type, credentials_encrypted, cursor_tx_id, cursor_seq)
      VALUES ('asink_hold', $1, 'hold', 'webhook', 'x', 0, 0)`, [ws]);
    expect((await run(now)).archiveObjects).toBe(0);
    expect(await types("member.")).toEqual(["member.added"]);

    expect((await run(later(AUDIT_RETENTION_GRACE_DAYS + 1))).deleted).toBe(1);
    expect(await types("member.")).toEqual([]);
    expect((await lifecycleEvents("audit.records.expired"))[0].data).toMatchObject({ source: "database", recordCount: 1 });
  });

  it("honours the pause switch and the workspace's own shorter window", async () => {
    await seed("member.added", ago(200));
    await seed("member.updated", ago(40));
    process.env.AUDIT_ARCHIVE_PAUSED = "true";
    await service.updateAuditSettings(ws, { retentionDays: 30 }, { actor: { type: "user", id: "user_admin" }, context: {} });
    const result = await sweepAuditRetention(now, { workspaceIds: [ws], store: bucket.store });
    expect(result).toMatchObject({ archive: "paused", archiveObjects: 0, deleted: 2 });
    expect(bucket.objects.size).toBe(0);
    await sql("DELETE FROM audit_settings WHERE workspace_id = $1", [ws]);
  });

  it("removes a deleted workspace's archive objects", async () => {
    const other = "00000000-0000-4000-8000-00000000d0aa";
    await sql("INSERT INTO workspaces (id, name, slug, plan) VALUES ($1, 'gone', 'ws-gone-2', 'growth')", [other]);
    await writeAuditEvents(db, [{ workspaceId: other, type: "member.added", occurredAt: ago(200) }]);
    await lifecycle.runAuditLifecycle({ now, workspaceIds: [other], store: bucket.store });
    expect(bucket.objects.size).toBe(2);
    await sql("DELETE FROM workspaces WHERE id = $1", [other]);
    expect((await lifecycle.runAuditLifecycle({ now, workspaceIds: [other], store: bucket.store })).orphanObjects).toBe(1);
    expect(bucket.objects.size).toBe(0);
  });
});

describe("Enterprise contracts", () => {
  it("records a contract retention and holds the workspace to it", async () => {
    await sql("UPDATE workspaces SET plan = 'enterprise' WHERE id = $1", [ws]);
    expect(lifecycle.planRetentionMonths({ plan: "enterprise", createdAt: now }, null)).toBe(12);
    expect(await lifecycle.setContractRetention(ws, 36, "ops", "MSA 2026-10")).toEqual({ from: null, to: 36 });
    expect((await service.getAuditSettings(ws)).planRetentionMonths).toBe(36);
    const [event] = await lifecycleEvents("audit.retention.contract_set");
    expect(event.data).toMatchObject({ fromMonths: null, toMonths: 36, reason: "MSA 2026-10" });
    await expect(lifecycle.setContractRetention(ws, 0, "ops", "x")).rejects.toThrow(/1 to 120/);
    expect(lifecycle.planRetentionMonths({ plan: "growth", createdAt: now }, 36)).toBe(12);
  });
});
