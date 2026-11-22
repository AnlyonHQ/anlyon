import { db } from "../../db/index.ts";
import { auditEvents, type NewAuditEventRow } from "../../db/schema/audit.ts";
import { createLogger } from "../../lib/logger.ts";
import { isFeatureEnabled } from "../edition/features.ts";
import { isAuditedPlatformEvent } from "./event-schema.ts";
import { AUDIT_FEATURE, type AuditRecordInput, buildAuditRow } from "./outbox.ts";

export { AUDIT_FEATURE, type AuditRecordInput, generateAuditEventId } from "./outbox.ts";

const logger = createLogger({ module: "audit-recorder" });

const FLUSH_INTERVAL_MS = 200;
const MAX_BATCH = 200;
const MAX_BUFFERED = 10_000;
const RETRY_DELAY_MS = 2_000;

let buffer: NewAuditEventRow[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;
let dropped = 0;

export function recordAuditEvent(input: AuditRecordInput): string | null {
  try {
    if (!isFeatureEnabled(AUDIT_FEATURE)) return null;
    const row = buildAuditRow(input);
    enqueue(row);
    return row.eventId;
  } catch (error) {
    logger.warn({ type: input.type, error: error instanceof Error ? error.message : error }, "Audit record not queued");
    return null;
  }
}

export function recordPlatformEvent(workspaceId: string, type: string, data: Record<string, unknown>): void {
  if (!isAuditedPlatformEvent(type)) return;
  const { environmentId, endUserId, ...rest } = data;
  recordAuditEvent({
    workspaceId,
    environmentId: typeof environmentId === "string" ? environmentId : null,
    endUserId: typeof endUserId === "string" ? endUserId : null,
    type,
    data: rest,
  });
}

function enqueue(row: NewAuditEventRow): void {
  buffer.push(row);
  if (buffer.length > MAX_BUFFERED) {
    const excess = buffer.length - MAX_BUFFERED;
    buffer.splice(0, excess);
    dropped += excess;
    logger.error({ dropped: excess, totalDropped: dropped }, "Audit buffer full; oldest records dropped");
  }
  if (buffer.length >= MAX_BATCH) {
    void flushAuditEvents();
  } else {
    schedule(FLUSH_INTERVAL_MS);
  }
}

function schedule(delayMs: number): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushAuditEvents();
  }, delayMs);
  timer.unref?.();
}

export async function flushAuditEvents(): Promise<void> {
  if (flushing) {
    await flushing;
    if (buffer.length === 0) return;
  }
  flushing = (async () => {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, MAX_BATCH);
      try {
        await db.insert(auditEvents).values(batch).onConflictDoNothing({ target: auditEvents.eventId });
      } catch (error) {
        buffer = [...batch, ...buffer];
        logger.warn({ count: batch.length, error: error instanceof Error ? error.message : error }, "Audit flush failed; will retry");
        if (timer) clearTimeout(timer);
        timer = null;
        schedule(RETRY_DELAY_MS);
        return;
      }
    }
  })();
  try {
    await flushing;
  } finally {
    flushing = null;
  }
}

export function pendingAuditEventsForTest(): NewAuditEventRow[] {
  return [...buffer];
}

export function resetAuditRecorderForTest(): void {
  buffer = [];
  if (timer) clearTimeout(timer);
  timer = null;
  flushing = null;
  dropped = 0;
}
