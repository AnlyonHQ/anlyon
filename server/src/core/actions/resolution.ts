import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { dbUtcNow } from "../../db/clock.ts";
import { actions, actionInvocations, invocationResolutions, type InvocationResolution } from "../../db/schema/actions.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { ApiError, AuthorizationError, ConflictError, InvocationNotFoundError } from "../../utils/errors.ts";
import { createLogger } from "../../lib/logger.ts";
import { recordInvocationOutcomeIn } from "../billing/action-accounting.ts";
import { writeAuditEvents } from "../audit/outbox.ts";
import { resolutionRecord } from "../audit/records.ts";
import { toInvocation, type InvocationResolutionView, type InvocationResult } from "./execute.ts";

const logger = createLogger({ module: "invocation-resolution" });

export interface ResolveInvocationInput {
  outcome: "succeeded" | "failed";
  evidence: string;
  externalReference?: string | null;
}

export interface ResolutionActor {
  type: "api_key" | "user";
  id: string;
}

export function toResolutionView(row: InvocationResolution): InvocationResolutionView {
  return {
    outcome: row.outcome,
    evidence: row.evidence,
    externalReference: row.externalReference ?? null,
    resolvedBy: { type: row.actorType, id: row.actorId },
    resolvedAt: row.createdAt,
  };
}

export async function resolveInvocation(
  workspaceId: string,
  environmentId: string,
  invocationPublicId: string,
  input: ResolveInvocationInput,
  actor: ResolutionActor | undefined,
): Promise<InvocationResult> {
  if (!actor) throw new AuthorizationError("Resolving an invocation needs an identified operator.");

  const { invocation, actionName, resolution } = await db.transaction(async (tx) => {
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    const [row] = await tx
      .select({ invocation: actionInvocations, actionName: actions.name })
      .from(actionInvocations)
      .innerJoin(actions, eq(actions.id, actionInvocations.actionId))
      .where(and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.environmentId, environmentId),
        eq(actionInvocations.invocationId, invocationPublicId),
      ))
      .for("update", { of: actionInvocations });
    if (!row) throw new InvocationNotFoundError(invocationPublicId);
    if (row.invocation.effectId) {
      throw new ApiError(409, "EFFECT_RESOLUTION_REQUIRED",
        `${invocationPublicId} is governed by effect ${row.invocation.effectId}. Resolve the effect instead: POST /actions/effects/${row.invocation.effectId}/resolve.`,
        { effectId: row.invocation.effectId });
    }
    if (row.invocation.status !== "unknown") {
      throw new ConflictError(
        `Only an invocation whose outcome is unknown can be resolved. ${invocationPublicId} is ${row.invocation.status}.`,
      );
    }
    if (actor.type === "api_key" && row.invocation.requestedByKeyId === actor.id) {
      throw new AuthorizationError("The key that requested this invocation cannot resolve it. Use an operator credential.");
    }

    const [resolution] = await tx.insert(invocationResolutions).values({
      workspaceId,
      environmentId,
      invocationId: row.invocation.id,
      outcome: input.outcome,
      evidence: input.evidence,
      externalReference: input.externalReference ?? null,
      actorType: actor.type,
      actorId: actor.id,
    }).returning();

    await recordInvocationOutcomeIn(tx, workspaceId, row.invocation.id, {}, input.outcome === "succeeded" ? "billed" : "released");
    const [updated] = await tx.update(actionInvocations)
      .set({ status: input.outcome, completedAt: row.invocation.completedAt ?? dbUtcNow() })
      .where(and(eq(actionInvocations.id, row.invocation.id), eq(actionInvocations.status, "unknown")))
      .returning();
    await writeAuditEvents(tx, [resolutionRecord(resolution, { invocationId: invocationPublicId }, row.actionName)]);
    return { invocation: updated, actionName: row.actionName, resolution };
  });

  logger.info(
    { workspaceId, invocationId: invocationPublicId, outcome: input.outcome, actorType: actor.type },
    "Unknown invocation resolved",
  );

  return { ...toInvocation(invocation, actionName), resolution: toResolutionView(resolution) };
}

export async function invocationLinks(invocationRowId: string, invocationPublicId: string) {
  const [resolution] = await db.select().from(invocationResolutions)
    .where(eq(invocationResolutions.invocationId, invocationRowId)).limit(1);
  const [retry] = await db.select({ id: actionInvocations.invocationId }).from(actionInvocations)
    .where(eq(actionInvocations.retryOfInvocationId, invocationPublicId)).limit(1);
  return { resolution: resolution ? toResolutionView(resolution) : null, retriedBy: retry?.id ?? null };
}
