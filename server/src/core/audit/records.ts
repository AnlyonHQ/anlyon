import type { ActionInvocation, InvocationResolution } from "../../db/schema/actions.ts";
import type { Approval, ApprovalDecision, approvalPolicyVersions } from "../../db/schema/approvals.ts";
import type { Environment } from "../../db/schema/environments.ts";
import type { AuditActor, StoredAuditContext } from "./event-schema.ts";
import { haltActor } from "./actors.ts";
import { type AuditRecordInput, auditEventId } from "./outbox.ts";

type PolicyVersion = typeof approvalPolicyVersions.$inferSelect;

export const RECORDED_INVOCATION_STATUSES = ["succeeded", "failed", "unknown", "denied", "expired"] as const;

type ApprovalActorFields = Pick<
  Approval,
  "requestedByKeyId" | "requestedByUserId" | "requestedByOAuthClientId" | "decidedByUserId" | "decidedByKeyId" | "decisionOrigin" | "matchedPolicyId"
>;

export function approvalActor(type: string, approval: ApprovalActorFields): AuditActor {
  if (type === "approval.requested") {
    if (approval.requestedByOAuthClientId) {
      return { type: "oauth_client", id: approval.requestedByOAuthClientId, onBehalfOf: approval.requestedByUserId };
    }
    if (approval.requestedByKeyId) return { type: "api_key", id: approval.requestedByKeyId };
    if (approval.requestedByUserId) return { type: "user", id: approval.requestedByUserId };
    return { type: "system", id: null };
  }
  if (type === "approval.expired") return { type: "system", id: null };
  switch (approval.decisionOrigin) {
    case "policy":
      return { type: "policy", id: approval.matchedPolicyId };
    case "assistant":
      return { type: "assistant", id: null };
    case "human":
      if (approval.decidedByKeyId) return { type: "api_key", id: approval.decidedByKeyId };
      if (approval.decidedByUserId) return { type: "user", id: approval.decidedByUserId };
      return { type: "system", id: null };
    default:
      return { type: "system", id: null };
  }
}

function approvalData(row: Approval): Record<string, unknown> {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  return {
    approvalId: row.approvalId,
    kind: row.kind,
    title: row.title,
    ...(typeof payload.actionName === "string" ? { actionName: payload.actionName } : {}),
    ...(typeof payload.actionId === "string" ? { actionId: payload.actionId } : {}),
    ...(typeof payload.invocationId === "string" ? { invocationId: payload.invocationId } : {}),
    approval: {
      status: row.status,
      decisionOrigin: row.decisionOrigin,
      decisionNote: row.decisionNote,
      matchedPolicyId: row.matchedPolicyId,
      matchedPolicyVersion: row.matchedPolicyVersion,
      policyExplanation: row.policyExplanation,
      requiredApprovals: row.requiredApprovals,
      approvedCount: row.approvedCount,
      previewId: row.previewId,
      bindingDigest: row.bindingDigest,
      expiresAt: row.expiresAt.toISOString(),
    },
  };
}

export function approvalRequestedRecord(row: Approval, extra: Partial<AuditRecordInput> = {}): AuditRecordInput {
  return {
    eventId: auditEventId(`approval:${row.id}:requested`),
    workspaceId: row.workspaceId,
    environmentId: row.environmentId,
    type: "approval.requested",
    endUserId: row.endUserId,
    actor: approvalActor("approval.requested", row),
    resource: { type: "approval", id: row.approvalId },
    data: approvalData(row),
    occurredAt: row.createdAt,
    ...extra,
  };
}

export function approvalDecidedRecord(row: Approval, extra: Partial<AuditRecordInput> = {}): AuditRecordInput | null {
  if (row.status === "pending") return null;
  const type = `approval.${row.status}`;
  return {
    eventId: auditEventId(`approval:${row.id}:${row.status}`),
    workspaceId: row.workspaceId,
    environmentId: row.environmentId,
    type,
    endUserId: row.endUserId,
    actor: approvalActor(type, row),
    resource: { type: "approval", id: row.approvalId },
    data: approvalData(row),
    occurredAt: row.decidedAt ?? row.createdAt,
    ...extra,
  };
}

export function approvalVoteRecord(
  approval: Approval,
  decision: Pick<ApprovalDecision, "id" | "decision" | "note" | "decidedAt" | "deciderKeyId" | "deciderUserId" | "selfApproved">,
  actor: AuditActor,
  extra: Partial<AuditRecordInput> = {},
): AuditRecordInput {
  return {
    eventId: auditEventId(`approval_decision:${decision.id}`),
    workspaceId: approval.workspaceId,
    environmentId: approval.environmentId,
    type: "approval.vote",
    endUserId: approval.endUserId,
    actor,
    resource: { type: "approval", id: approval.approvalId },
    data: {
      approvalId: approval.approvalId,
      decision: decision.decision,
      note: decision.note ?? null,
      selfApproved: decision.selfApproved,
      status: approval.status,
      approvedCount: approval.approvedCount,
      requiredApprovals: approval.requiredApprovals,
    },
    occurredAt: decision.decidedAt,
    ...extra,
  };
}

export function historicalVoteActor(decision: Pick<ApprovalDecision, "deciderKeyId" | "deciderUserId">): AuditActor {
  if (decision.deciderKeyId) return { type: "api_key", id: decision.deciderKeyId };
  if (decision.deciderUserId) return { type: "user", id: decision.deciderUserId };
  return { type: "system", id: null };
}

export function invocationOutcomeRecord(
  invocation: ActionInvocation,
  action: { actionId: string; name: string },
  extra: Partial<AuditRecordInput> = {},
): AuditRecordInput | null {
  if (!(RECORDED_INVOCATION_STATUSES as readonly string[]).includes(invocation.status)) return null;
  return {
    eventId: auditEventId(`invocation:${invocation.id}:${invocation.status}`),
    workspaceId: invocation.workspaceId,
    environmentId: invocation.environmentId,
    type: `action.${invocation.status}`,
    endUserId: invocation.endUserId,
    actor: invocation.requestedByKeyId ? { type: "api_key", id: invocation.requestedByKeyId } : { type: "system", id: null },
    resource: { type: "invocation", id: invocation.invocationId },
    outcome: invocation.status,
    data: {
      invocationId: invocation.invocationId,
      actionId: action.actionId,
      actionName: action.name,
      errorMessage: invocation.errorMessage,
      receipt: {
        actionVersionId: invocation.actionVersionId,
        approvalId: invocation.approvalId,
        decision: invocation.decision,
        status: invocation.status,
        responseStatus: invocation.responseStatus,
        durationMs: invocation.durationMs,
        effectId: invocation.effectId,
        retryOfInvocationId: invocation.retryOfInvocationId,
        requestedAt: invocation.createdAt.toISOString(),
        completedAt: invocation.completedAt?.toISOString() ?? null,
      },
    },
    occurredAt: invocation.completedAt ?? new Date(),
    ...extra,
  };
}

export function resolutionRecord(
  resolution: InvocationResolution,
  invocation: { invocationId: string },
  actionName: string | null,
  extra: Partial<AuditRecordInput> = {},
): AuditRecordInput {
  return {
    eventId: auditEventId(`invocation_resolution:${resolution.id}`),
    workspaceId: resolution.workspaceId,
    environmentId: resolution.environmentId,
    type: "action.resolved",
    actor: { type: resolution.actorType, id: resolution.actorId },
    resource: { type: "invocation", id: invocation.invocationId },
    outcome: resolution.outcome,
    data: {
      invocationId: invocation.invocationId,
      actionName,
      outcome: resolution.outcome,
      evidence: resolution.evidence,
      externalReference: resolution.externalReference ?? null,
    },
    occurredAt: resolution.createdAt,
    ...extra,
  };
}

export function policyVersionRecord(version: PolicyVersion, extra: Partial<AuditRecordInput> = {}): AuditRecordInput | null {
  if (version.operation === "baseline") return null;
  const snapshot = version.snapshot as Record<string, unknown>;
  return {
    eventId: auditEventId(`policy_version:${version.id}`),
    workspaceId: version.workspaceId,
    environmentId: version.environmentId,
    type: `policy.${version.operation}`,
    actor: version.actorId && version.actorType !== "unknown"
      ? { type: version.actorType, id: version.actorId }
      : { type: "system", id: null },
    resource: { type: "policy", id: version.policyId },
    data: {
      policyId: version.policyId,
      name: snapshot.name ?? null,
      version: version.version,
      contentHash: version.contentHash,
      changeNote: version.changeNote,
      managedByFile: snapshot.managed_by_file ?? null,
      snapshot,
    },
    occurredAt: version.createdAt,
    ...extra,
  };
}

export function haltRecord(env: Environment, extra: Partial<AuditRecordInput> = {}): AuditRecordInput | null {
  if (!env.haltedAt) return null;
  return {
    eventId: auditEventId(`environment:${env.id}:halted:${env.haltedAt.toISOString()}`),
    workspaceId: env.workspaceId,
    environmentId: env.id,
    type: "environment.halted",
    actor: haltActor(env.haltedBy),
    resource: { type: "environment", id: env.id },
    data: { slug: env.slug, reason: env.haltedReason ?? null },
    occurredAt: env.haltedAt,
    ...extra,
  };
}

export function resumeRecord(env: Environment, actor: string | undefined, context?: StoredAuditContext): AuditRecordInput {
  return {
    eventId: auditEventId(`environment:${env.id}:resumed:${env.updatedAt.toISOString()}`),
    workspaceId: env.workspaceId,
    environmentId: env.id,
    type: "environment.resumed",
    actor: haltActor(actor),
    context,
    resource: { type: "environment", id: env.id },
    data: { slug: env.slug },
    occurredAt: env.updatedAt,
  };
}
