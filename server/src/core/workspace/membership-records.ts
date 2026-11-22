import type { AuditRecordInput } from "../audit/outbox.ts";
import type { AuditActor, StoredAuditContext } from "../audit/event-schema.ts";
import type { MembershipEvent, MembershipEventSource } from "./membership-audit.ts";

export function membershipRecord(
  event: MembershipEvent,
  fields: {
    workspaceId: string;
    source: MembershipEventSource;
    userId?: string;
    actorUserId?: string;
    [key: string]: unknown;
  },
  options: { actor?: AuditActor; context?: StoredAuditContext; environmentId?: string | null } = {},
): AuditRecordInput {
  const { workspaceId, actorUserId, ...data } = fields;
  const actor: AuditActor = options.actor ?? (actorUserId ? { type: "user", id: actorUserId } : { type: "system", id: null });
  return {
    workspaceId,
    environmentId: options.environmentId ?? null,
    type: event,
    actor,
    context: options.context,
    resource: resourceFor(fields),
    data,
  };
}

function resourceFor(fields: Record<string, unknown>): AuditRecordInput["resource"] {
  const id = (key: string) => (typeof fields[key] === "string" && fields[key] ? (fields[key] as string) : null);
  const userId = id("userId");
  if (userId) return { type: "member", id: userId };
  const groupId = id("groupId");
  if (groupId) return { type: "scim_group", id: groupId };
  const providerId = id("providerId");
  if (providerId) return { type: "sso_connection", id: providerId };
  return null;
}
