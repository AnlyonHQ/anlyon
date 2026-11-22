import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { readDbNow } from "../../db/clock.ts";
import { actions, actionInvocations } from "../../db/schema/actions.ts";
import { actionEffects, effectAttempts, effectPreviews, impactReservations, type ActionEffect, type EffectAttempt } from "../../db/schema/effects.ts";
import { createLogger } from "../../lib/logger.ts";
import { ApiError, NotFoundError } from "../../utils/errors.ts";
import type { Interpretation, NormalizedOperation } from "./adapter.ts";
import { buildAdapterContext, loadVersionAdapter } from "./context.ts";
import { dispatchedByThisCall } from "../actions/execute.ts";
import { EffectRejection } from "./impact.ts";
import {
  applyInterpretationIn,
  assertExecutionControlsIn,
  dispatchEffect,
  dispatchRequestFor,
  evidenceHistory,
  executeEffectInvocation,
  insertEvidenceIn,
  leaseOwner,
  lockEffectChain,
  nextAttemptNo,
  onlyProvenFailure,
  observe,
  successIsVerified,
  RECONCILE_LEASE_MS,
  DISPATCH_LEASE_MS,
  recordInterpretation,
  safeInterpret,
} from "./lifecycle.ts";

const logger = createLogger({ module: "effects-reconcile" });

export const RECONCILE_CONCURRENCY = 4;

async function claimReconciliations(opts: { batchSize: number; effectRowId?: string; force?: boolean }): Promise<Array<{ id: string; owner: string; attemptId: string }>> {
  const owner = leaseOwner();
  const leaseMs = RECONCILE_LEASE_MS();
  const due = opts.force
    ? sql`true`
    : sql`(e.next_reconcile_at <= clock_timestamp()
           OR (e.next_reconcile_at IS NULL AND e.reconcile_lease_until IS NOT NULL AND e.reconcile_lease_until < clock_timestamp()))`;
  const only = opts.effectRowId ? sql`AND e.id = ${opts.effectRowId}` : sql``;
  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      UPDATE action_effects AS target
      SET reconcile_lease_owner = ${owner},
          reconcile_lease_until = clock_timestamp() + (${leaseMs}::int * interval '1 millisecond'),
          reconcile_attempts = target.reconcile_attempts + 1,
          reconcile_exhausted = CASE WHEN ${opts.force ?? false} THEN false ELSE target.reconcile_exhausted END,
          next_reconcile_at = clock_timestamp() + (${leaseMs}::int * interval '1 millisecond'),
          updated_at = clock_timestamp()
      WHERE target.id IN (
        SELECT e.id FROM action_effects e
        WHERE e.outcome IN ('pending', 'unknown')
          AND ${due}
          AND (${opts.force ?? false} OR NOT e.reconcile_exhausted)
          AND (e.reconcile_lease_until IS NULL OR e.reconcile_lease_until < clock_timestamp())
          AND NOT EXISTS (
            SELECT 1 FROM effect_attempts a
            WHERE a.effect_id = e.id AND a.status = 'started' AND a.kind IN ('dispatch', 'replay')
          )
          ${only}
        ORDER BY e.next_reconcile_at NULLS FIRST
        LIMIT ${opts.batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING target.id, target.workspace_id, target.environment_id, target.reconcile_lease_until
    `) as unknown as { rows: Array<{ id: string; workspace_id: string; environment_id: string; reconcile_lease_until: Date | string }> };
    const claimed: Array<{ id: string; owner: string; attemptId: string }> = [];
    for (const row of result.rows) {
      const [attempt] = await tx.insert(effectAttempts).values({
        workspaceId: row.workspace_id,
        environmentId: row.environment_id,
        effectId: row.id,
        attemptNo: await nextAttemptNo(tx, row.id),
        kind: "reconcile",
        leaseOwner: owner,
        leaseUntil: new Date(row.reconcile_lease_until),
      }).returning({ id: effectAttempts.id });
      claimed.push({ id: row.id, owner, attemptId: attempt.id });
    }
    return claimed;
  });
}

async function runReconciliation(effectRowId: string, owner: string, attemptId: string): Promise<void> {
  const [effect] = await db.select().from(actionEffects).where(eq(actionEffects.id, effectRowId));
  if (!effect) return;
  const [action] = await db.select().from(actions).where(eq(actions.id, effect.actionId));

  let interpretation: Interpretation;
  let verified = false;
  try {
    const version = await loadVersionAdapter(action.id, effect.actionVersionId);
    const ctx = await buildAdapterContext(effect, version.adapter, version.config, version.spec, "preview");
    const [preview] = await db.select().from(effectPreviews).where(eq(effectPreviews.id, effect.previewId!));
    interpretation = await version.adapter.reconcile(ctx, {
      effectId: effect.effectId,
      operation: { target: effect.target as unknown as NormalizedOperation["target"], request: effect.request },
      preconditions: preview?.preconditions ?? {},
      idempotencyKey: effect.providerIdempotencyKey!,
      providerReference: effect.providerReference,
      firstDispatchedAt: effect.firstDispatchedAt,
      history: await evidenceHistory(effect.id),
      now: new Date(),
    });
    verified = successIsVerified(version.adapter, interpretation);
  } catch (error) {
    interpretation = {
      outcome: effect.outcome === "pending" ? "pending" : "unknown",
      partialEffect: effect.partialEffect,
      providerReference: null,
      evidence: [{
        source: "system", observedAt: new Date(), impliedOutcome: null, providerIds: {},
        summary: "Reconciliation could not reach the provider; the outcome is unchanged.",
        details: { error: error instanceof Error ? error.message.slice(0, 300) : "error" },
      }],
    };
  }
  if (effect.outcome === "pending" && interpretation.outcome === "unknown") interpretation = { ...interpretation, outcome: "pending" };
  interpretation = onlyProvenFailure(interpretation, "lookup", effect.outcome);
  await recordInterpretation(effect, interpretation, { attemptId, source: "provider", reconcileOwner: owner, usageOnFailure: "released", verified });
}

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(async (item) => {
      try { await fn(item); } catch (error) { logger.error({ error }, "Effect reconciliation step failed"); }
    }));
  }
}

export async function reconcileDueEffects(opts: { batchSize?: number } = {}): Promise<{ reconciled: number; abandoned: number; resumed: number }> {
  const abandoned = await sweepStaleAttempts();
  const resumed = await resumeReadyEffects();
  const claimed = await claimReconciliations({ batchSize: opts.batchSize ?? 25 });
  await inBatches(claimed, RECONCILE_CONCURRENCY, (item) => runReconciliation(item.id, item.owner, item.attemptId));
  if (claimed.length || abandoned || resumed) logger.info({ reconciled: claimed.length, abandoned, resumed }, "Effect reconciliation sweep");
  return { reconciled: claimed.length, abandoned, resumed };
}

export async function reconcileEffectNow(effectRowId: string): Promise<boolean> {
  const claimed = await claimReconciliations({ batchSize: 1, effectRowId, force: true });
  if (!claimed.length) return false;
  await runReconciliation(claimed[0].id, claimed[0].owner, claimed[0].attemptId);
  return true;
}

export async function sweepStaleAttempts(limit = 50): Promise<number> {
  const stale = await db.select({ attempt: effectAttempts, effect: actionEffects })
    .from(effectAttempts)
    .innerJoin(actionEffects, eq(actionEffects.id, effectAttempts.effectId))
    .where(and(eq(effectAttempts.status, "started"), lt(effectAttempts.leaseUntil, sql`clock_timestamp()`)))
    .limit(limit);
  let count = 0;
  for (const { attempt, effect } of stale) {
    const done = await db.transaction(async (tx) => {
      const locked = await lockEffectChain(tx, effect);
      const [current] = await tx.select().from(effectAttempts).where(eq(effectAttempts.id, attempt.id)).for("update");
      if (!current || current.status !== "started") return false;
      const now = await readDbNow(tx);
      await tx.update(effectAttempts).set({ status: "abandoned", finishedAt: now, error: "Lease expired before an outcome was recorded" })
        .where(eq(effectAttempts.id, attempt.id));
      if (attempt.kind === "reconcile") {
        if (locked.effect.reconcileLeaseOwner === attempt.leaseOwner) {
          await tx.update(actionEffects).set({ reconcileLeaseOwner: null, reconcileLeaseUntil: null, nextReconcileAt: now, updatedAt: now })
            .where(eq(actionEffects.id, effect.id));
        }
        return true;
      }
      await applyInterpretationIn(tx, locked.effect, locked.invocation, {
        outcome: "unknown",
        partialEffect: locked.effect.partialEffect,
        providerReference: null,
        evidence: [{
          source: "system", observedAt: now, impliedOutcome: "unknown", providerIds: {},
          summary: `The worker handling this ${attempt.kind} stopped before recording an outcome. The write may have reached the provider; it will be reconciled, not repeated.`,
          details: { attemptNo: attempt.attemptNo },
        }],
      }, { attemptId: null, source: "provider" });
      return true;
    });
    if (done) count++;
  }
  return count;
}

export async function resumeReadyEffects(graceMs = 60_000, limit = 25): Promise<number> {
  const cutoff = new Date(Date.now() - graceMs);
  const rows = await db.select({ effect: actionEffects, action: actions, invocation: actionInvocations })
    .from(actionEffects)
    .innerJoin(actionInvocations, eq(actionInvocations.id, actionEffects.invocationId))
    .innerJoin(actions, eq(actions.id, actionEffects.actionId))
    .where(and(
      eq(actionInvocations.status, "running"),
      or(
        and(inArray(actionEffects.stage, ["ready", "awaiting_approval"]), lt(actionInvocations.dispatchClaimedAt, cutoff)),
        and(eq(actionEffects.stage, "ready"), isNull(actionInvocations.dispatchClaimedAt), lt(actionEffects.createdAt, cutoff)),
      ),
    ))
    .limit(limit);
  let resumed = 0;
  for (const { effect, action, invocation } of rows) {
    try {
      const result = invocation.dispatchClaimedAt
        ? await dispatchEffect(effect, action)
        : await executeEffectInvocation(action, invocation);
      if (dispatchedByThisCall(result)) resumed++;
    } catch (error) {
      logger.error({ effectId: effect.effectId, error }, "Resuming an admitted effect failed");
    }
  }
  return resumed;
}

export async function replayEffect(effect: ActionEffect, actor: { type: "api_key" | "user"; id: string }): Promise<ActionEffect> {
  const [action] = await db.select().from(actions).where(eq(actions.id, effect.actionId));
  const version = await loadVersionAdapter(action.id, effect.actionVersionId);
  const caps = version.adapter.capabilities;

  let attempt: EffectAttempt;
  let ctx: Awaited<ReturnType<typeof buildAdapterContext>>;
  try {
    if (!caps.sameKeyReplay.supported) {
      throw new EffectRejection("replay_unsupported", `${effect.adapterType} does not support replay: ${caps.sameKeyReplay.description}`);
    }
    if (effect.outcome !== "unknown") {
      throw new EffectRejection("not_unknown", `Only an effect whose outcome is unknown can be replayed; ${effect.effectId} is ${effect.outcome}.`);
    }
    if (caps.sameKeyReplay.windowSeconds !== null && effect.firstDispatchedAt &&
        Date.now() > effect.firstDispatchedAt.getTime() + caps.sameKeyReplay.windowSeconds * 1000) {
      throw new EffectRejection("replay_window_passed", "The provider's idempotency window has passed; a replay could create a second effect. Reconcile or resolve instead.");
    }
    try {
      ctx = await buildAdapterContext(effect, version.adapter, version.config, version.spec);
    } catch (error) {
      throw new EffectRejection("credential_unavailable", error instanceof Error ? error.message : "The credential could not be resolved.");
    }
    attempt = await db.transaction(async (tx) => {
      const locked = await lockEffectChain(tx, effect);
      if (locked.effect.outcome !== "unknown") {
        throw new EffectRejection("not_unknown", `Only an effect whose outcome is unknown can be replayed; ${effect.effectId} is now ${locked.effect.outcome}.`);
      }
      const now = await readDbNow(tx);
      const [preview] = locked.effect.previewId
        ? await tx.select().from(effectPreviews).where(eq(effectPreviews.id, locked.effect.previewId))
        : [];
      await assertExecutionControlsIn(tx, { effect: locked.effect, invocation: locked.invocation, action, preview, now, version });
      const open = await tx.select({ state: impactReservations.state }).from(impactReservations)
        .where(eq(impactReservations.effectId, effect.id));
      if (open.some((r) => r.state !== "reserved")) {
        throw new EffectRejection("allowance_released", "This effect's allowance is no longer held; a replay cannot be admitted.");
      }
      const [inFlight] = await tx.select({ id: effectAttempts.id }).from(effectAttempts).where(and(
        eq(effectAttempts.effectId, effect.id), eq(effectAttempts.status, "started"), inArray(effectAttempts.kind, ["dispatch", "replay"]),
      ));
      if (inFlight) throw new EffectRejection("write_in_flight", "Another write for this effect is in flight.");
      try {
        const [row] = await tx.insert(effectAttempts).values({
          workspaceId: effect.workspaceId,
          environmentId: effect.environmentId,
          effectId: effect.id,
          attemptNo: await nextAttemptNo(tx, effect.id),
          kind: "replay",
          leaseOwner: leaseOwner(),
          leaseUntil: new Date(now.getTime() + DISPATCH_LEASE_MS()),
        }).returning();
        await insertEvidenceIn(tx, locked.effect, [{
          source: "system", observedAt: now, impliedOutcome: null, providerIds: {},
          summary: `Replay authorized under the same provider identity by ${actor.type} ${actor.id}: binding, expiry, approval, action version, halt state, authority, policy and dependencies re-verified.`,
          details: {},
        }], { attemptId: row.id, actor });
        return row;
      } catch (error) {
        const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
        if (code === "23505") throw new EffectRejection("write_in_flight", "Another write for this effect is in flight.");
        throw error;
      }
    });
  } catch (error) {
    if (!(error instanceof EffectRejection)) throw error;
    const outcome = await db.transaction(async (tx) => {
      const locked = await lockEffectChain(tx, effect);
      await insertEvidenceIn(tx, locked.effect, [{
        source: "system", observedAt: await readDbNow(tx), impliedOutcome: null, providerIds: {},
        summary: `Replay refused (${error.reason}): ${error.message} Nothing was sent; the outcome stays ${locked.effect.outcome}.`,
        details: { reason: error.reason, ...error.details },
      }], { actor });
      return locked.effect.outcome;
    });
    throw new ApiError(409, "REPLAY_REFUSED", `Replay refused (${error.reason}): ${error.message}`, { reason: error.reason, outcome });
  }

  const [preview] = await db.select().from(effectPreviews).where(eq(effectPreviews.id, effect.previewId!));
  const request = dispatchRequestFor(effect, preview, "replay");
  const observation = await observe(() => version.adapter.dispatch(ctx, request));
  const interpretation = onlyProvenFailure(safeInterpret(version.adapter, request, observation), "replay", "unknown");
  const { effect: after } = await recordInterpretation(effect, interpretation, {
    attemptId: attempt.id, source: "provider", observation, usageOnFailure: observation.kind === "response" ? "billed" : "released",
    verified: successIsVerified(version.adapter, interpretation),
  });
  return after;
}

export async function effectRowByPublicId(workspaceId: string, environmentId: string, effectId: string): Promise<ActionEffect> {
  const [row] = await db.select().from(actionEffects).where(and(
    eq(actionEffects.workspaceId, workspaceId), eq(actionEffects.environmentId, environmentId), eq(actionEffects.effectId, effectId),
  ));
  if (!row) throw new NotFoundError("Effect");
  return row;
}
