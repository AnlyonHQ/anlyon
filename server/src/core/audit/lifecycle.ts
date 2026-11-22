import { and, asc, eq, gte, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { type AuditArchiveRow, type AuditEventRow, auditArchives, auditEvents, auditLifecycle, auditSettings } from "../../db/schema/audit.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { createLogger } from "../../lib/logger.ts";
import { AUDIT_RETENTION_GRACE_DAYS, getPlanLimits, normalizePlan } from "../plans/limits.ts";
import { instanceSetting } from "../instance/settings.ts";
import { AUDIT_HOT_DAYS_DEFAULT } from "../instance/registry.ts";
import { type AuditArchiveStore, auditArchiveStore } from "./archive-store.ts";
import { buildArchive, utcDay } from "./archive-format.ts";
import { type AuditRecordInput, writeAuditEvents } from "./outbox.ts";

const logger = createLogger({ module: "audit-lifecycle" });

export const DELETE_BATCH = 5000;
const MAX_DELETE_BATCHES_PER_WORKSPACE = 20;
export const ARCHIVE_READ_BATCH = 5000;
export const MAX_OBJECTS_PER_RUN = 200;
const MAX_OBJECTS_PER_WORKSPACE = 50;

const SYSTEM = { type: "system" as const, id: null };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function auditHotDays(): number {
  const value = Number(instanceSetting("storage.audit_hot_days"));
  return Number.isInteger(value) && value >= 30 && value <= 365 ? value : AUDIT_HOT_DAYS_DEFAULT;
}

export function auditArchivePaused(): boolean {
  return instanceSetting("storage.audit_archive_paused") === "true";
}

export function monthsBefore(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() - months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
}

export interface RetentionState {
  planRetentionMonths: number | null;
  floorMonths: number | null;
  floorUntil: Date | null;
}

export interface RetentionDecision {
  effectiveMonths: number | null;
  next: RetentionState | null;
  change: { fromMonths: number | null; toMonths: number; takesEffectAt: Date } | null;
}

export function resolveRetention(planMonths: number | null, state: RetentionState | null, now: Date, graceDays = AUDIT_RETENTION_GRACE_DAYS): RetentionDecision {
  if (planMonths === null) return { effectiveMonths: null, next: null, change: null };
  const graceEnds = new Date(now.getTime() + graceDays * 86_400_000);
  const floorActive = (s: RetentionState) => s.floorUntil !== null && s.floorUntil > now;
  const effective = (s: RetentionState) => (floorActive(s) ? (s.floorMonths === null ? null : Math.max(s.floorMonths, planMonths)) : planMonths);

  let next: RetentionState | null = null;
  let change: RetentionDecision["change"] = null;
  const seen = state?.planRetentionMonths ?? null;
  if (!state || seen === null) {
    next = { planRetentionMonths: planMonths, floorMonths: null, floorUntil: graceEnds };
    change = { fromMonths: null, toMonths: planMonths, takesEffectAt: graceEnds };
  } else if (planMonths < seen) {
    const floorMonths = floorActive(state) ? (state.floorMonths === null ? null : Math.max(state.floorMonths, seen)) : seen;
    next = { planRetentionMonths: planMonths, floorMonths, floorUntil: graceEnds };
    change = { fromMonths: seen, toMonths: planMonths, takesEffectAt: graceEnds };
  } else if (planMonths > seen) {
    next = { ...state, planRetentionMonths: planMonths };
    change = { fromMonths: seen, toMonths: planMonths, takesEffectAt: now };
  }
  return { effectiveMonths: effective(next ?? state!), next, change };
}

export function deleteBefore(now: Date, effectiveMonths: number | null, customerDays: number | null): Date | null {
  const cutoffs = [
    effectiveMonths === null ? null : monthsBefore(now, effectiveMonths),
    customerDays ? new Date(now.getTime() - customerDays * 86_400_000) : null,
  ].filter((value): value is Date => value !== null);
  return cutoffs.length === 0 ? null : new Date(Math.max(...cutoffs.map((value) => value.getTime())));
}

export function planRetentionMonths(workspace: { plan: string; createdAt: Date }, contractMonths: number | null): number | null {
  const months = getPlanLimits(workspace.plan, workspace).auditRetentionMonths;
  if (months === "unlimited") return null;
  return normalizePlan(workspace.plan) === "enterprise" && contractMonths ? contractMonths : months;
}

async function removeRecords(tx: Tx, reason: "archive" | "retention", workspaceId: string, seqs: number[]): Promise<void> {
  await tx.execute(sql`select set_config('anlyon.audit_removal', ${reason}, true)`);
  const removed = await tx
    .delete(auditEvents)
    .where(and(eq(auditEvents.workspaceId, workspaceId), inArray(auditEvents.seq, seqs)))
    .returning({ seq: auditEvents.seq });
  if (removed.length !== seqs.length) {
    throw new Error(`Audit lifecycle expected to remove ${seqs.length} records and removed ${removed.length}`);
  }
}

function lifecycleRecord(type: string, workspaceId: string, environmentId: string | null, resource: AuditRecordInput["resource"], data: Record<string, unknown>): AuditRecordInput {
  return { workspaceId, environmentId, type, actor: SYSTEM, resource, data };
}

export interface LifecycleResult {
  workspaces: number;
  archived: number;
  archiveObjects: number;
  deleted: number;
  expiredObjects: number;
  expiredRecords: number;
  orphanObjects: number;
  archive: "available" | "paused" | "unavailable";
}

export interface LifecycleOptions {
  now?: Date;
  workspaceIds?: string[];
  store?: AuditArchiveStore | null;
}

function notHeldBySinks(): SQL {
  return sql`not exists (
    select 1 from audit_sinks s
    where s.workspace_id = ${auditEvents.workspaceId} and s.enabled
      and (s.cursor_tx_id, s.cursor_seq) < (${auditEvents.txId}, ${auditEvents.seq})
  ) and not exists (
    select 1 from audit_sink_dead_letters d join audit_sinks s on s.id = d.sink_id
    where s.workspace_id = ${auditEvents.workspaceId} and d.redelivered_at is null
      and (${auditEvents.txId}, ${auditEvents.seq}) >= (d.from_tx_id, d.from_seq)
      and (${auditEvents.txId}, ${auditEvents.seq}) <= (d.to_tx_id, d.to_seq)
  )`;
}

export async function runAuditLifecycle(options: LifecycleOptions = {}): Promise<LifecycleResult> {
  const now = options.now ?? new Date();
  const paused = auditArchivePaused();
  const configured = options.store === undefined ? auditArchiveStore() : options.store;
  const store = paused ? null : configured;
  const result: LifecycleResult = {
    workspaces: 0, archived: 0, archiveObjects: 0, deleted: 0, expiredObjects: 0, expiredRecords: 0, orphanObjects: 0,
    archive: paused ? "paused" : configured ? "available" : "unavailable",
  };
  const scope = options.workspaceIds?.length ? options.workspaceIds : null;

  if (store) result.orphanObjects = await removeOrphanArchives(store, scope);

  const rows = await db
    .select({
      id: workspaces.id, plan: workspaces.plan, createdAt: workspaces.createdAt,
      customerDays: auditSettings.retentionDays,
      contractMonths: auditLifecycle.contractRetentionMonths,
      planRetentionMonths: auditLifecycle.planRetentionMonths,
      floorMonths: auditLifecycle.floorMonths,
      floorUntil: auditLifecycle.floorUntil,
    })
    .from(workspaces)
    .leftJoin(auditSettings, eq(auditSettings.workspaceId, workspaces.id))
    .leftJoin(auditLifecycle, eq(auditLifecycle.workspaceId, workspaces.id))
    .where(and(
      scope ? inArray(workspaces.id, scope) : undefined,
      sql`(exists (select 1 from audit_events e where e.workspace_id = ${workspaces.id})
        or exists (select 1 from audit_archives a where a.workspace_id = ${workspaces.id} and a.expired_at is null))`,
    ));

  let objectsLeft = MAX_OBJECTS_PER_RUN;
  for (const row of rows) {
    result.workspaces += 1;
    try {
      const months = planRetentionMonths(row, row.contractMonths);
      const state = row.planRetentionMonths === null && row.floorUntil === null && row.floorMonths === null
        ? null
        : { planRetentionMonths: row.planRetentionMonths, floorMonths: row.floorMonths, floorUntil: row.floorUntil };
      const decision = resolveRetention(months, state, now);
      if (decision.next) await recordRetentionChange(row.id, decision);
      const before = deleteBefore(now, decision.effectiveMonths, row.customerDays);

      if (before) {
        result.deleted += await deleteExpiredRecords(row.id, before, decision.effectiveMonths, row.customerDays);
        if (store) {
          const expired = await expireArchives(store, row.id, before, decision.effectiveMonths, row.customerDays);
          result.expiredObjects += expired.objects;
          result.expiredRecords += expired.records;
        }
      }

      if (store && objectsLeft > 0) {
        const hotBefore = startOfUtcDay(new Date(now.getTime() - auditHotDays() * 86_400_000));
        const archived = await archiveWorkspace(store, row.id, hotBefore, before, Math.min(objectsLeft, MAX_OBJECTS_PER_WORKSPACE), now);
        objectsLeft -= archived.objects;
        result.archiveObjects += archived.objects;
        result.archived += archived.records;
      }
    } catch (error) {
      logger.error({ workspaceId: row.id, error: error instanceof Error ? error.message : String(error) }, "Audit lifecycle failed for a workspace; it is retried next run");
    }
  }

  if (result.archived || result.deleted || result.expiredObjects || result.orphanObjects) logger.info(result, "Audit lifecycle run");
  return result;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

async function recordRetentionChange(workspaceId: string, decision: RetentionDecision): Promise<void> {
  const next = decision.next!;
  await db.transaction(async (tx) => {
    await tx.insert(auditLifecycle)
      .values({ workspaceId, ...next, updatedAt: new Date() })
      .onConflictDoUpdate({ target: auditLifecycle.workspaceId, set: { ...next, updatedAt: new Date() } });
    if (decision.change) {
      await writeAuditEvents(tx, [lifecycleRecord("audit.retention.changed", workspaceId, null, { type: "audit_settings", id: workspaceId }, {
        fromMonths: decision.change.fromMonths,
        toMonths: decision.change.toMonths,
        takesEffectAt: decision.change.takesEffectAt.toISOString(),
        graceDays: AUDIT_RETENTION_GRACE_DAYS,
      })]);
    }
  });
}

function retentionData(before: Date, effectiveMonths: number | null, customerDays: number | null) {
  return { before: before.toISOString(), retentionMonths: effectiveMonths, workspaceRetentionDays: customerDays };
}

async function deleteExpiredRecords(workspaceId: string, before: Date, effectiveMonths: number | null, customerDays: number | null): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < MAX_DELETE_BATCHES_PER_WORKSPACE; i++) {
    const batch = await db
      .select({ seq: auditEvents.seq })
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, workspaceId), lt(auditEvents.occurredAt, before)))
      .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.seq))
      .limit(DELETE_BATCH);
    if (batch.length === 0) break;
    const seqs = batch.map((row) => row.seq);
    await db.transaction(async (tx) => {
      await removeRecords(tx, "retention", workspaceId, seqs);
      await writeAuditEvents(tx, [lifecycleRecord("audit.records.expired", workspaceId, null, null, {
        source: "database", recordCount: seqs.length, firstSequence: Math.min(...seqs), lastSequence: Math.max(...seqs),
        ...retentionData(before, effectiveMonths, customerDays),
      })]);
    });
    deleted += seqs.length;
    if (batch.length < DELETE_BATCH) break;
  }
  return deleted;
}

async function expireArchives(store: AuditArchiveStore, workspaceId: string, before: Date, effectiveMonths: number | null, customerDays: number | null) {
  const due = await db
    .select()
    .from(auditArchives)
    .where(and(eq(auditArchives.workspaceId, workspaceId), isNull(auditArchives.expiredAt), lt(auditArchives.lastOccurredAt, before)))
    .orderBy(asc(auditArchives.lastOccurredAt))
    .limit(MAX_OBJECTS_PER_WORKSPACE);
  let records = 0;
  for (const archive of due) {
    await store.delete(archive.objectKey);
    await store.delete(archive.manifestKey);
    await db.transaction(async (tx) => {
      await tx.update(auditArchives).set({ expiredAt: new Date() }).where(eq(auditArchives.id, archive.id));
      await writeAuditEvents(tx, [lifecycleRecord("audit.records.expired", workspaceId, archive.environmentId, { type: "audit_archive", id: archive.id }, {
        source: "archive", archiveId: archive.id, day: archive.day, recordCount: archive.recordCount,
        firstSequence: archive.firstSeq, lastSequence: archive.lastSeq, sha256: archive.sha256,
        ...retentionData(before, effectiveMonths, customerDays),
      })]);
    });
    records += archive.recordCount;
  }
  return { objects: due.length, records };
}

async function archiveWorkspace(store: AuditArchiveStore, workspaceId: string, hotBefore: Date, before: Date | null, maxObjects: number, now: Date) {
  let objects = 0;
  let records = 0;
  while (objects < maxObjects) {
    const batch = await db
      .select()
      .from(auditEvents)
      .where(and(
        eq(auditEvents.workspaceId, workspaceId),
        lt(auditEvents.occurredAt, hotBefore),
        before ? gte(auditEvents.occurredAt, before) : undefined,
        notHeldBySinks(),
      ))
      .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.seq))
      .limit(ARCHIVE_READ_BATCH);
    if (batch.length === 0) break;
    const groups = new Map<string, AuditEventRow[]>();
    for (const row of batch) {
      const key = `${row.environmentId ?? "workspace"}|${utcDay(row.occurredAt)}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const group of groups.values()) {
      if (objects >= maxObjects) break;
      await archiveGroup(store, workspaceId, group, now);
      objects += 1;
      records += group.length;
    }
    if (batch.length < ARCHIVE_READ_BATCH) break;
  }
  return { objects, records };
}

async function archiveGroup(store: AuditArchiveStore, workspaceId: string, rows: AuditEventRow[], now: Date): Promise<AuditArchiveRow> {
  const { body, manifest, keys } = buildArchive(rows, now);
  await store.put(keys.objectKey, body, "application/gzip", { sha256: manifest.sha256, "content-sha256": manifest.contentSha256, records: String(manifest.recordCount) });
  await store.put(keys.manifestKey, Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), "application/json");
  const landed = await store.head(keys.objectKey);
  if (!landed || landed.sizeBytes !== body.length) {
    throw new Error(`Audit archive object did not land intact (expected ${body.length} bytes, found ${landed?.sizeBytes ?? "none"})`);
  }
  return db.transaction(async (tx) => {
    const [archive] = await tx.insert(auditArchives).values({
      workspaceId,
      environmentId: manifest.environmentId,
      day: manifest.day,
      objectKey: keys.objectKey,
      manifestKey: keys.manifestKey,
      recordCount: manifest.recordCount,
      firstSeq: manifest.firstSequence,
      lastSeq: manifest.lastSequence,
      firstOccurredAt: new Date(manifest.firstOccurredAt),
      lastOccurredAt: new Date(manifest.lastOccurredAt),
      sizeBytes: manifest.sizeBytes,
      sha256: manifest.sha256,
      contentSha256: manifest.contentSha256,
    }).onConflictDoUpdate({
      target: auditArchives.objectKey,
      set: { sizeBytes: manifest.sizeBytes, sha256: manifest.sha256, contentSha256: manifest.contentSha256, recordCount: manifest.recordCount, expiredAt: null },
    }).returning();
    await removeRecords(tx, "archive", workspaceId, rows.map((row) => row.seq));
    await writeAuditEvents(tx, [lifecycleRecord("audit.records.archived", workspaceId, manifest.environmentId, { type: "audit_archive", id: archive.id }, {
      archiveId: archive.id, day: manifest.day, recordCount: manifest.recordCount,
      firstSequence: manifest.firstSequence, lastSequence: manifest.lastSequence,
      firstOccurredAt: manifest.firstOccurredAt, lastOccurredAt: manifest.lastOccurredAt,
      sha256: manifest.sha256, contentSha256: manifest.contentSha256, sizeBytes: manifest.sizeBytes,
    })]);
    return archive;
  });
}

async function removeOrphanArchives(store: AuditArchiveStore, scope: string[] | null): Promise<number> {
  const orphans = await db
    .select()
    .from(auditArchives)
    .where(and(
      scope ? inArray(auditArchives.workspaceId, scope) : undefined,
      sql`not exists (select 1 from workspaces w where w.id = ${auditArchives.workspaceId})`,
    ))
    .limit(MAX_OBJECTS_PER_RUN);
  for (const archive of orphans) {
    if (!archive.expiredAt) {
      await store.delete(archive.objectKey);
      await store.delete(archive.manifestKey);
    }
    await db.delete(auditArchives).where(eq(auditArchives.id, archive.id));
  }
  if (orphans.length > 0) logger.info({ objects: orphans.length }, "Removed audit archive objects of deleted workspaces");
  return orphans.length;
}

export async function setContractRetention(workspaceId: string, months: number | null, actor: string, reason: string): Promise<{ from: number | null; to: number | null }> {
  if (months !== null && (!Number.isInteger(months) || months < 1 || months > 120)) {
    throw new Error("A contract's audit retention is 1 to 120 months.");
  }
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(auditLifecycle).where(eq(auditLifecycle.workspaceId, workspaceId));
    const from = existing?.contractRetentionMonths ?? null;
    await tx.insert(auditLifecycle)
      .values({ workspaceId, contractRetentionMonths: months, contractSetBy: actor, updatedAt: new Date() })
      .onConflictDoUpdate({ target: auditLifecycle.workspaceId, set: { contractRetentionMonths: months, contractSetBy: actor, updatedAt: new Date() } });
    await writeAuditEvents(tx, [{
      ...lifecycleRecord("audit.retention.contract_set", workspaceId, null, { type: "audit_settings", id: workspaceId }, {
        fromMonths: from, toMonths: months, reason, source: "scripts/set-audit-retention.ts",
      }),
      actor: { type: "system", id: actor },
    }]);
    return { from, to: months };
  });
}

export async function retentionView(workspaceId: string, now: Date = new Date()) {
  const [row] = await db
    .select({ plan: workspaces.plan, createdAt: workspaces.createdAt, contractMonths: auditLifecycle.contractRetentionMonths,
      floorMonths: auditLifecycle.floorMonths, floorUntil: auditLifecycle.floorUntil })
    .from(workspaces)
    .leftJoin(auditLifecycle, eq(auditLifecycle.workspaceId, workspaces.id))
    .where(eq(workspaces.id, workspaceId));
  const months = row ? planRetentionMonths(row, row.contractMonths) : null;
  const graceUntil = row?.floorUntil && row.floorUntil > now ? row.floorUntil.toISOString() : null;
  return {
    planRetentionMonths: months,
    retentionGraceUntil: months === null ? null : graceUntil,
    hotDays: auditHotDays(),
    archiveAvailable: auditArchiveStore() !== null,
  };
}
