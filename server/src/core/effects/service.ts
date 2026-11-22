import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { readDbNow } from "../../db/clock.ts";
import { actions, actionInvocations } from "../../db/schema/actions.ts";
import {
  actionEffects,
  effectAttempts,
  effectEvidence,
  effectPreviews,
  type ActionEffect,
  type EffectGrade,
  type EffectOutcome,
  type EffectStage,
  type PartialEffect,
} from "../../db/schema/effects.ts";
import { AuthorizationError, ConflictError, ValidationError } from "../../utils/errors.ts";
import type { ImpactQuantity } from "./adapter.ts";
import { assertActualImpactMatches, reservationsFor } from "./impact.ts";
import { applyInterpretationIn, insertEvidenceIn, lockEffectChain, traceEffect } from "./lifecycle.ts";
import { buildPreview, previewRow, toPreviewView, type PreviewView } from "./previews.ts";
import { resolveActionRow, resolvePinnedDefinition } from "../actions/definitions.ts";
import { governedSpecOf, loadVersionAdapter } from "./context.ts";
import { getRunIdentity } from "../runs/service.ts";
import { actingForCondition, type ActingFor } from "../end-users/acting-for.ts";
import { effectRowByPublicId, reconcileEffectNow, replayEffect } from "./reconcile.ts";
import { applyOutcomeToImpactIn } from "./impact.ts";

export interface Actor {
  type: "api_key" | "user";
  id: string;
}

export type Verification = "provider" | "manual" | "unverified" | "not_dispatched";

export interface EffectView {
  id: string;
  invocationId: string;
  operationKey: string;
  environmentId: string;
  action: { name: string; versionId: string };
  adapter: { type: string; version: string };
  stage: EffectStage;
  outcome: EffectOutcome;
  partialEffect: PartialEffect;
  grade: EffectGrade;
  verification: Verification;
  providerReference: string | null;
  target: Record<string, unknown>;
  impact: ImpactQuantity[];
  previewId: string | null;
  approvalId: string | null;
  bindingDigest: string | null;
  dependsOn: Array<{ effectId: string; outcome: string }>;
  compensates: string | null;
  rejectionReason: string | null;
  unresolvedExposure: boolean;
  reconciliation: { attempts: number; nextAt: Date | null; exhausted: boolean };
  endUserId: string | null;
  createdAt: Date;
  firstDispatchedAt: Date | null;
  outcomeAt: Date | null;
  updatedAt: Date;
}

export interface EffectDetail extends EffectView {
  request: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  attempts: Array<{ number: number; kind: string; status: string; observedOutcome: string | null; error: string | null; startedAt: Date; finishedAt: Date | null }>;
  evidence: Array<{
    id: string; source: string; observedAt: Date; impliedOutcome: string | null; providerIds: Record<string, string>;
    summary: string; details: Record<string, unknown>; actor: { type: string; id: string | null }; recordedAt: Date;
  }>;
  reservations: Awaited<ReturnType<typeof reservationsFor>>;
  preview: PreviewView | null;
}

function verificationOf(row: ActionEffect): Verification {
  if (row.stage === "rejected" || row.outcome === "not_dispatched") return "not_dispatched";
  if (row.outcome === "pending" || row.outcome === "unknown") return "unverified";
  if (row.outcomeSource === "system") return "not_dispatched";
  return row.outcomeSource === "manual" ? "manual" : "provider";
}

export function isUnresolved(row: Pick<ActionEffect, "outcome" | "partialEffect">): boolean {
  return row.outcome === "pending" || row.outcome === "unknown" || row.partialEffect === "possible";
}

function toView(row: ActionEffect, invocationPublicId: string, previewPublicId: string | null): EffectView {
  return {
    id: row.effectId,
    invocationId: invocationPublicId,
    operationKey: row.operationKey,
    environmentId: row.environmentId,
    action: { name: row.actionName, versionId: row.actionVersionId },
    adapter: { type: row.adapterType, version: row.adapterVersion },
    stage: row.stage,
    outcome: row.outcome,
    partialEffect: row.partialEffect,
    grade: row.grade,
    verification: verificationOf(row),
    providerReference: row.providerReference,
    target: row.target,
    impact: row.impact as unknown as ImpactQuantity[],
    previewId: previewPublicId,
    approvalId: row.approvalId,
    bindingDigest: row.bindingDigest,
    dependsOn: row.dependsOn,
    compensates: row.compensatesEffectId,
    rejectionReason: row.rejectionReason,
    unresolvedExposure: isUnresolved(row),
    reconciliation: { attempts: row.reconcileAttempts, nextAt: row.nextReconcileAt, exhausted: row.reconcileExhausted },
    endUserId: row.endUserId ?? null,
    createdAt: row.createdAt,
    firstDispatchedAt: row.firstDispatchedAt,
    outcomeAt: row.outcomeAt,
    updatedAt: row.updatedAt,
  };
}

async function viewsFor(rows: ActionEffect[]): Promise<EffectView[]> {
  if (!rows.length) return [];
  const invocations = await db.select({ id: actionInvocations.id, publicId: actionInvocations.invocationId }).from(actionInvocations)
    .where(inArray(actionInvocations.id, rows.map((r) => r.invocationId)));
  const previewIds = rows.map((r) => r.previewId).filter((id): id is string => !!id);
  const previews = previewIds.length
    ? await db.select({ id: effectPreviews.id, publicId: effectPreviews.previewId }).from(effectPreviews).where(inArray(effectPreviews.id, previewIds))
    : [];
  const inv = new Map(invocations.map((r) => [r.id, r.publicId]));
  const prv = new Map(previews.map((r) => [r.id, r.publicId]));
  return rows.map((row) => toView(row, inv.get(row.invocationId) ?? "", row.previewId ? prv.get(row.previewId) ?? null : null));
}

export interface ListEffectsQuery {
  action?: string;
  outcome?: EffectOutcome;
  stage?: EffectStage;
  grade?: EffectGrade;
  unresolved?: boolean;
  endUserId?: string;
  actingFor?: ActingFor;
  limit?: number;
  offset?: number;
}

export async function listEffects(workspaceId: string, environmentId: string, query: ListEffectsQuery = {}) {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);
  const conditions: SQL[] = [eq(actionEffects.workspaceId, workspaceId), eq(actionEffects.environmentId, environmentId)];
  if (query.action) conditions.push(eq(actionEffects.actionName, query.action));
  if (query.outcome) conditions.push(eq(actionEffects.outcome, query.outcome));
  if (query.stage) conditions.push(eq(actionEffects.stage, query.stage));
  if (query.grade) conditions.push(eq(actionEffects.grade, query.grade));
  if (query.endUserId) conditions.push(eq(actionEffects.endUserId, query.endUserId));
  const side = actingForCondition(actionEffects.endUserId, query.actingFor);
  if (side) conditions.push(side);
  if (query.unresolved === true) {
    conditions.push(or(inArray(actionEffects.outcome, ["pending", "unknown"]), eq(actionEffects.partialEffect, "possible"))!);
  }
  const where = and(...conditions);
  const rows = await db.select().from(actionEffects).where(where)
    .orderBy(desc(actionEffects.createdAt), desc(actionEffects.id)).limit(limit).offset(offset);
  const [{ total }] = await db.select({ total: count() }).from(actionEffects).where(where);
  return { effects: await viewsFor(rows), total: Number(total), limit, offset };
}

export async function getEffect(workspaceId: string, environmentId: string, effectId: string): Promise<EffectDetail> {
  const row = await effectRowByPublicId(workspaceId, environmentId, effectId);
  const [view] = await viewsFor([row]);
  const attempts = await db.select().from(effectAttempts).where(eq(effectAttempts.effectId, row.id)).orderBy(asc(effectAttempts.attemptNo));
  const evidence = await db.select().from(effectEvidence).where(eq(effectEvidence.effectId, row.id))
    .orderBy(asc(effectEvidence.createdAt), asc(effectEvidence.observedAt));
  const [preview] = row.previewId ? await db.select().from(effectPreviews).where(eq(effectPreviews.id, row.previewId)) : [];
  return {
    ...view,
    request: row.request,
    capabilities: row.capabilities,
    attempts: attempts.map((a) => ({
      number: a.attemptNo, kind: a.kind, status: a.status, observedOutcome: a.observedOutcome, error: a.error,
      startedAt: a.startedAt, finishedAt: a.finishedAt,
    })),
    evidence: evidence.map((e) => ({
      id: e.id, source: e.source, observedAt: e.observedAt, impliedOutcome: e.impliedOutcome, providerIds: e.providerIds,
      summary: e.summary, details: e.details, actor: { type: e.actorType, id: e.actorId }, recordedAt: e.createdAt,
    })),
    reservations: await reservationsFor(row.id),
    preview: preview ? await toPreviewView(preview) : null,
  };
}


export async function effectIdForInvocation(invocationRowId: string): Promise<string | null> {
  const [row] = await db.select({ effectId: actionEffects.effectId }).from(actionEffects).where(eq(actionEffects.invocationId, invocationRowId));
  return row?.effectId ?? null;
}

export async function requestReconciliation(workspaceId: string, environmentId: string, effectId: string): Promise<EffectDetail> {
  const row = await effectRowByPublicId(workspaceId, environmentId, effectId);
  if (row.outcome !== "pending" && row.outcome !== "unknown") {
    throw new ConflictError(`${effectId} is ${row.outcome}; only pending or unknown effects are reconciled.`);
  }
  const ran = await reconcileEffectNow(row.id);
  if (!ran) throw new ConflictError(`${effectId} is being reconciled or written right now. Try again shortly.`);
  return getEffect(workspaceId, environmentId, effectId);
}

export async function addEffectNote(workspaceId: string, environmentId: string, effectId: string, note: string, actor: Actor | undefined) {
  if (!actor) throw new AuthorizationError("Adding a note needs an identified operator.");
  const row = await effectRowByPublicId(workspaceId, environmentId, effectId);
  await db.transaction(async (tx) => {
    const now = await readDbNow(tx);
    await insertEvidenceIn(tx, row, [{
      source: "operator_note", observedAt: now, impliedOutcome: null, providerIds: {}, summary: note, details: {},
    }], { actor });
  });
  return getEffect(workspaceId, environmentId, effectId);
}

export async function replayEffectOperation(workspaceId: string, environmentId: string, effectId: string, actor: Actor | undefined) {
  if (!actor) throw new AuthorizationError("A replay needs an identified operator.");
  const row = await effectRowByPublicId(workspaceId, environmentId, effectId);
  if (actor.type === "api_key" && row.requestedByKeyId === actor.id) {
    throw new AuthorizationError("The key that requested this effect cannot replay it. Use an operator credential.");
  }
  await replayEffect(row, actor);
  return getEffect(workspaceId, environmentId, effectId);
}

export interface ManualResolution {
  outcome: "succeeded" | "failed";
  partialEffect?: PartialEffect;
  actualImpact?: ImpactQuantity[];
  reason: string;
  externalReference?: string | null;
}

export async function resolveEffectManually(
  workspaceId: string, environmentId: string, effectId: string, input: ManualResolution, actor: Actor | undefined,
): Promise<EffectDetail> {
  if (!actor) throw new AuthorizationError("Resolving an effect needs an identified operator.");
  const partial = input.partialEffect ?? "none";
  if (input.outcome === "succeeded" && partial !== "none") throw new ValidationError("A succeeded effect has no partial impact.");
  if (partial === "confirmed" && !input.actualImpact?.length) {
    throw new ValidationError("A confirmed partial effect needs actualImpact: the quantities that did happen.");
  }
  const row = await effectRowByPublicId(workspaceId, environmentId, effectId);
  if (actor.type === "api_key" && row.requestedByKeyId === actor.id) {
    throw new AuthorizationError("The key that requested this effect cannot resolve it. Use an operator credential.");
  }
  if (input.actualImpact) assertActualImpactMatches(row.impact as unknown as ImpactQuantity[], input.actualImpact);
  await db.transaction(async (tx) => {
    const { effect, invocation } = await lockEffectChain(tx, row);
    const [inFlight] = await tx.select({ id: effectAttempts.id }).from(effectAttempts).where(and(
      eq(effectAttempts.effectId, effect.id), eq(effectAttempts.status, "started"), inArray(effectAttempts.kind, ["dispatch", "replay"]),
    ));
    if (inFlight) throw new ConflictError("A write for this effect is in flight; resolve it after it finishes.");
    const now = await readDbNow(tx);
    const evidence = {
      source: "manual_resolution" as const,
      observedAt: now,
      impliedOutcome: input.outcome,
      providerIds: (input.externalReference ? { externalReference: input.externalReference } : {}) as Record<string, string>,
      summary: input.reason,
      details: { outcome: input.outcome, partialEffect: partial, actualImpact: input.actualImpact ?? null },
    };
    if (effect.outcome === "pending" || effect.outcome === "unknown") {
      await applyInterpretationIn(tx, effect, invocation, {
        outcome: input.outcome, partialEffect: partial, providerReference: null, actualImpact: input.actualImpact, evidence: [],
      }, { source: "manual", actor });
      await insertEvidenceIn(tx, effect, [evidence], { actor });
      return;
    }
    if (effect.outcome === "failed" && effect.partialEffect === "possible" && input.outcome === "failed") {
      await insertEvidenceIn(tx, effect, [evidence], { actor });
      await tx.update(actionEffects).set({
        partialEffect: partial, stage: partial === "possible" ? "reconciling" : "settled", updatedAt: now,
      }).where(eq(actionEffects.id, effect.id));
      await applyOutcomeToImpactIn(tx, effect.id, "failed", partial, input.actualImpact);
      return;
    }
    throw new ConflictError(`${effectId} is ${effect.outcome}${effect.partialEffect === "possible" ? " with possible partial impact" : ""}; a confirmed outcome is not rewritten.`);
  });
  const [settled] = await db.select().from(actionEffects).where(eq(actionEffects.id, row.id));
  const [invocation] = await db.select().from(actionInvocations).where(eq(actionInvocations.id, row.invocationId));
  if (settled && invocation) await traceEffect(settled, invocation);
  return getEffect(workspaceId, environmentId, effectId);
}

export async function createPreviewForAction(
  workspaceId: string, environmentId: string, actionRef: string, input: Record<string, unknown>,
  opts: { requestedByKeyId?: string | null; ttlSeconds?: number; runId?: string; endUserId?: string | null } = {},
): Promise<PreviewView> {
  const action = await resolveActionRow(workspaceId, actionRef, environmentId);
  const agentId = opts.runId ? (await getRunIdentity({ workspaceId, environmentId }, opts.runId)).agentId : null;
  const pinned = await resolvePinnedDefinition(action, agentId);
  const spec = governedSpecOf(pinned.definition);
  if (!spec || !pinned.actionVersionId) {
    throw new ValidationError(`Action "${action.name}" has no adapter and no declaration. Previews are available for governed actions.`);
  }
  const row = await buildPreview(
    { action, actionVersionId: pinned.actionVersionId, spec },
    input,
    { requestedByKeyId: opts.requestedByKeyId, ttlSeconds: opts.ttlSeconds, endUserId: opts.endUserId ?? null },
  );
  return toPreviewView(row);
}

export async function getPreview(workspaceId: string, environmentId: string, previewId: string): Promise<PreviewView> {
  return toPreviewView(await previewRow(workspaceId, environmentId, previewId));
}

export async function refreshPreview(
  workspaceId: string, environmentId: string, previewId: string,
  opts: { requestedByKeyId?: string | null; ttlSeconds?: number } = {},
): Promise<PreviewView> {
  const old = await previewRow(workspaceId, environmentId, previewId);
  const [action] = await db.select().from(actions).where(and(eq(actions.id, old.actionId), sql`${actions.archivedAt} is null`));
  if (!action) throw new ConflictError("The previewed action no longer exists.");
  let version: Awaited<ReturnType<typeof loadVersionAdapter>>;
  try {
    version = await loadVersionAdapter(action.id, old.actionVersionId);
  } catch {
    throw new ConflictError(`The reviewed action version ${old.actionVersionId} no longer exists or is no longer governed.`);
  }
  const row = await buildPreview(
    { action, actionVersionId: old.actionVersionId, spec: version.spec },
    old.input,
    { requestedByKeyId: opts.requestedByKeyId, ttlSeconds: opts.ttlSeconds, supersedes: old.previewId, endUserId: old.endUserId ?? null },
  );
  return toPreviewView(row);
}

export async function listPreviews(workspaceId: string, environmentId: string, limit = 20) {
  const rows = await db.select().from(effectPreviews).where(and(
    eq(effectPreviews.workspaceId, workspaceId), eq(effectPreviews.environmentId, environmentId),
  )).orderBy(desc(effectPreviews.createdAt)).limit(Math.min(Math.max(limit, 1), 100));
  return Promise.all(rows.map((row) => toPreviewView(row)));
}
