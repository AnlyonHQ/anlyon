import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type { db } from "../../db/index.ts";
import { auditEvents, type NewAuditEventRow } from "../../db/schema/audit.ts";
import { isFeatureEnabled } from "../edition/features.ts";
import {
  type AuditActor,
  type AuditResource,
  type StoredAuditContext,
  categoryOf,
  outcomeOf,
  resourceOf,
} from "./event-schema.ts";

export const AUDIT_FEATURE = "audit_streaming";

export interface AuditRecordInput {
  workspaceId: string;
  environmentId?: string | null;
  type: string;
  actor?: AuditActor;
  resource?: AuditResource | null;
  outcome?: string | null;
  data?: Record<string, unknown>;
  context?: StoredAuditContext | null;
  occurredAt?: Date;
  eventId?: string;
  backfilled?: boolean;
  endUserId?: string | null;
}

export type AuditWriter = Pick<typeof db, "insert">;

export function generateAuditEventId(): string {
  return `aud_${nanoid(24)}`;
}

export function auditEventId(sourceKey: string): string {
  return `aud_${createHash("sha256").update(sourceKey).digest("base64url").slice(0, 24)}`;
}

export function buildAuditRow(input: AuditRecordInput): NewAuditEventRow {
  const data = input.data ?? {};
  const resource = input.resource === undefined ? resourceOf(input.type, data) : input.resource;
  const actor = input.actor ?? { type: "system", id: null };
  const context: StoredAuditContext = { ...(input.context ?? {}) };
  if (actor.onBehalfOf) context.onBehalfOf = actor.onBehalfOf;
  return {
    eventId: input.eventId ?? generateAuditEventId(),
    workspaceId: input.workspaceId,
    environmentId: input.environmentId ?? null,
    type: input.type,
    category: categoryOf(input.type),
    outcome: input.outcome === undefined ? outcomeOf(input.type, data) : input.outcome,
    actorType: actor.type,
    actorId: actor.id,
    resourceType: resource?.type ?? null,
    resourceId: resource?.id ?? null,
    data,
    backfilled: input.backfilled ?? false,
    endUserId: input.endUserId ?? null,
    context: Object.keys(context).length > 0 ? context : null,
    occurredAt: input.occurredAt ?? new Date(),
  };
}

export async function writeAuditEvents(writer: AuditWriter, inputs: AuditRecordInput[]): Promise<void> {
  if (inputs.length === 0 || !isFeatureEnabled(AUDIT_FEATURE)) return;
  await writer.insert(auditEvents).values(inputs.map(buildAuditRow)).onConflictDoNothing({ target: auditEvents.eventId });
}
