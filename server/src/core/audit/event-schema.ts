import type { AuditEventRow } from "../../db/schema/audit.ts";

export const AUDIT_SCHEMA = "anlyon.audit.v1" as const;

export type AuditCategory =
  | "approval"
  | "invocation"
  | "policy"
  | "action"
  | "access"
  | "environment"
  | "connection"
  | "limit"
  | "audit";

export type AuditActorType = "user" | "api_key" | "oauth_client" | "assistant" | "policy" | "system";

export interface AuditActor {
  type: AuditActorType;
  id: string | null;
  onBehalfOf?: string | null;
}

export interface AuditResource {
  type: string;
  id: string;
}

export interface AuditExportEvent {
  schema: typeof AUDIT_SCHEMA;
  id: string;
  sequence: number;
  type: string;
  category: AuditCategory;
  occurredAt: string;
  workspaceId: string;
  environmentId: string | null;
  actor: AuditActor;
  resource: AuditResource | null;
  outcome: string | null;
  data: Record<string, unknown>;
  context: { requestId?: string; ip?: string; userAgent?: string } | null;
  test?: true;
  backfilled?: true;
  endUserId?: string;
}

export const AUDIT_EVENT_TYPES: Record<AuditCategory, readonly string[]> = {
  approval: ["approval.requested", "approval.vote", "approval.approved", "approval.denied", "approval.expired"],
  invocation: [
    "action.succeeded", "action.failed", "action.unknown", "action.denied", "action.expired", "action.resolved",
    "function.run_finished", "function.run_planned", "function.run_applied", "function.run_diverged",
  ],
  policy: [
    "policy.created", "policy.updated", "policy.deleted",
    "sign_off.requested", "sign_off.approved", "sign_off.rejected", "sign_off.expired", "sign_off.cancelled", "sign_off.failed",
  ],
  action: [
    "action.definition.created", "action.definition.updated", "action.definition.deleted",
    "function.created", "function.version_published", "function.deleted",
    "mcp_upstream.registered", "mcp_upstream.refreshed", "mcp_upstream.archived", "mcp_upstream.tools_changed",
  ],
  access: [
    "api_key.created", "api_key.revoked", "api_key.deleted", "api_key.regenerated", "api_key.rolled_back",
    "member.added", "member.role_changed", "member.removed", "member.left", "workspace.ownership_transferred",
    "member.emergency_access_granted", "member.emergency_access_removed",
    "invitation.created", "invitation.cancelled", "invitation.accepted",
    "member.environment_role_granted", "member.environment_role_removed",
    "member.provisioned", "member.deactivated", "member.reactivated", "member.deprovisioned",
    "member.profile_updated", "group.created", "group.updated", "group.deleted",
    "sso.connection_created", "sso.connection_deleted", "sso.domains_verified", "sso.settings_updated",
    "scim.token_created", "scim.token_revoked", "scim.role_mappings_replaced", "scim.settings_updated",
    "instance.setup_completed", "instance.settings_updated", "instance.admin_granted", "instance.admin_revoked",
    "instance.root_key_backup_confirmed",
    "workspace.plan_set", "workspace.billing_refund_created", "workspace.billing_dispute_created",
    "workspace.defaults_updated",
  ],
  environment: ["environment.halted", "environment.resumed"],
  connection: [
    "secret.connected", "secret.connect_started", "secret.reconnect_started", "secret.reconnected",
    "secret.disconnected", "secret.needs_reauth",
    "end_user.connected", "end_user.disconnected", "end_user.connection_refused", "end_user.erased",
    "end_user.session_created",
  ],
  limit: ["impact_limit.created", "impact_limit.updated", "impact_limit.archived", "budget.updated", "budget.removed", "budget.alert"],
  audit: [
    "audit.sink.created", "audit.sink.updated", "audit.sink.deleted", "audit.settings.updated",
    "audit.dead_letter.redelivered", "audit.export.created", "audit.test",
    "audit.records.archived", "audit.records.expired", "audit.retention.changed", "audit.retention.contract_set",
  ],
};

export function categoryOf(type: string): AuditCategory {
  if (type.startsWith("action.definition.")) return "action";
  if (type.startsWith("action.")) return "invocation";
  if (type.startsWith("function.run_")) return "invocation";
  if (type.startsWith("function.")) return "action";
  if (type.startsWith("mcp_upstream.")) return "action";
  if (type.startsWith("approval.")) return "approval";
  if (type.startsWith("policy.") || type.startsWith("sign_off.")) return "policy";
  if (type.startsWith("api_key.") || type.startsWith("member.") || type.startsWith("invitation.") || type.startsWith("workspace.") || type.startsWith("instance.")) return "access";
  if (type.startsWith("group.") || type.startsWith("sso.") || type.startsWith("scim.")) return "access";
  if (type.startsWith("environment.")) return "environment";
  if (type.startsWith("secret.") || type.startsWith("end_user.")) return "connection";
  if (type.startsWith("impact_limit.") || type.startsWith("budget.")) return "limit";
  return "audit";
}

export function isAuditedPlatformEvent(type: string): boolean {
  return type.startsWith("secret.") || type === "budget.alert";
}

export function outcomeOf(type: string, data: Record<string, unknown>): string | null {
  switch (type) {
    case "approval.approved":
      return "approved";
    case "approval.denied":
      return "denied";
    case "approval.expired":
      return "expired";
    case "approval.requested":
      return "pending";
    case "approval.vote":
      return typeof data.decision === "string" ? data.decision : null;
    case "action.invocation.blocked":
      return "blocked";
    case "action.resolved":
      return typeof data.outcome === "string" ? data.outcome : null;
  }
  if (type.startsWith("action.") && !type.startsWith("action.definition.")) {
    return type.slice("action.".length);
  }
  return null;
}

export function resourceOf(type: string, data: Record<string, unknown>): AuditResource | null {
  const id = (key: string) => (typeof data[key] === "string" && data[key] ? (data[key] as string) : null);
  if (type.startsWith("approval.")) {
    const approvalId = id("approvalId");
    return approvalId ? { type: "approval", id: approvalId } : null;
  }
  if (type.startsWith("action.")) {
    const invocationId = id("invocationId");
    if (invocationId) return { type: "invocation", id: invocationId };
    const actionId = id("actionId");
    return actionId ? { type: "action", id: actionId } : null;
  }
  if (type.startsWith("secret.")) {
    const name = id("secretName");
    return name ? { type: "secret", id: name } : null;
  }
  if (type === "budget.alert") {
    const keyId = id("apiKeyId");
    return keyId ? { type: "api_key", id: keyId } : null;
  }
  return null;
}

export type StoredAuditContext = {
  requestId?: string;
  ip?: string;
  userAgent?: string;
  onBehalfOf?: string;
};

export function toExportEvent(row: AuditEventRow): AuditExportEvent {
  const { onBehalfOf, ...request } = (row.context ?? {}) as StoredAuditContext;
  return {
    schema: AUDIT_SCHEMA,
    id: row.eventId,
    sequence: row.seq,
    type: row.type,
    category: row.category as AuditCategory,
    occurredAt: row.occurredAt.toISOString(),
    workspaceId: row.workspaceId,
    environmentId: row.environmentId,
    actor: {
      type: row.actorType as AuditActorType,
      id: row.actorId,
      ...(onBehalfOf ? { onBehalfOf } : {}),
    },
    resource: row.resourceType && row.resourceId ? { type: row.resourceType, id: row.resourceId } : null,
    outcome: row.outcome,
    data: row.data ?? {},
    context: Object.keys(request).length > 0 ? request : null,
    ...(row.backfilled ? { backfilled: true as const } : {}),
    ...(row.endUserId ? { endUserId: row.endUserId } : {}),
  };
}

export const AUDIT_EVENT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://anlyon.com/schemas/audit/v1.json",
  title: "Anlyon audit event v1",
  type: "object",
  required: ["schema", "id", "sequence", "type", "category", "occurredAt", "workspaceId", "environmentId", "actor", "resource", "outcome", "data", "context"],
  properties: {
    schema: { const: AUDIT_SCHEMA },
    id: { type: "string", pattern: "^aud_", description: "Stable across retries, redeliveries and sinks. Deduplicate on this." },
    sequence: { type: "integer", description: "Orders records within one deployment. Not a dedup key." },
    type: { type: "string", examples: ["approval.vote", "action.succeeded", "policy.updated"] },
    category: { enum: Object.keys(AUDIT_EVENT_TYPES) },
    occurredAt: { type: "string", format: "date-time" },
    workspaceId: { type: "string", format: "uuid" },
    environmentId: { type: ["string", "null"], format: "uuid" },
    endUserId: { type: "string", description: "The developer's end user the act was for, when it was for one. erased~<hash> once that end user is erased." },
    actor: {
      type: "object",
      required: ["type", "id"],
      properties: {
        type: { enum: ["user", "api_key", "oauth_client", "assistant", "policy", "system"] },
        id: { type: ["string", "null"] },
        onBehalfOf: { type: ["string", "null"] },
      },
    },
    resource: {
      type: ["object", "null"],
      required: ["type", "id"],
      properties: { type: { type: "string" }, id: { type: "string" } },
    },
    outcome: { type: ["string", "null"] },
    data: { type: "object" },
    context: {
      type: ["object", "null"],
      properties: { requestId: { type: "string" }, ip: { type: "string" }, userAgent: { type: "string" } },
    },
    test: { const: true },
    backfilled: { const: true, description: "Created from history by the one-time backfill, with the original time." },
  },
} as const;
