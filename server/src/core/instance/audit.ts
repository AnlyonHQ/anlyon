import { randomUUID } from "node:crypto";
import { workspaces } from "../../db/schema/workspaces.ts";
import type { db } from "../../db/index.ts";
import type { StoredAuditContext } from "../audit/event-schema.ts";
import { AUDIT_FEATURE, auditEventId, type AuditRecordInput } from "../audit/outbox.ts";
import { isFeatureEnabled } from "../edition/features.ts";

type Reader = Pick<typeof db, "select">;

export async function instanceAuditRecords(
  reader: Reader,
  type: string,
  actorUserId: string | null,
  data: Record<string, unknown>,
  context?: StoredAuditContext,
): Promise<AuditRecordInput[]> {
  if (!isFeatureEnabled(AUDIT_FEATURE)) return [];
  const rows = await reader.select({ id: workspaces.id }).from(workspaces);
  const change = randomUUID();
  return rows.map(({ id }) => ({
    workspaceId: id,
    type,
    eventId: auditEventId(`instance:${change}:${id}`),
    actor: actorUserId ? { type: "user", id: actorUserId } : { type: "system", id: null },
    resource: { type: "instance", id: "instance" },
    data,
    ...(context ? { context } : {}),
  }));
}
