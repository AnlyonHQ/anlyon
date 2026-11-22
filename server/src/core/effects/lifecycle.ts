import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.ts";
import { readDbNow } from "../../db/clock.ts";
import { storableValue, stripUnstorable } from "../../utils/storable-text.ts";
import { actions, actionInvocations } from "../../db/schema/actions.ts";
import { approvals } from "../../db/schema/approvals.ts";
import {
  actionEffects,
  effectAttempts,
  effectEvidence,
  effectPreviews,
  type ActionEffect,
  type EffectAttempt,
  type EffectGrade,
  type EffectPreview,
  type PartialEffect,
} from "../../db/schema/effects.ts";
import { apiKeys, workspaces } from "../../db/schema/workspaces.ts";
import { env } from "../../config/env.ts";
import { createLogger } from "../../lib/logger.ts";
import { ApiError, ConflictError, NotFoundError } from "../../utils/errors.ts";
import { DEFAULT_API_KEY_SCOPES } from "../auth/api-key-scopes.ts";
import { recordInvocationOutcomeIn, reserveActionExecution } from "../billing/action-accounting.ts";
import { isEnvironmentHalted } from "../environments/halt.ts";
import { evaluatePolicies } from "../approvals/policy.ts";
import { getRunIdentity, getRunWithTree, ingestSpans } from "../runs/service.ts";
import { emitEvent } from "../events/emitter.ts";
import { markNotDispatchedHere, toInvocation, type InvocationResult } from "../actions/execute.ts";
import { resolvePinnedDefinition } from "../actions/definitions.ts";
import { applyRiskFloor, shouldGate } from "../actions/gating.ts";
import type {
  AnyEffectAdapter,
  DispatchRequest,
  EvidenceDraft,
  ImpactQuantity,
  Interpretation,
  NormalizedOperation,
  Observation,
  VerifyResult,
} from "./adapter.ts";
import { requestDigest } from "./binding.ts";
import { adapterFromSpec, buildAdapterContext, loadVersionAdapter, type GovernedSpec, type VersionAdapter } from "./context.ts";
import { probeRejectedCredentials } from "../connections/health.ts";
import { EndUserConnectionError } from "../end-users/errors.ts";
import { markEndUserFailure } from "../end-users/failures.ts";
import { extractSecretNames } from "../actions/template.ts";
import { applyOutcomeToImpactIn, EffectRejection, releaseUndispatchedIn, reserveImpactIn } from "./impact.ts";
import { assertPreviewMatches, buildPreview, implicitPreviewTtlSeconds, normalizeFor, previewRow, recomputeBinding } from "./previews.ts";
import { TransportError } from "./transport.ts";
import { approvalWindowHoursFor } from "../workspace/defaults.ts";
import { notifyTeamIfEnabled } from "../notifications/team-alerts.ts";

const logger = createLogger({ module: "effects" });

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ActionRow = typeof actions.$inferSelect;
type InvocationRow = typeof actionInvocations.$inferSelect;

export const DISPATCH_LEASE_MS = () => env.ACTION_TIMEOUT_MS * 3 + 60_000;
export const RECONCILE_LEASE_MS = () => env.ACTION_TIMEOUT_MS * 4 + 60_000;
export const MAX_RECONCILE_ATTEMPTS = 12;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const MAX_EVIDENCE_DETAIL_BYTES = 8 * 1024;

export function reconcileBackoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(attempts, 0), MAX_BACKOFF_MS);
}

export function leaseOwner(): string {
  return `${process.pid}:${randomUUID()}`;
}

export interface EffectAdmissionOptions {
  workspaceId: string;
  environmentId: string;
  action: ActionRow;
  actionVersionId: string;
  spec: GovernedSpec;
  input: Record<string, unknown>;
  operationKey?: string | null;
  previewId?: string | null;
  dependsOn?: Array<{ effect: string; outcome: "succeeded" | "failed" }>;
  compensates?: string | null;
  requestedByKeyId?: string | null;
  endUserId?: string | null;
}

export interface EffectAdmission {
  adapter: AnyEffectAdapter;
  operation: NormalizedOperation;
  impact: ImpactQuantity[];
  requestDigest: string;
  operationKey: string;
  preview: EffectPreview;
  dependsOn: Array<{ effectId: string; outcome: string }>;
  compensates: string | null;
  actionVersionId: string;
}

export type EffectAdmissionDraft = Omit<EffectAdmission, "preview"> & {
  preview: EffectPreview | null;
  source: Pick<EffectAdmissionOptions, "action" | "actionVersionId" | "spec" | "input" | "requestedByKeyId" | "endUserId">;
};

export type AdmissionResult =
  | { kind: "existing"; effect: ActionEffect }
  | { kind: "new"; admission: EffectAdmissionDraft };

export function policyAmount(impact: ImpactQuantity[]): { amount: number | null; amountCurrency: string | null } {
  const q = impact.find((item) => item.dimension === "money");
  return q ? { amount: q.amount, amountCurrency: q.currency ?? null } : { amount: null, amountCurrency: null };
}

export async function effectByOperationKey(workspaceId: string, environmentId: string, operationKey: string) {
  const [row] = await db.select().from(actionEffects).where(and(
    eq(actionEffects.workspaceId, workspaceId),
    eq(actionEffects.environmentId, environmentId),
    eq(actionEffects.operationKey, operationKey),
  ));
  return row ?? null;
}

export function isSameOperation(existing: { requestDigest: string; endUserId: string | null }, requestDigest: string, endUserId: string | null | undefined): boolean {
  return existing.requestDigest === requestDigest && (existing.endUserId ?? null) === (endUserId ?? null);
}

export function operationKeyConflict(operationKey: string): ApiError {
  return new ApiError(
    409,
    "OPERATION_KEY_REUSE",
    `Operation key "${operationKey}" already identifies a different request. Reuse a key only to repeat the same request; a different key does not make a request a different business operation.`,
  );
}

async function checkDependencies(
  workspaceId: string, environmentId: string, dependsOn: Array<{ effect: string; outcome: string }>,
): Promise<Array<{ effectId: string; outcome: string }>> {
  if (!dependsOn.length) return [];
  const rows = await db.select({ effectId: actionEffects.effectId, outcome: actionEffects.outcome, partial: actionEffects.partialEffect })
    .from(actionEffects).where(and(
      eq(actionEffects.workspaceId, workspaceId),
      eq(actionEffects.environmentId, environmentId),
      inArray(actionEffects.effectId, dependsOn.map((d) => d.effect)),
    ));
  const byId = new Map(rows.map((row) => [row.effectId, row]));
  const unmet = dependsOn.filter((d) => {
    const row = byId.get(d.effect);
    return !row || row.outcome !== d.outcome || row.partial === "possible";
  });
  if (unmet.length) {
    throw new ApiError(409, "DEPENDENCY_UNRESOLVED",
      `Dependencies are not in their required outcome: ${unmet.map((d) => `${d.effect} (needs ${d.outcome}, is ${byId.get(d.effect)?.outcome ?? "not found"})`).join(", ")}.`,
      { unmet: unmet.map((d) => ({ effect: d.effect, required: d.outcome, actual: byId.get(d.effect)?.outcome ?? null })) });
  }
  return dependsOn.map((d) => ({ effectId: d.effect, outcome: d.outcome }));
}

async function checkCompensates(workspaceId: string, environmentId: string, effectId: string | null | undefined) {
  if (!effectId) return null;
  const [row] = await db.select({ outcome: actionEffects.outcome, partial: actionEffects.partialEffect }).from(actionEffects).where(and(
    eq(actionEffects.workspaceId, workspaceId), eq(actionEffects.environmentId, environmentId), eq(actionEffects.effectId, effectId),
  ));
  if (!row) throw new NotFoundError("Effect to compensate");
  if (row.outcome !== "succeeded" && !(row.outcome === "failed" && row.partial !== "none")) {
    throw new ConflictError(`${effectId} has no confirmed or possible impact to compensate (outcome ${row.outcome}).`);
  }
  return effectId;
}

export async function prepareEffectAdmission(opts: EffectAdmissionOptions): Promise<AdmissionResult> {
  const { adapter, config } = adapterFromSpec(opts.spec);
  const { operation, impact } = await normalizeFor(adapter, config, opts.input, {
    workspaceId: opts.workspaceId, environmentId: opts.environmentId, endUserId: opts.endUserId ?? null,
  });
  const digest = requestDigest({
    actionName: opts.action.name,
    adapterType: adapter.type,
    request: operation.request,
    target: operation.target as unknown as Record<string, unknown>,
  });

  const operationKey = opts.operationKey ?? `op_${nanoid(24)}`;
  const existing = await effectByOperationKey(opts.workspaceId, opts.environmentId, operationKey);
  if (existing) {
    if (!isSameOperation(existing, digest, opts.endUserId)) throw operationKeyConflict(operationKey);
    return { kind: "existing", effect: existing };
  }

  const dependsOn = await checkDependencies(opts.workspaceId, opts.environmentId, opts.dependsOn ?? []);
  const compensates = await checkCompensates(opts.workspaceId, opts.environmentId, opts.compensates);

  let preview: EffectPreview | null = null;
  if (opts.previewId) {
    preview = await previewRow(opts.workspaceId, opts.environmentId, opts.previewId);
    await assertPreviewMatches(preview, {
      actionRowId: opts.action.id, actionVersionId: opts.actionVersionId, adapter, requestDigest: digest, endUserId: opts.endUserId ?? null,
    });
  }

  return {
    kind: "new",
    admission: {
      adapter, operation, impact, requestDigest: digest, operationKey, preview, dependsOn, compensates, actionVersionId: opts.actionVersionId,
      source: {
        action: opts.action, actionVersionId: opts.actionVersionId, spec: opts.spec, input: opts.input,
        requestedByKeyId: opts.requestedByKeyId, endUserId: opts.endUserId ?? null,
      },
    },
  };
}

export async function previewAdmission(draft: EffectAdmissionDraft): Promise<{ admission: EffectAdmission; built: boolean }> {
  const { source, ...rest } = draft;
  if (draft.preview) return { admission: { ...rest, preview: draft.preview }, built: false };
  const preview = await buildPreview(
    { action: source.action, actionVersionId: source.actionVersionId, spec: source.spec },
    source.input,
    {
      requestedByKeyId: source.requestedByKeyId,
      ttlSeconds: implicitPreviewTtlSeconds(await approvalWindowHoursFor(source.action.workspaceId)),
      endUserId: source.endUserId ?? null,
    },
  );
  if (preview.requestDigest !== draft.requestDigest) throw new ConflictError("The preview normalized a different request.");
  return { admission: { ...rest, preview }, built: true };
}

export async function discardUnboundPreview(previewRowId: string): Promise<void> {
  await db.delete(effectPreviews).where(and(
    eq(effectPreviews.id, previewRowId),
    sql`not exists (select 1 from ${actionEffects} where ${actionEffects.previewId} = ${previewRowId})`,
  ));
}

export async function insertEffectIn(
  tx: Pick<typeof db, "insert">,
  admission: EffectAdmission,
  invocation: InvocationRow,
  gated: boolean,
  effectId: string,
): Promise<ActionEffect> {
  const [effect] = await tx.insert(actionEffects).values({
    workspaceId: invocation.workspaceId,
    environmentId: invocation.environmentId,
    actionId: invocation.actionId,
    invocationId: invocation.id,
    effectId,
    operationKey: admission.operationKey,
    requestDigest: admission.requestDigest,
    actionName: admission.preview.actionName,
    actionVersionId: admission.actionVersionId,
    adapterType: admission.adapter.type,
    adapterVersion: admission.adapter.version,
    requestedByKeyId: invocation.requestedByKeyId,
    endUserId: invocation.endUserId,
    targetAccount: admission.operation.target.account,
    resourceKey: admission.operation.target.resourceKey,
    target: admission.operation.target as unknown as Record<string, unknown>,
    request: admission.operation.request,
    impact: admission.impact as unknown as Array<Record<string, unknown>>,
    capabilities: admission.adapter.capabilities as unknown as Record<string, unknown>,
    providerIdempotencyKey: `anlyon-${effectId}`,
    previewId: admission.preview.id,
    bindingDigest: admission.preview.bindingDigest,
    dependsOn: admission.dependsOn,
    compensatesEffectId: admission.compensates,
    stage: gated ? "awaiting_approval" : "ready",
  }).returning();
  const evidence = admission.preview.evidence as Record<string, unknown>;
  await tx.insert(effectEvidence).values([
    {
      workspaceId: effect.workspaceId, environmentId: effect.environmentId, effectId: effect.id,
      source: "preview",
      observedAt: admission.preview.evidenceObservedAt,
      impliedOutcome: null,
      providerIds: (evidence.providerIds as Record<string, string>) ?? {},
      summary: `Reviewed as ${admission.preview.previewId}: ${String(evidence.summary ?? "")}`.slice(0, 1000),
      details: boundDetails({ preconditions: admission.preview.preconditions, ...((evidence.details as object) ?? {}) }),
    },
  ]);
  return effect;
}

export function boundDetails(details: Record<string, unknown>): Record<string, unknown> {
  const clean = storableValue(details ?? {}) as Record<string, unknown>;
  const text = JSON.stringify(clean);
  if (Buffer.byteLength(text, "utf8") <= MAX_EVIDENCE_DETAIL_BYTES) return clean;
  return { truncated: true, excerpt: stripUnstorable(text.slice(0, MAX_EVIDENCE_DETAIL_BYTES / 2)) };
}

async function insertEvidenceIn(
  tx: Tx,
  effect: ActionEffect,
  drafts: Array<EvidenceDraft | { source: "operator_note" | "manual_resolution"; observedAt: Date; impliedOutcome: string | null; providerIds: Record<string, string>; summary: string; details: Record<string, unknown> }>,
  meta: { attemptId?: string | null; actor?: { type: "api_key" | "user"; id: string } | null },
) {
  if (!drafts.length) return;
  await tx.insert(effectEvidence).values(drafts.map((draft) => ({
    workspaceId: effect.workspaceId,
    environmentId: effect.environmentId,
    effectId: effect.id,
    attemptId: meta.attemptId ?? null,
    source: draft.source,
    observedAt: draft.observedAt,
    impliedOutcome: draft.impliedOutcome,
    providerIds: draft.providerIds,
    summary: draft.summary.slice(0, 1000),
    details: boundDetails(draft.details),
    actorType: (meta.actor?.type ?? "system") as "api_key" | "user" | "system",
    actorId: meta.actor?.id ?? null,
  })));
}

export function stageFor(outcome: "pending" | "succeeded" | "failed" | "unknown", partial: PartialEffect) {
  if (outcome === "succeeded") return "settled" as const;
  if (outcome === "failed") return partial === "possible" ? "reconciling" as const : "settled" as const;
  return "reconciling" as const;
}

export interface ApplyMeta {
  attemptId?: string | null;
  source: "provider" | "manual";
  actor?: { type: "api_key" | "user"; id: string } | null;
  observation?: Observation | null;
  durationMs?: number | null;
  reconcileOwner?: string | null;
  usageOnFailure?: "billed" | "released";
  verified?: boolean;
}

export function successIsVerified(adapter: AnyEffectAdapter, interpretation: Interpretation): boolean {
  return interpretation.outcome === "succeeded" &&
    (adapter.successEvidence === "provider_record" || interpretation.verified === true);
}

export async function applyInterpretationIn(
  tx: Tx,
  effect: ActionEffect,
  invocation: InvocationRow,
  interpretation: Interpretation,
  meta: ApplyMeta,
): Promise<ActionEffect> {
  const now = await readDbNow(tx);
  await insertEvidenceIn(tx, effect, interpretation.evidence, meta);
  if (meta.attemptId) {
    await tx.update(effectAttempts)
      .set({ status: "completed", observedOutcome: interpretation.outcome, finishedAt: now })
      .where(and(eq(effectAttempts.id, meta.attemptId), eq(effectAttempts.status, "started")));
  }

  const ownsLease = meta.reconcileOwner != null && effect.reconcileLeaseOwner === meta.reconcileOwner;
  if (effect.outcome === "succeeded" || effect.outcome === "failed") {
    if (ownsLease) {
      const [released] = await tx.update(actionEffects)
        .set({ reconcileLeaseOwner: null, reconcileLeaseUntil: null, nextReconcileAt: null, updatedAt: now })
        .where(eq(actionEffects.id, effect.id)).returning();
      return released;
    }
    return effect;
  }

  const outcome = interpretation.outcome;
  const partial = interpretation.partialEffect;
  const unresolved = outcome === "pending" || outcome === "unknown";
  const exhausted = unresolved && effect.reconcileAttempts >= MAX_RECONCILE_ATTEMPTS;
  const leaseHeldByOther = effect.reconcileLeaseOwner !== null && !ownsLease &&
    effect.reconcileLeaseUntil !== null && effect.reconcileLeaseUntil.getTime() > now.getTime();

  const [updated] = await tx.update(actionEffects).set({
    outcome,
    partialEffect: partial,
    stage: stageFor(outcome, partial),
    outcomeSource: unresolved
      ? null
      : meta.observation?.kind === "transport_error" && !meta.observation.requestSent ? "system" : meta.source,
    outcomeVerified: outcome === "succeeded" && meta.source === "provider" && meta.verified === true,
    providerReference: effect.providerReference ?? interpretation.providerReference ?? null,
    outcomeAt: unresolved ? effect.outcomeAt : now,
    firstDispatchedAt: effect.firstDispatchedAt ?? now,
    nextReconcileAt: unresolved && !exhausted
      ? (leaseHeldByOther ? effect.nextReconcileAt : new Date(now.getTime() + reconcileBackoffMs(effect.reconcileAttempts)))
      : null,
    reconcileExhausted: exhausted,
    ...(ownsLease || !unresolved ? { reconcileLeaseOwner: null, reconcileLeaseUntil: null } : {}),
    updatedAt: now,
  }).where(eq(actionEffects.id, effect.id)).returning();

  if (exhausted && !effect.reconcileExhausted) {
    await insertEvidenceIn(tx, updated, [{
      source: "system", observedAt: now, impliedOutcome: null, providerIds: {},
      summary: `Automatic reconciliation stopped after ${effect.reconcileAttempts} attempts. The outcome stays ${outcome}; an operator must reconcile or resolve it.`,
      details: {},
    }], {});
  }

  await applyOutcomeToImpactIn(tx, effect.id, outcome, partial, interpretation.actualImpact);
  await updateInvocationForOutcomeIn(tx, updated, invocation, meta, interpretation.evidence);
  return updated;
}

function codedFailureReason(evidence: Interpretation["evidence"]): string | null {
  for (const item of evidence) {
    const code = item.details?.code;
    if (item.source === "system" && typeof code === "string") return `${code}: ${item.summary}`;
  }
  return null;
}

async function updateInvocationForOutcomeIn(tx: Tx, effect: ActionEffect, invocation: InvocationRow, meta: ApplyMeta, evidence: Interpretation["evidence"]) {
  const observation = meta.observation;
  const response = observation?.kind === "response"
    ? { responseStatus: observation.status, responseBody: observation.bodyText.slice(0, env.ACTION_MAX_RESPONSE_BYTES) }
    : {};
  const common = { ...response, ...(meta.durationMs != null ? { durationMs: meta.durationMs } : {}) };
  switch (effect.outcome) {
    case "succeeded":
      await recordInvocationOutcomeIn(tx, invocation.workspaceId, invocation.id,
        { ...common, status: "succeeded", errorMessage: null, completedAt: sql`(clock_timestamp() at time zone 'utc')` }, "billed");
      return;
    case "failed":
      await recordInvocationOutcomeIn(tx, invocation.workspaceId, invocation.id, {
        ...common,
        status: "failed",
        errorMessage: codedFailureReason(evidence) ?? `Effect ${effect.effectId} failed${effect.outcomeSource === "manual" ? " (resolved by an operator)" : ""}.`,
        completedAt: sql`(clock_timestamp() at time zone 'utc')`,
      }, meta.source === "manual" ? "released" : meta.usageOnFailure ?? "released");
      return;
    case "pending":
      await recordInvocationOutcomeIn(tx, invocation.workspaceId, invocation.id, { ...common, status: "running" }, "unknown");
      return;
    case "unknown":
      await recordInvocationOutcomeIn(tx, invocation.workspaceId, invocation.id, {
        ...common,
        status: "unknown",
        errorMessage: `The provider may have applied effect ${effect.effectId}; Anlyon is reconciling it. Do not retry; inspect the effect.`,
        completedAt: invocation.completedAt ?? sql`(clock_timestamp() at time zone 'utc')`,
      }, "unknown");
      return;
    default:
      return;
  }
}

export async function lockEffectChain(tx: Tx, effect: Pick<ActionEffect, "id" | "workspaceId" | "invocationId">) {
  await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, effect.workspaceId)).for("update");
  const [invocation] = await tx.select().from(actionInvocations).where(eq(actionInvocations.id, effect.invocationId)).for("update");
  const [locked] = await tx.select().from(actionEffects).where(eq(actionEffects.id, effect.id)).for("update");
  if (!locked || !invocation) throw new NotFoundError("Effect");
  return { invocation, effect: locked };
}

export async function recordInterpretation(effect: ActionEffect, interpretation: Interpretation, meta: ApplyMeta) {
  const { stoppedNow, ...result } = await db.transaction(async (tx) => {
    const locked = await lockEffectChain(tx, effect);
    const updated = await applyInterpretationIn(tx, locked.effect, locked.invocation, interpretation, meta);
    const [invocation] = await tx.select().from(actionInvocations).where(eq(actionInvocations.id, effect.invocationId));
    return { effect: updated, invocation, stoppedNow: updated.reconcileExhausted && !locked.effect.reconcileExhausted };
  });
  await traceEffect(result.effect, result.invocation);
  if (stoppedNow) await notifyOutcomeNeedsPerson(result.effect);
  return result;
}

async function notifyOutcomeNeedsPerson(effect: ActionEffect): Promise<void> {
  const params = new URLSearchParams({ effect: effect.effectId, environmentId: effect.environmentId });
  await notifyTeamIfEnabled({
    workspaceId: effect.workspaceId,
    type: "outcome_unknown",
    priority: "high",
    title: `Outcome unknown: ${effect.actionName}`,
    message:
      `The provider never confirmed whether this call went through, and automatic checks have stopped. ` +
      `Check the provider, then record what happened. Its share of any limit stays held until then.`,
    metadata: { effectId: effect.effectId, environmentId: effect.environmentId, outcome: effect.outcome },
    actionUrl: `${env.CONSOLE_URL}/actions/effects?${params}`,
    actionLabel: "Review",
  });
}

export async function traceEffect(effect: ActionEffect, invocation: InvocationRow): Promise<void> {
  if (!invocation.traceRunId) return;
  const scope = { workspaceId: effect.workspaceId, environmentId: effect.environmentId };
  try {
    await getRunWithTree(scope, invocation.traceRunId);
    const [action] = await db.select({ actionId: actions.actionId }).from(actions).where(eq(actions.id, effect.actionId));
    const settled = effect.stage === "rejected" || effect.outcome === "succeeded" || effect.outcome === "failed";
    const status = effect.outcome === "succeeded" ? "succeeded" : settled ? "failed" : "running";
    await ingestSpans(scope, invocation.traceRunId, [{
      id: `action_${invocation.invocationId}`,
      ...(invocation.traceParentSpanId ? { parentId: invocation.traceParentSpanId } : {}),
      name: effect.actionName,
      type: "action_call",
      status,
      startedAt: (effect.firstDispatchedAt ?? invocation.createdAt).toISOString(),
      ...(settled ? { endedAt: (effect.outcomeAt ?? effect.updatedAt).toISOString() } : {}),
      input: invocation.input,
      output: { effectId: effect.effectId, outcome: effect.outcome, providerReference: effect.providerReference },
      ...(status === "failed" ? { error: { message: invocation.errorMessage ?? effect.rejectionReason ?? `Effect ${effect.effectId} failed.` } } : {}),
      attributes: {
        actionId: action?.actionId ?? null,
        invocationId: invocation.invocationId,
        effectId: effect.effectId,
        adapter: effect.adapterType,
        stage: effect.stage,
        outcome: effect.outcome,
        verification: effect.outcomeSource ?? null,
        durationMs: invocation.durationMs ?? null,
      },
    }]);
  } catch {
  }
}

export async function rejectEffectIn(tx: Tx, effect: ActionEffect, invocation: InvocationRow, rejection: EffectRejection, invocationStatus: "failed" | "denied" | "expired" = "failed") {
  if (effect.stage !== "awaiting_approval" && effect.stage !== "ready") return effect;
  const now = await readDbNow(tx);
  const [updated] = await tx.update(actionEffects).set({
    stage: "rejected",
    rejectionReason: rejection.reason,
    outcomeSource: "system",
    nextReconcileAt: null,
    updatedAt: now,
  }).where(eq(actionEffects.id, effect.id)).returning();
  await insertEvidenceIn(tx, updated, [{
    source: "system", observedAt: now, impliedOutcome: null, providerIds: {},
    summary: `Not dispatched: ${rejection.message}`, details: { reason: rejection.reason, ...rejection.details },
  }], {});
  await releaseUndispatchedIn(tx, effect.id);
  if (invocationStatus === "failed") {
    await recordInvocationOutcomeIn(tx, invocation.workspaceId, invocation.id, {
      status: "failed",
      errorMessage: `Dispatch refused (${rejection.reason}): ${rejection.message}`,
      completedAt: sql`(clock_timestamp() at time zone 'utc')`,
    }, "released");
  }
  return updated;
}

export async function rejectEffectForInvocationIn(tx: Tx, invocationRowId: string, status: "denied" | "expired") {
  const [effect] = await tx.select().from(actionEffects).where(eq(actionEffects.invocationId, invocationRowId)).for("update");
  if (!effect) return;
  const [invocation] = await tx.select().from(actionInvocations).where(eq(actionInvocations.id, invocationRowId));
  await rejectEffectIn(tx, effect, invocation,
    new EffectRejection(status === "denied" ? "approval_denied" : "approval_expired", `The approval was ${status}.`), status);
}

async function assertAuthorityCurrent(tx: Tx, effect: ActionEffect, now: Date) {
  if (!effect.requestedByKeyId) return;
  const [key] = await tx.select().from(apiKeys).where(eq(apiKeys.id, effect.requestedByKeyId));
  const revoked = !key || key.isActive !== "true" || key.workspaceId !== effect.workspaceId ||
    key.environmentId !== effect.environmentId || (key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime());
  if (revoked) throw new EffectRejection("authority_revoked", "The credential that requested this effect is no longer active in this environment.");
  if (key.budgetPrincipal === null) {
    const scopes = key.scopes ?? [...DEFAULT_API_KEY_SCOPES];
    if (!scopes.includes("actions:invoke")) {
      throw new EffectRejection("authority_revoked", "The requesting credential no longer holds actions:invoke.");
    }
  }
}

async function assertBindingAndApproval(tx: Tx, effect: ActionEffect, preview: EffectPreview | undefined, now: Date) {
  if (!preview || !effect.bindingDigest) throw new EffectRejection("binding_missing", "This effect has no reviewed preview.");
  if (preview.bindingDigest !== effect.bindingDigest || recomputeBinding(preview) !== effect.bindingDigest) {
    throw new EffectRejection("binding_mismatch", "The reviewed preview does not verify against this effect.");
  }
  const recomputedRequest = requestDigest({ actionName: effect.actionName, adapterType: effect.adapterType, request: effect.request, target: effect.target });
  if (recomputedRequest !== effect.requestDigest || preview.requestDigest !== effect.requestDigest) {
    throw new EffectRejection("binding_mismatch", "The persisted request does not match what was reviewed.");
  }
  if (preview.expiresAt.getTime() <= now.getTime()) {
    throw new EffectRejection("preview_expired", `The reviewed preview expired at ${preview.expiresAt.toISOString()}. A new preview and approval are required.`);
  }
  if (effect.approvalId) {
    const [approval] = await tx.select().from(approvals).where(and(
      eq(approvals.workspaceId, effect.workspaceId), eq(approvals.environmentId, effect.environmentId), eq(approvals.approvalId, effect.approvalId),
    ));
    if (approval?.status === "pending") throw new EffectRejection("approval_pending", "The approval for this effect is still pending.");
    if (!approval || approval.status !== "approved") throw new EffectRejection("approval_missing", "The approval for this effect is not approved.");
    if (approval.bindingDigest !== effect.bindingDigest) {
      throw new EffectRejection("binding_mismatch", "The approval was given for a different operation than this effect.");
    }
  } else if (effect.stage === "awaiting_approval") {
    throw new EffectRejection("approval_missing", "This effect is waiting for an approval.");
  }
}

async function assertActionUnchanged(effect: ActionEffect, invocation: InvocationRow, action: ActionRow, version: VersionAdapter) {
  if (action.archivedAt || !action.enabled) throw new EffectRejection("action_disabled", "The action is disabled or archived.");
  const { adapter } = version;
  if (adapter.type !== effect.adapterType || adapter.version !== effect.adapterVersion) {
    throw new EffectRejection("adapter_changed", `Adapter ${effect.adapterType} v${effect.adapterVersion} was reviewed. This deployment runs ${adapter.type} v${adapter.version}.`);
  }
  let agentId: string | null = null;
  if (invocation.traceRunId) {
    try {
      agentId = (await getRunIdentity({ workspaceId: effect.workspaceId, environmentId: effect.environmentId }, invocation.traceRunId)).agentId;
    } catch {
      agentId = null;
    }
  }
  const current = await resolvePinnedDefinition(action, agentId).catch(() => null);
  if (!current || current.actionVersionId !== effect.actionVersionId) {
    throw new EffectRejection("action_changed",
      `This effect was reviewed against ${effect.actionVersionId}; the action now resolves to ${current?.actionVersionId ?? "nothing"}. A new preview and approval are required.`);
  }
}

async function assertPolicyStillAllows(effect: ActionEffect, invocation: InvocationRow, requiresApproval: boolean) {
  let identity = { agentId: null as string | null, userId: null as string | null };
  if (invocation.traceRunId) {
    try {
      identity = await getRunIdentity({ workspaceId: effect.workspaceId, environmentId: effect.environmentId }, invocation.traceRunId);
    } catch {}
  }
  const decision = applyRiskFloor(requiresApproval, await evaluatePolicies(effect.environmentId, {
    kind: "action",
    actionName: effect.actionName,
    agentId: identity.agentId,
    userId: identity.userId,
    ...policyAmount(effect.impact as unknown as ImpactQuantity[]),
    payload: (invocation.input as Record<string, unknown>) ?? {},
  }));
  if (decision.matched && decision.effect === "auto_deny") {
    throw new EffectRejection("policy_denies", `Policy ${decision.matchedPolicyName ?? decision.matchedPolicyId} now denies this operation.`);
  }
  if (!effect.approvalId && shouldGate(requiresApproval, decision)) {
    throw new EffectRejection("approval_required", "Policy now requires approval for this operation; it was admitted without one.");
  }
}

async function assertDependenciesHold(effect: ActionEffect) {
  if (!effect.dependsOn.length) return;
  try {
    await checkDependencies(effect.workspaceId, effect.environmentId, effect.dependsOn.map((d) => ({ effect: d.effectId, outcome: d.outcome })));
  } catch (error) {
    throw new EffectRejection("dependency_unresolved", error instanceof Error ? error.message : "Dependencies are not satisfied.");
  }
}

export async function assertExecutionControlsIn(
  tx: Tx,
  input: {
    effect: ActionEffect; invocation: InvocationRow; action: ActionRow; preview: EffectPreview | undefined; now: Date;
    version: VersionAdapter;
  },
): Promise<void> {
  const { effect, invocation, action, preview, now, version } = input;
  await assertBindingAndApproval(tx, effect, preview, now);
  await assertActionUnchanged(effect, invocation, action, version);
  if (await isEnvironmentHalted(effect.environmentId)) {
    throw new EffectRejection("environment_halted", "The environment is halted.");
  }
  await assertAuthorityCurrent(tx, effect, now);
  await assertPolicyStillAllows(effect, invocation, version.requiresApproval);
  await assertDependenciesHold(effect);
}

type Claim =
  | { kind: "claimed"; effect: ActionEffect; attempt: EffectAttempt }
  | { kind: "not_claimable"; effect: ActionEffect };

export async function claimDispatch(effectRow: ActionEffect, action: ActionRow, version: VersionAdapter): Promise<Claim> {
  return db.transaction(async (tx) => {
    const { invocation, effect } = await lockEffectChain(tx, effectRow);
    if (effect.stage !== "awaiting_approval" && effect.stage !== "ready") return { kind: "not_claimable", effect };
    const now = await readDbNow(tx);
    const [preview] = effect.previewId
      ? await tx.select().from(effectPreviews).where(eq(effectPreviews.id, effect.previewId))
      : [];
    await assertExecutionControlsIn(tx, { effect, invocation, action, preview, now, version });
    const reserved = await reserveImpactIn(tx, effect.id, {
      workspaceId: effect.workspaceId,
      environmentId: effect.environmentId,
      actionName: effect.actionName,
      resourceKey: effect.resourceKey,
      impact: effect.impact as unknown as ImpactQuantity[],
      dimensions: version.adapter.capabilities.impactDimensions,
      endUserId: effect.endUserId,
    }, now);

    const [claimed] = await tx.update(actionEffects).set({
      stage: "dispatching",
      approvalConsumedAt: effect.approvalId ? now : null,
      firstDispatchedAt: now,
      updatedAt: now,
    }).where(and(eq(actionEffects.id, effect.id), inArray(actionEffects.stage, ["awaiting_approval", "ready"]))).returning();
    const [attempt] = await tx.insert(effectAttempts).values({
      workspaceId: effect.workspaceId,
      environmentId: effect.environmentId,
      effectId: effect.id,
      attemptNo: 1,
      kind: "dispatch",
      leaseOwner: leaseOwner(),
      leaseUntil: new Date(now.getTime() + DISPATCH_LEASE_MS()),
    }).returning();
    await insertEvidenceIn(tx, claimed, [{
      source: "system", observedAt: now, impliedOutcome: null, providerIds: {},
      summary: "Dispatch authorized: binding, expiry, approval, action version, halt state, authority, policy, dependencies and allowance verified.",
      details: { reservations: reserved, previewExpiresAt: preview!.expiresAt.toISOString() },
    }], { attemptId: attempt.id });
    return { kind: "claimed", effect: claimed, attempt };
  });
}

async function observe(fn: () => Promise<Observation>): Promise<Observation> {
  try {
    return await fn();
  } catch (error) {
    const requestSent = error instanceof TransportError ? error.requestSent : true;
    return {
      kind: "transport_error",
      requestSent,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      observedAt: new Date(),
    };
  }
}

function safeInterpret(adapter: AnyEffectAdapter, request: DispatchRequest, observation: Observation): Interpretation {
  try {
    return adapter.interpret(request, observation);
  } catch (error) {
    return {
      outcome: "unknown",
      partialEffect: "none",
      providerReference: null,
      evidence: [{
        source: "system", observedAt: new Date(), impliedOutcome: "unknown", providerIds: {},
        summary: "The provider's answer could not be interpreted.",
        details: { error: error instanceof Error ? error.message.slice(0, 300) : "error" },
      }],
    };
  }
}

export function onlyProvenFailure(interpretation: Interpretation, source: "lookup" | "replay", current: ActionEffect["outcome"]): Interpretation {
  if (interpretation.outcome !== "failed" || interpretation.failureProof) return interpretation;
  const keep = current === "pending" ? "pending" : "unknown";
  return {
    ...interpretation,
    outcome: keep,
    partialEffect: "none",
    providerReference: null,
    evidence: [...interpretation.evidence, {
      source: "system", observedAt: new Date(), impliedOutcome: null, providerIds: {},
      summary: source === "replay"
        ? `The replay attempt failed, which says nothing about the original write. The outcome stays ${keep} and its allowance stays held.`
        : `The lookup found no proof that the original write failed. The outcome stays ${keep} and its allowance stays held.`,
      details: {},
    }],
  };
}

export function dispatchRequestFor(effect: ActionEffect, preview: EffectPreview, kind: "dispatch" | "replay"): DispatchRequest {
  return {
    effectId: effect.effectId,
    operation: { target: effect.target as unknown as NormalizedOperation["target"], request: effect.request },
    preconditions: preview.preconditions,
    idempotencyKey: effect.providerIdempotencyKey!,
    kind,
  };
}

export async function effectForInvocation(invocationRowId: string) {
  const [effect] = await db.select().from(actionEffects).where(eq(actionEffects.invocationId, invocationRowId));
  return effect ?? null;
}

export async function effectGradeForInvocation(invocationRowId: string): Promise<EffectGrade | null> {
  const [row] = await db.select({ grade: actionEffects.grade }).from(actionEffects).where(eq(actionEffects.invocationId, invocationRowId));
  return row?.grade ?? null;
}

async function rejectAndReport(effect: ActionEffect, rejection: EffectRejection, action: ActionRow): Promise<InvocationResult> {
  const { invocation, rejected } = await db.transaction(async (tx) => {
    const locked = await lockEffectChain(tx, effect);
    const rejected = await rejectEffectIn(tx, locked.effect, locked.invocation, rejection);
    const [row] = await tx.select().from(actionInvocations).where(eq(actionInvocations.id, effect.invocationId));
    return { invocation: row, rejected };
  });
  await traceEffect(rejected, invocation);
  logger.info({ effectId: effect.effectId, reason: rejection.reason }, "Effect dispatch refused");
  emitEvent(effect.workspaceId, "action.invocation.blocked", {
    environmentId: effect.environmentId, actionId: action.actionId, invocationId: invocation.invocationId,
    effectId: effect.effectId, reason: rejection.reason,
  });
  return toInvocation(invocation, action.name);
}

async function verifyAccepted(
  effect: ActionEffect,
  adapter: AnyEffectAdapter,
  ctx: Awaited<ReturnType<typeof buildAdapterContext>>,
  request: DispatchRequest,
  response: unknown,
  attemptId: string,
): Promise<ActionEffect> {
  if (!adapter.verify) return effect;
  let result: VerifyResult;
  try {
    result = await adapter.verify(ctx, { effectId: effect.effectId, operation: request.operation, response, now: new Date() });
  } catch (error) {
    result = {
      matched: false,
      evidence: [{
        source: "system", observedAt: new Date(), impliedOutcome: null, providerIds: {},
        summary: "The read-back could not be completed. The result stays acknowledged.",
        details: { error: error instanceof Error ? error.message.slice(0, 300) : "error" },
      }],
    };
  }
  return db.transaction(async (tx) => {
    const { effect: locked } = await lockEffectChain(tx, effect);
    await insertEvidenceIn(tx, locked, result.evidence, { attemptId });
    if (!result.matched || locked.outcome !== "succeeded" || locked.outcomeSource !== "provider" || locked.outcomeVerified) return locked;
    const [verified] = await tx.update(actionEffects).set({ outcomeVerified: true, updatedAt: await readDbNow(tx) })
      .where(eq(actionEffects.id, locked.id)).returning();
    return verified;
  });
}

export async function executeEffectInvocation(action: ActionRow, invocation: InvocationRow): Promise<InvocationResult> {
  const current = async () => {
    const [row] = await db.select().from(actionInvocations).where(eq(actionInvocations.id, invocation.id));
    return markNotDispatchedHere(toInvocation(row, action.name));
  };
  const effect = await effectForInvocation(invocation.id);
  if (effect?.approvalId) {
    const [approval] = await db.select({ status: approvals.status }).from(approvals).where(and(
      eq(approvals.workspaceId, effect.workspaceId), eq(approvals.environmentId, effect.environmentId), eq(approvals.approvalId, effect.approvalId),
    ));
    if (approval?.status === "pending") return current();
  }
  if (!await reserveActionExecution(invocation.workspaceId, invocation.id)) return current();
  if (!effect) {
    const rejected = await db.transaction((tx) => recordInvocationOutcomeIn(tx, invocation.workspaceId, invocation.id, {
      status: "failed", errorMessage: "No effect is recorded for this invocation; nothing was dispatched.",
      completedAt: sql`(clock_timestamp() at time zone 'utc')`,
    }, "released"));
    return toInvocation(rejected, action.name);
  }
  return dispatchEffect(effect, action);
}

export async function dispatchEffect(effect: ActionEffect, action: ActionRow): Promise<InvocationResult> {
  const started = performance.now();
  let version: VersionAdapter;
  let ctx: Awaited<ReturnType<typeof buildAdapterContext>>;
  try {
    version = await loadVersionAdapter(action.id, effect.actionVersionId);
    ctx = await buildAdapterContext(effect, version.adapter, version.config, version.spec);
  } catch (error) {
    const code = error instanceof Error && typeof (error as unknown as { code?: unknown }).code === "string" ? (error as unknown as { code: string }).code : null;
    const result = await rejectAndReport(effect, new EffectRejection("credential_unavailable",
      error instanceof Error ? error.message : "The credential could not be resolved.", code ? { code } : {}), action);
    if (error instanceof EndUserConnectionError) markEndUserFailure(result, error);
    return result;
  }

  let claim: Claim;
  try {
    claim = await claimDispatch(effect, action, version);
  } catch (error) {
    if (error instanceof EffectRejection && error.reason === "approval_pending") {
      claim = { kind: "not_claimable", effect };
    } else if (error instanceof EffectRejection) {
      return rejectAndReport(effect, error, action);
    } else {
      throw error;
    }
  }
  if (claim.kind === "not_claimable") {
    const [row] = await db.select().from(actionInvocations).where(eq(actionInvocations.id, effect.invocationId));
    return toInvocation(row, action.name);
  }

  const [preview] = await db.select().from(effectPreviews).where(eq(effectPreviews.id, claim.effect.previewId!));
  const request = dispatchRequestFor(claim.effect, preview, "dispatch");
  const observation = await observe(() => version.adapter.dispatch(ctx, request));
  if (observation.kind === "response" && observation.status === 401 && !effect.endUserId) {
    probeRejectedCredentials({ workspaceId: effect.workspaceId, environmentId: effect.environmentId }, secretNamesOf(version.spec));
  }
  const interpretation = safeInterpret(version.adapter, request, observation);
  const recorded = await recordInterpretation(claim.effect, interpretation, {
    attemptId: claim.attempt.id,
    source: "provider",
    observation,
    durationMs: Math.round(performance.now() - started),
    usageOnFailure: observation.kind === "response" ? "billed" : "released",
    verified: successIsVerified(version.adapter, interpretation),
  });
  const updated = recorded.invocation;
  let after = recorded.effect;
  if (after.outcome === "succeeded" && !after.outcomeVerified && observation.kind === "response") {
    try {
      after = await verifyAccepted(after, version.adapter, ctx, request, observation.json, claim.attempt.id);
    } catch (error) {
      logger.error({ effectId: after.effectId, error }, "Recording an effect's read-back failed");
    }
  }
  logger.info(
    { effectId: after.effectId, adapter: after.adapterType, outcome: after.outcome, stage: after.stage, grade: after.grade },
    "Effect dispatched",
  );
  emitEvent(after.workspaceId, `action.${after.outcome === "pending" ? "pending" : after.outcome}`, {
    environmentId: after.environmentId, actionId: action.actionId, actionName: action.name,
    invocationId: updated.invocationId, effectId: after.effectId,
    ...(after.endUserId ? { endUserId: after.endUserId } : {}),
  });
  return toInvocation(updated, action.name);
}

function secretNamesOf(spec: GovernedSpec): string[] {
  if (spec.kind === "declared") {
    const d = spec.definition;
    return extractSecretNames(d.urlTemplate, d.headers, d.bodyTemplate, d.declarations.verify?.url ?? null);
  }
  if (spec.kind === "mcp") return extractSecretNames(spec.definition.urlTemplate, spec.definition.headers, null, null);
  return [spec.adapter.credentialSecret];
}

export async function nextAttemptNo(executor: Pick<typeof db, "select">, effectRowId: string): Promise<number> {
  const [row] = await executor.select({ n: max(effectAttempts.attemptNo) }).from(effectAttempts)
    .where(eq(effectAttempts.effectId, effectRowId));
  return Number(row?.n ?? 0) + 1;
}

export async function evidenceHistory(effectRowId: string) {
  const rows = await db.select().from(effectEvidence).where(eq(effectEvidence.effectId, effectRowId))
    .orderBy(asc(effectEvidence.createdAt));
  return rows.map((row) => ({ source: row.source, impliedOutcome: row.impliedOutcome, observedAt: row.observedAt, providerIds: row.providerIds }));
}

export { insertEvidenceIn, observe, safeInterpret };
