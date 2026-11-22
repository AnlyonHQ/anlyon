import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { type AuditEventRow, type AuditSinkRow, auditEvents, auditSinkDeadLetters, auditSinks } from "../../db/schema/audit.ts";
import { createLogger } from "../../lib/logger.ts";
import { isFeatureEnabled } from "../edition/features.ts";
import { toExportEvent } from "./event-schema.ts";
import { AUDIT_FEATURE } from "./recorder.ts";
import { privateNetworkAllowed, sinkTakes, sinkTarget } from "./service.ts";
import { BATCH_SIZE, IDLE_DELAY_MS } from "./sinks/config.ts";
import { type Fetcher, type SendResult, sendToSink } from "./sinks/send.ts";

const logger = createLogger({ module: "audit-delivery" });

export const MAX_ATTEMPTS = 12;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const LEASE_MS = 2 * 60_000;
const SINKS_PER_SWEEP = 25;
const SINK_CONCURRENCY = 8;
const MAX_BATCHES_PER_SINK = 5;
const IDLE_POLL_MS = 10_000;

export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
  return Math.round(base * (1 - 0.2 * random()));
}

export type FailurePlan =
  | { kind: "retry"; attempts: number; nextAttemptAt: Date }
  | { kind: "dead_letter"; attempts: number; nextAttemptAt: Date };

export function planAfterFailure(previousAttempts: number, now: Date, random?: () => number): FailurePlan {
  const attempts = previousAttempts + 1;
  if (attempts >= MAX_ATTEMPTS) return { kind: "dead_letter", attempts, nextAttemptAt: now };
  return { kind: "retry", attempts, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts, random)) };
}

export async function readBatch(sink: Pick<AuditSinkRow, "workspaceId" | "cursorTxId" | "cursorSeq" | "type">): Promise<AuditEventRow[]> {
  return db
    .select()
    .from(auditEvents)
    .where(and(
      eq(auditEvents.workspaceId, sink.workspaceId),
      sql`(${auditEvents.txId}, ${auditEvents.seq}) > (${sink.cursorTxId}, ${sink.cursorSeq})`,
      sql`${auditEvents.txId} < (pg_snapshot_xmin(pg_current_snapshot())::text)::bigint`,
    ))
    .orderBy(asc(auditEvents.txId), asc(auditEvents.seq))
    .limit(BATCH_SIZE[sink.type]);
}

async function leaseDueSinks(token: string): Promise<AuditSinkRow[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: auditSinks.id })
      .from(auditSinks)
      .where(and(
        eq(auditSinks.enabled, true),
        lte(auditSinks.nextAttemptAt, sql`now()`),
        or(isNull(auditSinks.leaseUntil), lt(auditSinks.leaseUntil, sql`now()`)),
      ))
      .orderBy(asc(auditSinks.nextAttemptAt))
      .limit(SINKS_PER_SWEEP)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    const leased: AuditSinkRow[] = [];
    for (const { id } of due) {
      const [row] = await tx
        .update(auditSinks)
        .set({ leaseToken: token, leaseUntil: sql`now() + ${`${LEASE_MS} milliseconds`}::interval` })
        .where(eq(auditSinks.id, id))
        .returning();
      if (row) leased.push(row);
    }
    return leased;
  });
}

async function updateLeased(sink: AuditSinkRow, token: string, set: Partial<typeof auditSinks.$inferInsert>): Promise<boolean> {
  const rows = await db
    .update(auditSinks)
    .set(set)
    .where(and(eq(auditSinks.id, sink.id), eq(auditSinks.leaseToken, token)))
    .returning({ id: auditSinks.id });
  return rows.length > 0;
}

async function renewLease(sink: AuditSinkRow, token: string): Promise<boolean> {
  return updateLeased(sink, token, { leaseUntil: new Date(Date.now() + LEASE_MS) });
}

export interface SinkRunResult {
  sinkId: string;
  delivered: number;
  batches: number;
  failed: boolean;
  deadLettered: boolean;
}

export async function deliverSink(
  leased: AuditSinkRow,
  token: string,
  deps: { fetcher?: Fetcher; send?: typeof sendToSink; now?: () => Date } = {},
): Promise<SinkRunResult> {
  const send = deps.send ?? sendToSink;
  const now = deps.now ?? (() => new Date());
  const result: SinkRunResult = { sinkId: leased.sinkId, delivered: 0, batches: 0, failed: false, deadLettered: false };
  let sink = leased;
  const target = sinkTarget(sink);
  const allowPrivateNetwork = await privateNetworkAllowed(sink.workspaceId);

  for (let i = 0; i < MAX_BATCHES_PER_SINK; i++) {
    if (!(await renewLease(sink, token))) return result;
    const rows = await readBatch(sink);
    if (rows.length === 0) {
      await updateLeased(sink, token, { nextAttemptAt: new Date(now().getTime() + IDLE_POLL_MS), leaseToken: null, leaseUntil: null });
      return result;
    }
    const last = rows[rows.length - 1];
    const events = rows.filter((row) => sinkTakes(sink, row)).map(toExportEvent);
    const attemptAt = now();
    const sent: SendResult = events.length === 0
      ? { ok: true, status: null, error: null, durationMs: 0 }
      : await send(target, events, { batchId: `${rows[0].eventId}-${rows.length}`, fetcher: deps.fetcher, allowPrivateNetwork });
    result.batches += 1;

    if (sent.ok) {
      const full = rows.length >= BATCH_SIZE[sink.type];
      const set = {
        cursorTxId: last.txId,
        cursorSeq: last.seq,
        attempts: 0,
        lastError: null,
        lastAttemptAt: events.length > 0 ? attemptAt : sink.lastAttemptAt,
        lastSuccessAt: events.length > 0 ? attemptAt : sink.lastSuccessAt,
        deliveredCount: sink.deliveredCount + events.length,
      };
      if (!(await updateLeased(sink, token, set))) return result;
      sink = { ...sink, ...set };
      result.delivered += events.length;
      if (!full) {
        await updateLeased(sink, token, {
          nextAttemptAt: new Date(attemptAt.getTime() + (IDLE_DELAY_MS[sink.type] || IDLE_POLL_MS)),
          leaseToken: null,
          leaseUntil: null,
        });
        return result;
      }
      continue;
    }

    result.failed = true;
    const plan = planAfterFailure(sink.attempts, attemptAt);
    if (plan.kind === "dead_letter") {
      await db.transaction(async (tx) => {
        const [moved] = await tx
          .update(auditSinks)
          .set({
            cursorTxId: last.txId,
            cursorSeq: last.seq,
            attempts: 0,
            lastError: sent.error,
            lastAttemptAt: attemptAt,
            nextAttemptAt: plan.nextAttemptAt,
            leaseToken: null,
            leaseUntil: null,
          })
          .where(and(eq(auditSinks.id, sink.id), eq(auditSinks.leaseToken, token)))
          .returning({ id: auditSinks.id });
        if (!moved) return;
        await tx.insert(auditSinkDeadLetters).values({
          workspaceId: sink.workspaceId,
          sinkId: sink.id,
          fromTxId: rows[0].txId,
          fromSeq: rows[0].seq,
          toTxId: last.txId,
          toSeq: last.seq,
          eventCount: events.length,
          firstEventId: rows[0].eventId,
          lastEventId: last.eventId,
          attempts: plan.attempts,
          lastError: sent.error,
        });
      });
      result.deadLettered = true;
      logger.warn({ sinkId: sink.sinkId, events: events.length, error: sent.error }, "Audit batch dead-lettered");
      return result;
    }
    await updateLeased(sink, token, {
      attempts: plan.attempts,
      lastError: sent.error,
      lastAttemptAt: attemptAt,
      nextAttemptAt: plan.nextAttemptAt,
      leaseToken: null,
      leaseUntil: null,
    });
    logger.info({ sinkId: sink.sinkId, attempts: plan.attempts, error: sent.error }, "Audit delivery failed; will retry");
    return result;
  }

  await updateLeased(sink, token, { nextAttemptAt: now(), leaseToken: null, leaseUntil: null });
  return result;
}

async function deliverLeasedSink(sink: AuditSinkRow, token: string): Promise<SinkRunResult | null> {
  try {
    return await deliverSink(sink, token);
  } catch (error) {
    const plan = planAfterFailure(sink.attempts, new Date());
    const message = error instanceof Error ? error.message : String(error);
    await updateLeased(sink, token, {
      attempts: Math.min(plan.attempts, MAX_ATTEMPTS - 1),
      lastError: `Delivery could not run: ${message}`,
      lastAttemptAt: new Date(),
      nextAttemptAt: plan.kind === "retry" ? plan.nextAttemptAt : new Date(Date.now() + MAX_BACKOFF_MS),
      leaseToken: null,
      leaseUntil: null,
    }).catch(() => undefined);
    logger.error({ sinkId: sink.sinkId, error: message }, "Audit delivery run failed");
    return null;
  }
}

let sweepInFlight = false;

export async function deliverDueAuditSinks(): Promise<SinkRunResult[]> {
  if (!isFeatureEnabled(AUDIT_FEATURE)) return [];
  if (sweepInFlight) return [];
  sweepInFlight = true;
  try {
    const token = randomUUID();
    const leased = await leaseDueSinks(token);
    const results: SinkRunResult[] = [];
    let next = 0;
    const worker = async () => {
      while (next < leased.length) {
        const sink = leased[next++];
        const result = await deliverLeasedSink(sink, token);
        if (result) results.push(result);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SINK_CONCURRENCY, leased.length) }, worker));
    return results;
  } finally {
    sweepInFlight = false;
  }
}
