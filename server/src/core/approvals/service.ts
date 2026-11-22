import { and, asc, count, desc, eq, inArray, lt, or } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { dbUtcNow, readDbNow } from "../../db/clock.ts";
import { approvals, approvalDecisions } from "../../db/schema/approvals.ts";
import { actions, actionInvocations } from "../../db/schema/actions.ts";
import { environments } from "../../db/schema/environments.ts";
import { apiKeys, workspaces } from "../../db/schema/workspaces.ts";
import { redis, RedisKeys } from "../../lib/redis.ts";
import { createLogger } from "../../lib/logger.ts";
import { env } from "../../config/env.ts";
import { generateApprovalId } from "../../utils/crypto.ts";
import {
  ApprovalAlreadyDecidedError,
  ApprovalNotFoundError,
} from "../../utils/errors.ts";
import { MAX_APPROVAL_WAIT_SECONDS } from "../../utils/validation.ts";
import { emitEvent } from "../events/emitter.ts";
import { writeAuditEvents, type AuditRecordInput } from "../audit/outbox.ts";
import { approvalDecidedRecord, approvalRequestedRecord, approvalVoteRecord } from "../audit/records.ts";
import { deciderActor } from "../audit/actors.ts";
import { captureMilestoneOnce } from "../../lib/product-events.ts";
import { createAndSendNotification } from "../notifications/notification-service.ts";
import { notifyTeamIfEnabled } from "../notifications/team-alerts.ts";
import { recordInvocationOutcome, recordInvocationOutcomeIn, reserveApprovalExecution } from "../billing/action-accounting.ts";
import { checkPendingApprovalQuota } from "../billing/usage-enforcement.ts";
import { dispatchedByThisCall, effectiveDefinition, executeInvocation, type InvocationResult } from "../actions/execute.ts";
import { evaluatePolicies, type PolicyDecision } from "./policy.ts";
import { assistantDecision, erasedDecision, expiredDecision, humanDecision, policyDecision, type InvocationDecision } from "./decision.ts";
import { assertMayDecide, distinctApprovers } from "./decider.ts";
import { approvalWindowHoursFor } from "../workspace/defaults.ts";
import { getRunIdentity, getRunWithTree, ingestSpans, type IngestSpanInput } from "../runs/service.ts";
import { actionEffects } from "../../db/schema/effects.ts";
import { rejectEffectForInvocationIn } from "../effects/lifecycle.ts";
import { actingForCondition, type ActingFor } from "../end-users/acting-for.ts";

const logger = createLogger({ module: "approvals" });

type ApprovalRow = typeof approvals.$inferSelect;
type ActionRow = typeof actions.$inferSelect;
type InvocationRow = typeof actionInvocations.$inferSelect;

async function getDefaultEnvironmentId(workspaceId: string): Promise<string> {
  const [row] = await db.select({ id: environments.id }).from(environments)
    .where(and(eq(environments.workspaceId, workspaceId), eq(environments.isDefault, true)));
  if (!row) throw new ApprovalNotFoundError(
    `Workspace ${workspaceId} has no default environment, so approvals cannot be scoped. Create a default environment for this workspace.`
  );
  return row.id;
}

export interface ApprovalActor {
  type: "api_key" | "user";
  id: string;
  displayName: string | null;
}

export interface ApprovalVote {
  decision: "approve" | "deny";
  decidedBy: ApprovalActor | null;
  note: string | null;
  selfApproved: boolean;
  decidedAt: Date;
}

export interface ApprovalView {
  id: string;
  kind: "action" | "custom" | "function_plan";
  status: "pending" | "approved" | "denied" | "expired";
  title: string;
  description: string | null;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedBy: ApprovalActor | null;
  votes?: ApprovalVote[];
  requiredApprovals: number;
  approvedCount: number;
  matchedPolicyId: string | null;
  matchedPolicyVersion: number | null;
  policyExplanation: string | null;
  decisionOrigin: "human" | "policy" | "system" | "unknown" | "assistant" | null;
  endUserId: string | null;
  decider: "team" | "end_user";
  expiresAt: Date;
  decidedAt: Date | null;
  createdAt: Date;
}

export function toApproval(row: ApprovalRow): ApprovalView {
  return {
    id: row.approvalId,
    kind: row.kind,
    status: row.status as ApprovalView["status"],
    title: row.title,
    description: row.description,
    payload: (row.payload as Record<string, unknown>) ?? {},
    decisionNote: row.decisionNote,
    decidedBy: row.status === "pending" || row.status === "expired" ||
      (row.decisionOrigin != null && !["human", "unknown"].includes(row.decisionOrigin))
      ? null
      : approvalActor(row.decidedByKeyId, row.decidedByUserId),
    requiredApprovals: row.requiredApprovals,
    approvedCount: row.approvedCount,
    matchedPolicyId: row.matchedPolicyId,
    matchedPolicyVersion: row.matchedPolicyVersion,
    policyExplanation: row.policyExplanation,
    decisionOrigin: row.decisionOrigin ?? null,
    endUserId: row.endUserId ?? null,
    decider: row.decidedBy === "end_user" ? "end_user" : "team",
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  };
}

function approvalActor(keyId: string | null, userId: string | null): ApprovalActor | null {
  if (keyId && !userId) return { type: "api_key", id: keyId, displayName: null };
  if (userId && !keyId) return { type: "user", id: userId, displayName: null };
  return null;
}

export function toApprovalVote(row: typeof approvalDecisions.$inferSelect): ApprovalVote {
  return {
    decision: row.decision,
    decidedBy: approvalActor(row.deciderKeyId, row.deciderUserId),
    note: row.note,
    selfApproved: row.selfApproved,
    decidedAt: row.decidedAt,
  };
}

async function defaultExpiry(workspaceId: string): Promise<Date> {
  return new Date(Date.now() + (await approvalWindowHoursFor(workspaceId)) * 3600 * 1000);
}

async function resolveApprovalRow(workspaceId: string, approvalId: string, environmentId?: string): Promise<ApprovalRow> {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const [row] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.environmentId, scopedEnvironmentId), eq(approvals.approvalId, approvalId)));

  if (!row) throw new ApprovalNotFoundError(`Approval not found: ${approvalId}`);
  return row;
}

function endUserFields(row: ApprovalRow): Record<string, unknown> {
  return row.endUserId ? { endUserId: row.endUserId, decider: row.decidedBy } : {};
}

const forEndUser = (row: ApprovalRow) => row.decidedBy === "end_user";

async function announce(workspaceId: string, row: ApprovalRow): Promise<void> {
  emitEvent(workspaceId, "approval.requested", {
    environmentId: row.environmentId,
    approvalId: row.approvalId,
    kind: row.kind,
    title: row.title,
    expiresAt: row.expiresAt.toISOString(),
    ...endUserFields(row),
  });
  if (forEndUser(row)) return;

  await redis.incr(RedisKeys.approvalsPendingCount(workspaceId));
  captureMilestoneOnce(workspaceId, "first_approval_requested");

  let assistantOwnsNotification = false;
  try {
    const { onApprovalAnnounced } = await import("../assistant/service.ts");
    assistantOwnsNotification = await onApprovalAnnounced(row);
  } catch (error) {
    logger.warn({ workspaceId, approvalId: row.approvalId, error }, "Approval assistant hook failed; notifying without it");
  }
  if (!assistantOwnsNotification) {
    await Promise.race([
      notifyApprovalRequested(workspaceId, row).catch((error) =>
        logger.warn({ workspaceId, approvalId: row.approvalId, error }, "Approval notification failed"),
      ),
      new Promise<void>((resolve) => setTimeout(resolve, ANNOUNCE_WAIT_MS).unref()),
    ]);
  }
  slackApprovals("post", row);
}

const ANNOUNCE_WAIT_MS = 3000;

function slackApprovals(op: "post" | "sync", row: ApprovalRow): void {
  if (forEndUser(row)) return;
  void import("../slack-approvals/service.ts")
    .then((slack) => (op === "post" ? slack.postApprovalToSlack(row.id) : slack.syncSlackApprovalMessage(row.id)))
    .catch((error) => logger.warn({ approvalId: row.approvalId, error }, "Slack approvals hook failed"));
}

export interface ApprovalNotificationAdvice {
  recommendation: string;
  risk: string;
  confidence: number;
  reasons: string[];
}

export async function notifyApprovalRequested(
  workspaceId: string,
  row: ApprovalRow,
  extra: { advice?: ApprovalNotificationAdvice; note?: string } = {},
): Promise<void> {
  try {
    await createAndSendNotification({
      workspaceId,
      type: "approval_requested",
      priority: "high",
      title: `Approval needed: ${row.title}`,
      message: [row.description ?? "An agent is waiting for your decision.", extra.note].filter(Boolean).join("\n\n"),
      metadata: { approvalId: row.approvalId, kind: row.kind, ...(extra.advice ? { advice: extra.advice } : {}) },
      actionUrl: `${env.CONSOLE_URL}/approvals?id=${row.approvalId}`,
      actionLabel: "Review",
      expiresAt: row.expiresAt,
    });
  } catch (error) {
    logger.warn(
      { workspaceId, approvalId: row.approvalId, error },
      "Failed to dispatch approval notification"
    );
  }
}

async function recordApprovalTrace(row: ApprovalRow): Promise<void> {
  if (!row.traceRunId) return;
  try {
    await getRunWithTree({ workspaceId: row.workspaceId, environmentId: row.environmentId }, row.traceRunId);
    const startedAt = row.traceStartedAt ?? row.createdAt;
    const terminal = row.status !== "pending";
    const status: "succeeded" | "failed" = row.status === "approved" ? "succeeded" : "failed";
    const endedAt = row.decidedAt ?? new Date();
    const attributes = {
      approvalId: row.approvalId,
      kind: row.kind,
      requiredApprovals: row.requiredApprovals,
      approvedCount: row.approvedCount,
      matchedPolicyId: row.matchedPolicyId,
      matchedPolicyVersion: row.matchedPolicyVersion,
    };
    const spans: IngestSpanInput[] = [{
      id: `approval_${row.approvalId}`,
      ...(row.traceParentSpanId ? { parentId: row.traceParentSpanId } : {}),
      name: row.title,
      type: "approval_wait" as const,
      status: terminal ? status : "running",
      startedAt: startedAt.toISOString(),
      ...(terminal ? { endedAt: endedAt.toISOString(), output: { status: row.status } } : {}),
      attributes,
    }];
    if (terminal) {
      spans.push({
        id: `approval_decision_${row.approvalId}`,
        parentId: `approval_${row.approvalId}`,
        name: `Approval ${row.status}`,
        type: "approval_decision" as const,
        status,
        startedAt: endedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        output: { status: row.status, ...(row.decisionNote ? { note: row.decisionNote } : {}) },
        attributes,
      });
    }
    await ingestSpans({ workspaceId: row.workspaceId, environmentId: row.environmentId }, row.traceRunId, spans);
  } catch {
  }
}

export async function createActionApproval(
  workspaceId: string,
  input: {
    action: ActionRow;
    invocation: InvocationRow | ((tx: Tx) => Promise<InvocationRow>);
    requestedByKeyId?: string | null;
    requestedByOAuth?: OAuthPrincipal | null;
    requestedByUserId?: string | null;
    environmentId?: string | null;
    traceRunId?: string;
    traceParentSpanId?: string;
    decision?: PolicyDecision;
    effect?: { effectId: string; previewId: string; bindingDigest: string; expiresAt: Date };
    endUserId?: string | null;
  }
): Promise<ApprovalView> {
  const environmentId = input.environmentId ?? input.action.environmentId;
  const endUserId = input.endUserId ?? null;

  const decision = input.decision ?? {
    matched: false,
    effect: "require_approval" as const,
    requiredApprovals: 1,
    matchedPolicyId: null,
    matchedPolicyVersion: null,
    matchedPolicyName: null,
    matchedActionName: null,
    explanation: "No environment context; applied the default (require one approval).",
  };
  const policy = initialPolicyFields(decision);
  const decidedBy = decision.decidedBy === "end_user" && endUserId ? "end_user" as const : "team" as const;
  if (decidedBy === "end_user") policy.requiredApprovals = 1;
  const windowEnds = await defaultExpiry(workspaceId);
  const expiresAt = input.effect && input.effect.expiresAt < windowEnds ? input.effect.expiresAt : windowEnds;

  const { row, invocation } = await db.transaction(async tx => {
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    await checkPendingApprovalQuota(workspaceId, tx);
    const invocation = typeof input.invocation === "function" ? await input.invocation(tx) : input.invocation;
    const now = await readDbNow(tx);
    if (policy.status === "approved") await reserveApprovalExecution(tx, workspaceId, invocation.id);
    const [created] = await tx
    .insert(approvals)
    .values({
      workspaceId,
      environmentId,
      approvalId: generateApprovalId(),
      kind: "action",
      status: policy.status,
      title: `Run action "${input.action.name}"`,
      description: input.action.description,
      payload: (() => {
        const definition = effectiveDefinition(input.action, invocation);
        return {
          invocationId: invocation.invocationId,
          actionId: input.action.actionId,
          actionName: input.action.name,
          method: definition.method,
          urlTemplate: definition.urlTemplate,
          input: invocation.input,
          ...(endUserId ? { endUserId } : {}),
          ...(input.effect ? {
            environmentId,
            effectId: input.effect.effectId,
            previewId: input.effect.previewId,
            bindingDigest: input.effect.bindingDigest,
          } : {}),
        };
      })(),
      previewId: input.effect?.previewId ?? null,
      bindingDigest: input.effect?.bindingDigest ?? null,
      endUserId,
      decidedBy,
      requestedByKeyId: input.requestedByKeyId ?? null,
      requestedByUserId: input.requestedByOAuth?.userId ?? input.requestedByUserId ?? null,
      requestedByOAuthClientId: input.requestedByOAuth?.clientId ?? null,
      traceRunId: input.traceRunId ?? null,
      traceParentSpanId: input.traceParentSpanId ?? null,
      traceStartedAt: new Date(),
      requiredApprovals: policy.requiredApprovals,
      matchedPolicyId: policy.matchedPolicyId,
      matchedPolicyVersion: policy.matchedPolicyVersion,
      policyExplanation: policy.policyExplanation,
      decisionOrigin: policy.status === "pending" ? null : "policy",
      createdAt: now,
      decidedAt: policy.status === "pending" ? null : now,
      expiresAt,
    })
    .returning();

    if (input.effect) {
      await tx.update(actionEffects).set({ approvalId: created.approvalId }).where(eq(actionEffects.invocationId, invocation.id));
    }

    await tx.update(actionInvocations).set({ approvalId: created.approvalId }).where(eq(actionInvocations.id, invocation.id));

    await writeAuditEvents(tx, approvalRecords(created));

    if (policy.status !== "pending") {
      const ref = {
        id: policy.matchedPolicyId ?? "",
        name: decision.matchedPolicyName ?? "",
        version: policy.matchedPolicyVersion ?? 0,
      };
      if (policy.status === "denied") {
        await recordInvocationOutcomeIn(
          tx,
          workspaceId,
          invocation.id,
          { status: "denied", completedAt: now, decision: policyDecision("denied", ref, now) },
          "released",
        );
        await rejectEffectForInvocationIn(tx, invocation.id, "denied");
      } else {
        await tx
          .update(actionInvocations)
          .set({ decision: policyDecision("approved", ref, now) })
          .where(eq(actionInvocations.id, invocation.id));
      }
    }
    return { row: created, invocation };
  });

  await recordApprovalTrace(row);

  if (policy.status === "pending") {
    await announce(workspaceId, row);
  } else if (policy.status === "approved") {
    emitEvent(workspaceId, "approval.approved", { environmentId: row.environmentId, approvalId: row.approvalId, kind: row.kind, title: row.title, ...endUserFields(row) });
    await executeInvocation(input.action, invocation);
  } else {
    emitEvent(workspaceId, "approval.denied", { environmentId: row.environmentId, approvalId: row.approvalId, kind: row.kind, title: row.title, ...endUserFields(row) });
  }
  return toApproval(row);
}

function approvalRecords(row: ApprovalRow, opts: { requested?: boolean } = {}): AuditRecordInput[] {
  const records: AuditRecordInput[] = [];
  if (opts.requested !== false) records.push(approvalRequestedRecord(row));
  const decided = approvalDecidedRecord(row);
  if (decided) records.push(decided);
  return records;
}

function initialPolicyFields(decision: PolicyDecision): {
  status: ApprovalRow["status"];
  requiredApprovals: number;
  matchedPolicyId: string | null;
  matchedPolicyVersion: number | null;
  policyExplanation: string;
} {
  const status: ApprovalRow["status"] =
    decision.effect === "auto_approve" ? "approved" : decision.effect === "auto_deny" ? "denied" : "pending";
  return {
    status,
    requiredApprovals: decision.requiredApprovals,
    matchedPolicyId: decision.matchedPolicyId,
    matchedPolicyVersion: decision.matchedPolicyVersion,
    policyExplanation: decision.explanation,
  };
}

export async function createApproval(
  workspaceId: string,
  input: {
    title: string;
    description?: string;
    payload?: Record<string, unknown>;
    expiresInSeconds?: number;
  },
  opts: {
    requestedByKeyId?: string | null;
    requestedByOAuth?: OAuthPrincipal | null;
    requestedByUserId?: string | null;
    environmentId?: string | null;
    traceRunId?: string;
    traceParentSpanId?: string;
  } = {}
): Promise<ApprovalView> {
  await checkPendingApprovalQuota(workspaceId);
  const environmentId = opts.environmentId ?? await getDefaultEnvironmentId(workspaceId);

  const expiresAt = input.expiresInSeconds
    ? new Date(Date.now() + input.expiresInSeconds * 1000)
    : await defaultExpiry(workspaceId);

  const identity = opts.traceRunId
    ? await getRunIdentity({ workspaceId, environmentId }, opts.traceRunId)
    : { agentId: null, userId: null };

  const decision = await evaluatePolicies(environmentId, {
    kind: "custom",
    agentId: identity.agentId,
    userId: identity.userId,
    tags: (input.payload?.tags as string[] | undefined) ?? [],
    amount: typeof input.payload?.amount === "number" ? (input.payload.amount as number) : null,
    payload: input.payload ?? {},
  });
  const policy = initialPolicyFields(decision);
  const now = await readDbNow(db);

  const row = await db.transaction(async (tx) => {
  const [created] = await tx
    .insert(approvals)
    .values({
      workspaceId,
      environmentId,
      approvalId: generateApprovalId(),
      kind: "custom",
      status: policy.status,
      title: input.title,
      description: input.description ?? null,
      payload: input.payload ?? {},
      requestedByKeyId: opts.requestedByKeyId ?? null,
      requestedByUserId: opts.requestedByOAuth?.userId ?? opts.requestedByUserId ?? null,
      requestedByOAuthClientId: opts.requestedByOAuth?.clientId ?? null,
      traceRunId: opts.traceRunId ?? null,
      traceParentSpanId: opts.traceParentSpanId ?? null,
      traceStartedAt: new Date(),
      requiredApprovals: policy.requiredApprovals,
      matchedPolicyId: policy.matchedPolicyId,
      matchedPolicyVersion: policy.matchedPolicyVersion,
      policyExplanation: policy.policyExplanation,
      decisionOrigin: policy.status === "pending" ? null : "policy",
      createdAt: now,
      decidedAt: policy.status === "pending" ? null : now,
      expiresAt,
    })
    .returning();
  await writeAuditEvents(tx, approvalRecords(created));
  return created;
  });

  await recordApprovalTrace(row);

  if (policy.status === "pending") {
    await announce(workspaceId, row);
    logger.info({ workspaceId, approvalId: row.approvalId }, "Approval requested");
  } else {
    emitEvent(workspaceId, policy.status === "approved" ? "approval.approved" : "approval.denied", {
      environmentId: row.environmentId,
      approvalId: row.approvalId,
      kind: row.kind,
      title: row.title,
    });
    logger.info(
      { workspaceId, approvalId: row.approvalId, effect: decision.effect, policy: decision.matchedPolicyId },
      "Approval auto-decided by policy"
    );
  }
  return toApproval(row);
}

export async function createFunctionPlanApproval(
  scope: { workspaceId: string; environmentId: string },
  input: {
    title: string;
    description: string;
    payload: Record<string, unknown>;
    planDigest: string;
    endUserId: string | null;
    decision: {
      effect: "require_approval" | "auto_deny";
      decidedBy: "team" | "end_user";
      requiredApprovals: number;
      matchedPolicyId: string | null;
      matchedPolicyVersion: number | null;
      explanation: string;
    };
  },
  opts: { requestedByKeyId?: string | null; requestedByUserId?: string | null } = {},
): Promise<ApprovalView> {
  const { workspaceId, environmentId } = scope;
  const decidedBy = input.decision.decidedBy === "end_user" && input.endUserId ? "end_user" as const : "team" as const;
  const status: ApprovalRow["status"] = input.decision.effect === "auto_deny" ? "denied" : "pending";
  const expiresAt = await defaultExpiry(workspaceId);
  const row = await db.transaction(async (tx) => {
    await checkPendingApprovalQuota(workspaceId, tx);
    const now = await readDbNow(tx);
    const [created] = await tx
      .insert(approvals)
      .values({
        workspaceId,
        environmentId,
        approvalId: generateApprovalId(),
        kind: "function_plan",
        status,
        title: input.title,
        description: input.description,
        payload: input.payload,
        bindingDigest: input.planDigest,
        endUserId: input.endUserId,
        decidedBy,
        requestedByKeyId: opts.requestedByKeyId ?? null,
        requestedByUserId: opts.requestedByUserId ?? null,
        traceStartedAt: new Date(),
        requiredApprovals: decidedBy === "end_user" ? 1 : input.decision.requiredApprovals,
        matchedPolicyId: input.decision.matchedPolicyId,
        matchedPolicyVersion: input.decision.matchedPolicyVersion,
        policyExplanation: input.decision.explanation,
        decisionOrigin: status === "pending" ? null : "policy",
        createdAt: now,
        decidedAt: status === "pending" ? null : now,
        expiresAt,
      })
      .returning();
    await writeAuditEvents(tx, approvalRecords(created));
    return created;
  });

  if (status === "pending") {
    await announce(workspaceId, row);
    logger.info({ workspaceId, approvalId: row.approvalId, decidedBy }, "Function plan approval requested");
  } else {
    emitEvent(workspaceId, "approval.denied", {
      environmentId: row.environmentId, approvalId: row.approvalId, kind: row.kind, title: row.title, ...endUserFields(row),
    });
  }
  return toApproval(row);
}

export async function listApprovals(
  workspaceId: string,
  opts: {
    status?: ApprovalView["status"];
    decisionOrigin?: "human" | "policy" | "system" | "unknown" | "assistant" | "automated";
    limit?: number;
    offset?: number;
    environmentId?: string;
    endUserId?: string;
    actingFor?: ActingFor;
    decider?: "team" | "end_user";
  } = {}
): Promise<{ approvals: ApprovalView[]; total: number }> {
  const environmentId = opts.environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);

  const originFilter =
    opts.decisionOrigin === "automated"
      ? inArray(approvals.decisionOrigin, ["policy", "system", "assistant"])
      : opts.decisionOrigin
        ? eq(approvals.decisionOrigin, opts.decisionOrigin)
        : undefined;
  const where = and(
    eq(approvals.workspaceId, workspaceId),
    eq(approvals.environmentId, environmentId),
    opts.status ? eq(approvals.status, opts.status) : undefined,
    originFilter,
    eq(approvals.decidedBy, opts.decider ?? "team"),
    opts.endUserId ? eq(approvals.endUserId, opts.endUserId) : undefined,
    actingForCondition(approvals.endUserId, opts.actingFor),
  );

  const rows = await db
    .select()
    .from(approvals)
    .where(where)
    .orderBy(desc(approvals.createdAt), desc(approvals.id))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db.select({ total: count() }).from(approvals).where(where);

  return { approvals: rows.map(toApproval), total };
}

export async function getApproval(
  workspaceId: string,
  approvalId: string,
  environmentId?: string,
): Promise<ApprovalView> {
  const row = await resolveApprovalRow(workspaceId, approvalId, environmentId);
  const votes = (await db.select().from(approvalDecisions)
    .where(eq(approvalDecisions.approvalId, row.id))
    .orderBy(asc(approvalDecisions.decidedAt), asc(approvalDecisions.id))).map(toApprovalVote);

  if (row.status === "pending" && row.expiresAt.getTime() <= Date.now()) {
    await expire(row);
    return { ...toApproval({ ...row, status: "expired", decisionOrigin: "system", decidedAt: new Date() }), votes };
  }

  return { ...toApproval(row), votes };
}

export const APPROVAL_POLL_INTERVAL_MS = 1500;

export async function pollUntilDecided(
  read: () => Promise<ApprovalView>,
  opts: {
    waitSeconds: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  }
): Promise<ApprovalView> {
  const intervalMs = opts.intervalMs ?? APPROVAL_POLL_INTERVAL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;

  const waitSeconds = Math.min(Math.max(opts.waitSeconds, 0), MAX_APPROVAL_WAIT_SECONDS);
  const deadline = now() + waitSeconds * 1000;

  let approval = await read();
  while (approval.status === "pending") {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
    approval = await read();
  }

  return approval;
}

export async function waitForApproval(
  workspaceId: string,
  approvalId: string,
  waitSeconds: number,
  environmentId?: string,
): Promise<ApprovalView> {
  return pollUntilDecided(() => getApproval(workspaceId, approvalId, environmentId), { waitSeconds });
}

export async function countPendingApprovals(workspaceId: string): Promise<number> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(approvals)
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, "pending"), eq(approvals.decidedBy, "team")));
  return total;
}

export async function listEndUserApprovals(
  scope: { workspaceId: string; environmentId: string },
  endUserId: string,
  opts: { status?: ApprovalView["status"]; limit?: number; offset?: number } = {},
): Promise<{ approvals: ApprovalView[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where = and(
    eq(approvals.workspaceId, scope.workspaceId),
    eq(approvals.environmentId, scope.environmentId),
    eq(approvals.endUserId, endUserId),
    eq(approvals.decidedBy, "end_user"),
    opts.status ? eq(approvals.status, opts.status) : undefined,
  );
  const rows = await db.select().from(approvals).where(where)
    .orderBy(desc(approvals.createdAt), desc(approvals.id)).limit(limit).offset(offset);
  const [{ total }] = await db.select({ total: count() }).from(approvals).where(where);
  const now = Date.now();
  for (const row of rows) {
    if (row.status === "pending" && row.expiresAt.getTime() <= now) await expire(row);
  }
  return {
    approvals: rows.map((row) => row.status === "pending" && row.expiresAt.getTime() <= now
      ? toApproval({ ...row, status: "expired", decisionOrigin: "system", decidedAt: new Date() })
      : toApproval(row)),
    total,
  };
}

export async function cancelEndUserApprovals(scope: { workspaceId: string; environmentId: string }, endUserId: string): Promise<number> {
  const pending = await db.select().from(approvals).where(and(
    eq(approvals.workspaceId, scope.workspaceId),
    eq(approvals.environmentId, scope.environmentId),
    eq(approvals.endUserId, endUserId),
    eq(approvals.status, "pending"),
  ));
  let cancelled = 0;
  for (const row of pending) {
    const done = await db.transaction(async (tx) => {
      if (row.kind === "action") {
        await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, row.workspaceId)).for("update");
      }
      const [updated] = await tx.update(approvals).set({
        status: "denied",
        decidedAt: dbUtcNow(),
        decisionOrigin: "system",
        decisionNote: "Cancelled: the end user was erased.",
      }).where(and(eq(approvals.id, row.id), eq(approvals.status, "pending"))).returning();
      if (!updated) return null;
      if (updated.kind === "action") await releaseLinkedInvocationIn(tx, updated, "denied", erasedDecision(updated.decidedAt ?? new Date()));
      await writeAuditEvents(tx, approvalRecords(updated, { requested: false }));
      return updated;
    });
    if (!done) continue;
    cancelled++;
    if (!forEndUser(done)) {
      slackApprovals("sync", done);
      await redis.decr(RedisKeys.approvalsPendingCount(done.workspaceId)).catch(() => undefined);
    }
    emitEvent(done.workspaceId, "approval.denied", {
      environmentId: done.environmentId, approvalId: done.approvalId, kind: done.kind, title: done.title, ...endUserFields(done),
    });
  }
  return cancelled;
}

export interface OAuthPrincipal {
  userId: string;
  clientId: string;
}

export interface DecisionContext {
  deciderKeyId?: string | null;
  deciderOAuthClientId?: string | null;
  deciderUserId?: string | null;
  note?: string;
  assistant?: { model: string };
  endUserId?: string;
  via?: "end_user_session";
}

function voteRecord(row: ApprovalRow, decision: typeof approvalDecisions.$inferSelect, ctx: DecisionContext) {
  const record = approvalVoteRecord(row, decision, deciderActor(ctx));
  return ctx.via ? { ...record, data: { ...record.data, via: ctx.via } } : record;
}

export interface DecisionResult {
  approval: ApprovalView;
  selfApproved: boolean;
  invocation?: InvocationResult;
}

async function decide(
  workspaceId: string,
  approvalId: string,
  vote: "approve" | "deny",
  ctx: DecisionContext,
  environmentId?: string,
): Promise<{ row: ApprovalRow; finalized: boolean; selfApproved: boolean }> {
  const current = await resolveApprovalRow(workspaceId, approvalId, environmentId);
  if (ctx.endUserId !== undefined) {
    if (!forEndUser(current) || current.endUserId !== ctx.endUserId) throw new ApprovalNotFoundError(`Approval not found: ${approvalId}`);
  } else if (forEndUser(current)) {
    throw new ApprovalNotFoundError(`Approval not found: ${approvalId}`);
  }

  if (current.status !== "pending") {
    throw new ApprovalAlreadyDecidedError(`Approval ${approvalId} is already ${current.status}`);
  }
  if (current.expiresAt.getTime() <= Date.now()) {
    await expire(current);
    throw new ApprovalAlreadyDecidedError(`Approval ${approvalId} has expired`);
  }
  const { selfApproved } = ctx.endUserId !== undefined ? { selfApproved: false } : await assertMayDecide(workspaceId, current, ctx);

  const { row, finalized } = await db.transaction(async (tx) => {
    if (current.kind === "action") {
      await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    }
    const [locked] = await tx
      .select()
      .from(approvals)
      .where(eq(approvals.id, current.id))
      .for("update")
      .limit(1);

    if (locked.status !== "pending") {
      throw new ApprovalAlreadyDecidedError(`Approval ${approvalId} is already ${locked.status}`);
    }
    if (locked.expiresAt.getTime() <= Date.now()) {
      const [expiredRow] = await tx
        .update(approvals)
        .set({ status: "expired", decidedAt: dbUtcNow(), decisionOrigin: "system" })
        .where(eq(approvals.id, locked.id))
        .returning();
      if (locked.kind === "action") await releaseLinkedInvocationIn(tx, expiredRow, "expired");
      await writeAuditEvents(tx, approvalRecords(expiredRow, { requested: false }));
      return { row: expiredRow, finalized: false, expired: true };
    }

    let decisionRow: typeof approvalDecisions.$inferSelect;
    try {
      [decisionRow] = await tx.insert(approvalDecisions).values({
        approvalId: current.id,
        deciderKeyId: ctx.deciderKeyId ?? null,
        deciderUserId: ctx.deciderUserId ?? null,
        decision: vote,
        note: ctx.note ?? null,
        selfApproved,
        decidedAt: dbUtcNow(),
      }).returning();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApprovalAlreadyDecidedError("You have already decided this approval.");
      }
      throw error;
    }

    if (vote === "deny") {
      const [denied] = await tx
        .update(approvals)
        .set({
          status: "denied",
          decidedAt: dbUtcNow(),
          decisionOrigin: "human",
          decidedByKeyId: ctx.deciderKeyId ?? null,
          decidedByUserId: ctx.deciderUserId ?? null,
          decisionNote: ctx.note ?? null,
        })
        .where(eq(approvals.id, current.id))
        .returning();
      if (locked.kind === "action") await releaseLinkedInvocationIn(tx, denied, "denied");
      await writeAuditEvents(tx, [voteRecord(denied, decisionRow, ctx), ...approvalRecords(denied, { requested: false })]);
      return { row: denied, finalized: true, expired: false };
    }

    const approveVotes = await tx
      .select({
        id: approvalDecisions.id,
        deciderKeyId: approvalDecisions.deciderKeyId,
        deciderUserId: approvalDecisions.deciderUserId,
        keyCreatedBy: apiKeys.createdBy,
      })
      .from(approvalDecisions)
      .leftJoin(apiKeys, eq(apiKeys.id, approvalDecisions.deciderKeyId))
      .where(and(eq(approvalDecisions.approvalId, current.id), eq(approvalDecisions.decision, "approve")));
    const approveCount = distinctApprovers(approveVotes);

    if (Number(approveCount) >= locked.requiredApprovals) {
      if (locked.kind === "action") {
        const [invocation] = await tx.select().from(actionInvocations).where(and(
          eq(actionInvocations.workspaceId, workspaceId), eq(actionInvocations.environmentId, locked.environmentId),
          eq(actionInvocations.approvalId, locked.approvalId),
        ));
        if (!invocation) throw new ApprovalNotFoundError("No invocation is linked to this action approval");
        await reserveApprovalExecution(tx, workspaceId, invocation.id);
      }
      const [approved] = await tx
        .update(approvals)
        .set({
          status: "approved",
          approvedCount: Number(approveCount),
          decidedAt: dbUtcNow(),
          decisionOrigin: ctx.assistant ? "assistant" : "human",
          decidedByKeyId: ctx.deciderKeyId ?? null,
          decidedByUserId: ctx.deciderUserId ?? null,
          decisionNote: ctx.note ?? null,
        })
        .where(eq(approvals.id, current.id))
        .returning();
      if (locked.kind === "action") {
        await tx
          .update(actionInvocations)
          .set({
            decision: ctx.assistant
              ? assistantDecision(ctx.assistant.model, approved.decidedAt ?? new Date())
              : humanDecision("approved", approved.decidedAt ?? new Date()),
          })
          .where(and(
            eq(actionInvocations.workspaceId, workspaceId), eq(actionInvocations.environmentId, locked.environmentId),
            eq(actionInvocations.approvalId, locked.approvalId),
          ));
      }
      await writeAuditEvents(tx, [voteRecord(approved, decisionRow, ctx), ...approvalRecords(approved, { requested: false })]);
      return { row: approved, finalized: true, expired: false };
    }

    const [updated] = await tx
      .update(approvals)
      .set({ approvedCount: Number(approveCount) })
      .where(eq(approvals.id, current.id))
      .returning();
    await writeAuditEvents(tx, [voteRecord(updated, decisionRow, ctx)]);
    return { row: updated, finalized: false, expired: false };
  }).then(async (result) => {
    if (result.expired) {
      await finishExpiry(result.row);
      throw new ApprovalAlreadyDecidedError(`Approval ${approvalId} has expired`);
    }
    if (result.finalized && !forEndUser(result.row)) {
      await redis.decr(RedisKeys.approvalsPendingCount(workspaceId)).catch((error) => {
        logger.warn({ workspaceId, approvalId, error }, "Pending-approval counter not decremented");
      });
    }
    return result;
  });

  return { row, finalized, selfApproved };
}

function isUniqueViolation(error: unknown): boolean {
  const code = (e: unknown) =>
    typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
  return code(error) === "23505" || code((error as { cause?: unknown })?.cause) === "23505";
}

export async function approveApproval(
  workspaceId: string,
  approvalId: string,
  ctx: DecisionContext,
  environmentId?: string,
): Promise<DecisionResult> {
  const { row, finalized, selfApproved } = await decide(workspaceId, approvalId, "approve", ctx, environmentId);
  slackApprovals("sync", row);

  if (finalized) await recordApprovalTrace(row);

  if (!finalized) {
    logger.info(
      { workspaceId, approvalId, approvedCount: row.approvedCount, requiredApprovals: row.requiredApprovals },
      "Approval vote recorded; awaiting more approvers"
    );
    return { approval: toApproval(row), selfApproved };
  }

  captureMilestoneOnce(workspaceId, "first_approval_resolved", { decision: "approve" });

  emitEvent(workspaceId, "approval.approved", {
    environmentId: row.environmentId,
    approvalId: row.approvalId,
    kind: row.kind,
    title: row.title,
    ...endUserFields(row),
  });

  logger.info({ workspaceId, approvalId }, "Approval approved");

  if (row.kind !== "action") {
    return { approval: toApproval(row), selfApproved };
  }

  const linked = await loadLinkedInvocation(workspaceId, row);
  if (!linked) {
    return { approval: toApproval(row), selfApproved };
  }

  const claimed = await claimForExecution(linked.invocation);
  if (!claimed) {
    logger.info(
      { workspaceId, approvalId, invocationId: linked.invocation.invocationId },
      "Approved invocation already claimed elsewhere; not dispatching again"
    );
    return { approval: toApproval(row), selfApproved };
  }

  const invocation = await executeInvocation(linked.action, claimed);
  return { approval: toApproval(row), invocation, selfApproved };
}

async function claimForExecution(invocation: InvocationRow): Promise<InvocationRow | null> {
  return invocation.status === "pending_approval" ? invocation : null;
}

export async function resumeApprovedInvocations(
  batchSize: number = 50,
  graceMs: number = 60_000,
  scope: { workspaceId?: string } = {},
): Promise<number> {
  const cutoff = new Date(Date.now() - graceMs);
  const stranded = await db
    .select({ invocation: actionInvocations, action: actions })
    .from(actionInvocations)
    .innerJoin(actions, eq(actions.id, actionInvocations.actionId))
    .innerJoin(approvals, eq(approvals.approvalId, actionInvocations.approvalId))
    .where(
      and(
        eq(actionInvocations.status, "pending_approval"),
        eq(approvals.status, "approved"),
        lt(approvals.decidedAt, cutoff),
        scope.workspaceId ? eq(approvals.workspaceId, scope.workspaceId) : undefined,
      )
    )
    .limit(batchSize);

  let resumed = 0;
  for (const row of stranded) {
    const claimed = await claimForExecution(row.invocation);
    if (!claimed) continue;
    try {
      const result = await executeInvocation(row.action, claimed);
      if (dispatchedByThisCall(result)) resumed += 1;
    } catch (error) {
      logger.error(
        { invocationId: row.invocation.invocationId, error },
        "Failed to resume an approved invocation"
      );
    }
  }

  if (resumed > 0) {
    logger.info({ resumed }, "Resumed approved invocations stranded by a crash");
  }
  return resumed;
}

export async function denyApproval(
  workspaceId: string,
  approvalId: string,
  ctx: DecisionContext,
  environmentId?: string,
): Promise<DecisionResult> {
  const { row, selfApproved } = await decide(workspaceId, approvalId, "deny", ctx, environmentId);
  slackApprovals("sync", row);

  await recordApprovalTrace(row);

  captureMilestoneOnce(workspaceId, "first_approval_resolved", { decision: "deny" });

  emitEvent(workspaceId, "approval.denied", {
    environmentId: row.environmentId,
    approvalId: row.approvalId,
    kind: row.kind,
    title: row.title,
    ...endUserFields(row),
  });

  logger.info({ workspaceId, approvalId }, "Approval denied");
  return { approval: toApproval(row), selfApproved };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function releaseLinkedInvocationIn(tx: Tx, approval: ApprovalRow, status: "denied" | "expired", decision?: InvocationDecision) {
  const [linked] = await tx
    .select({ id: actionInvocations.id, dispatchClaimedAt: actionInvocations.dispatchClaimedAt })
    .from(actionInvocations)
    .where(
      and(
        eq(actionInvocations.workspaceId, approval.workspaceId),
        eq(actionInvocations.environmentId, approval.environmentId),
        eq(actionInvocations.approvalId, approval.approvalId),
      ),
    );
  if (!linked || linked.dispatchClaimedAt) return;
  const decidedAt = approval.decidedAt ?? new Date();
  await recordInvocationOutcomeIn(
    tx,
    approval.workspaceId,
    linked.id,
    {
      status,
      completedAt: dbUtcNow(),
      decision: decision ?? (status === "denied" ? humanDecision("denied", decidedAt) : expiredDecision(decidedAt)),
    },
    "released",
  );
  await rejectEffectForInvocationIn(tx, linked.id, status);
}

async function loadLinkedInvocation(
  workspaceId: string,
  approval: ApprovalRow
): Promise<{ action: ActionRow; invocation: InvocationRow } | null> {
  const [row] = await db
    .select({ invocation: actionInvocations, action: actions })
    .from(actionInvocations)
    .innerJoin(actions, eq(actions.id, actionInvocations.actionId))
    .where(
      and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.environmentId, approval.environmentId),
        eq(actionInvocations.approvalId, approval.approvalId)
      )
    );

  if (!row) {
    logger.warn(
      { workspaceId, approvalId: approval.approvalId },
      "Approved action approval has no linked invocation"
    );
    return null;
  }

  return { action: row.action, invocation: row.invocation };
}

async function expire(row: ApprovalRow): Promise<void> {
  const expired = await db.transaction(async (tx) => {
    if (row.kind === "action") {
      await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, row.workspaceId)).for("update");
    }
    const [updated] = await tx
      .update(approvals)
      .set({ status: "expired", decidedAt: dbUtcNow(), decisionOrigin: "system" })
      .where(and(eq(approvals.id, row.id), eq(approvals.status, "pending")))
      .returning();
    if (!updated) return null;
    if (updated.kind === "action") await releaseLinkedInvocationIn(tx, updated, "expired");
    await writeAuditEvents(tx, approvalRecords(updated, { requested: false }));
    return updated;
  });

  if (!expired) return;
  await finishExpiry(expired);
}

async function finishExpiry(expired: ApprovalRow): Promise<void> {
  const row = expired;
  slackApprovals("sync", row);
  await recordApprovalTrace(expired);

  if (!forEndUser(row)) await redis.decr(RedisKeys.approvalsPendingCount(row.workspaceId));

  emitEvent(row.workspaceId, "approval.expired", {
    environmentId: row.environmentId,
    approvalId: row.approvalId,
    kind: row.kind,
    title: row.title,
    ...endUserFields(row),
  });

  if (!forEndUser(row)) {
    await notifyTeamIfEnabled({
      workspaceId: row.workspaceId,
      type: "approval_expired",
      priority: "medium",
      title: `Request expired: ${row.title}`,
      message: row.kind === "custom"
        ? "Nobody answered in time, so the request expired."
        : row.kind === "function_plan"
          ? "Nobody answered in time, so the plan will not be applied. Nothing was sent."
          : "Nobody answered in time, so the call was cancelled. Nothing was sent.",
      metadata: { approvalId: row.approvalId, kind: row.kind, environmentId: row.environmentId },
      actionUrl: `${env.CONSOLE_URL}/approvals?id=${row.approvalId}`,
      actionLabel: "View",
    });
  }
}

export async function sweepExpiredApprovals(
  batchSize: number = 200,
  scope: { workspaceId?: string } = {},
): Promise<number> {
  const due = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.status, "pending"),
        lt(approvals.expiresAt, new Date()),
        scope.workspaceId ? eq(approvals.workspaceId, scope.workspaceId) : undefined,
      ),
    )
    .limit(batchSize);

  for (const row of due) {
    await expire(row);
  }

  if (due.length > 0) {
    logger.info({ expired: due.length }, "Expired pending approvals");
  }
  return due.length;
}
