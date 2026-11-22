import { createHash } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { functionRunCalls, functionRuns, functionVersions, type FunctionCallKind } from "../../db/schema/functions.ts";
import { createLogger } from "../../lib/logger.ts";
import { ApiError } from "../../utils/errors.ts";
import type { PlanApprovalCover } from "../actions/gating.ts";
import { invokeAction, resolveActionRow } from "../actions/service.ts";
import { approvals } from "../../db/schema/approvals.ts";
import { apiKeys } from "../../db/schema/workspaces.ts";
import { DEFAULT_API_KEY_SCOPES } from "../auth/api-key-scopes.ts";
import { hasPermission, permissionScope } from "../workspace/permissions.ts";
import { resolveMemberRole } from "../workspace/roles.ts";
import { releaseUndispatchedActionBudget } from "../billing/action-accounting.ts";
import { reserveBudget } from "../billing/budgets.ts";
import { expensiveWorkPaused } from "../billing/work-admission.ts";
import { canonicalJson } from "../effects/canonical.ts";
import { isEnvironmentHalted } from "../environments/halt.ts";
import { endApplyOnStoppedWrite, endRunOnBudget, endRunOnDivergence } from "./runs.ts";
import { verifyRunToken, type RunTokenClaims } from "./run-token.ts";
import { verifyRunnerRequestWithAny } from "./runner-signing.ts";
import { env } from "../../config/env.ts";

const logger = createLogger({ module: "function-calls" });

export const MAX_CALL_BODY_BYTES = 300 * 1024;
const ACTION_NAME = /^[a-zA-Z0-9_-]{1,100}$/;
const EXECUTION_ID = /^[A-Za-z0-9-]{8,64}$/;

export type CallAnswer =
  | { status: 200; body: { ok: true; result: unknown } }
  | { status: number; body: { ok: false; error: { code: string; message: string } & Record<string, unknown> } };

const RUN_SCOPES = ["functions:run", "actions:invoke"] as const;

async function starterNoLongerAllowed(run: { workspaceId: string; environmentId: string; requestedByKeyId: string | null; requestedByUserId: string | null }): Promise<string | null> {
  if (run.requestedByKeyId) {
    const [key] = await db
      .select({ isActive: apiKeys.isActive, expiresAt: apiKeys.expiresAt, scopes: apiKeys.scopes })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, run.requestedByKeyId), eq(apiKeys.workspaceId, run.workspaceId)));
    if (!key || key.isActive !== "true" || (key.expiresAt && key.expiresAt.getTime() <= Date.now())) {
      return "The API key that started this run was revoked or has expired. Nothing was sent.";
    }
    const scopes: readonly string[] = key.scopes ?? DEFAULT_API_KEY_SCOPES;
    const missing = RUN_SCOPES.find((scope) => !scopes.includes(scope));
    if (missing) return `The API key that started this run no longer has the ${missing} scope. Nothing was sent.`;
  }
  if (run.requestedByUserId) {
    const environmentScoped = permissionScope("actions.invoke") === "environment";
    const member = await resolveMemberRole(run.workspaceId, run.requestedByUserId, environmentScoped ? run.environmentId : null);
    const role = member ? (environmentScoped ? member.role : member.workspaceRole) : null;
    if (!role || !hasPermission(role, "actions.invoke")) {
      return "The person who started this run can no longer run actions here. Nothing was sent.";
    }
  }
  return null;
}

function refuse(status: number, code: string, message: string, extra: Record<string, unknown> = {}): CallAnswer {
  return { status, body: { ok: false, error: { code, message, ...extra } } };
}

function refusalFromError(error: unknown): CallAnswer {
  if (error instanceof ApiError) {
    const { code, message, ...rest } = (error.toJSON() as { error: { code: string; message: string } & Record<string, unknown> }).error;
    const extra = Object.fromEntries(Object.entries(rest).filter(([key, value]) => key !== "details" && value !== undefined));
    return refuse(error.statusCode, code, message, extra);
  }
  logger.error({ error: error instanceof Error ? error.message : String(error) }, "Function call failed");
  return refuse(500, "INTERNAL_ERROR", "The call failed inside Anlyon. Check the run's receipt before retrying.");
}

interface CallBody {
  kind: "invoke" | "read";
  action: string;
  input: Record<string, unknown>;
  execution: string;
}

function parseBody(text: string): CallBody | null {
  let body: Partial<CallBody>;
  try {
    body = JSON.parse(text) as Partial<CallBody>;
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  if (body.kind !== "invoke" && body.kind !== "read") return null;
  if (typeof body.action !== "string" || body.action.length === 0 || body.action.length > 128) return null;
  if (!body.input || typeof body.input !== "object" || Array.isArray(body.input)) return null;
  if (typeof body.execution !== "string" || !EXECUTION_ID.test(body.execution)) return null;
  return body as CallBody;
}

export interface IncomingCall {
  runId: string;
  token: string | null;
  signature: string | null;
  path: string;
  body: string;
}

async function recordCall(
  run: { id: string; workspaceId: string; environmentId: string },
  sequence: number,
  call: {
    action: string;
    canonicalInput: string;
    kind: FunctionCallKind;
    state: "intent" | "dispatched" | "refused" | "failed";
    refusal: string | null;
    plannedSequence?: number | null;
  },
): Promise<string> {
  const [row] = await db
    .insert(functionRunCalls)
    .values({
      workspaceId: run.workspaceId,
      environmentId: run.environmentId,
      runRowId: run.id,
      sequence,
      actionName: call.action,
      canonicalInput: call.canonicalInput,
      kind: call.kind,
      state: call.state,
      refusalCode: call.refusal,
      plannedSequence: call.plannedSequence ?? null,
    })
    .returning({ id: functionRunCalls.id });
  return row!.id;
}

type RunRow = typeof functionRuns.$inferSelect;
type VersionRow = typeof functionVersions.$inferSelect;

async function writeGate(
  run: RunRow,
  version: VersionRow,
  sequence: number,
  action: string,
  canonicalInput: string,
  actionVersionId: string | null,
): Promise<{ answer: CallAnswer; intent: boolean } | { plannedSequence: number | null; actionVersionId?: string | null }> {
  if (run.mode === "plan") {
    const [admitted] = await db
      .update(functionRuns)
      .set({ actionCallCount: sql`${functionRuns.actionCallCount} + 1`, writeCount: sql`${functionRuns.writeCount} + 1` })
      .where(and(eq(functionRuns.id, run.id), eq(functionRuns.status, "running"), lt(functionRuns.actionCallCount, version.maxActionCalls)))
      .returning({ id: functionRuns.id });
    if (!admitted) {
      await endRunOnBudget(run.id, "maxActionCalls");
      return {
        answer: refuse(429, "BUDGET_EXCEEDED", `The run used up its maxActionCalls budget (${version.maxActionCalls}).`, { budget: "maxActionCalls" }),
        intent: false,
      };
    }
    await recordCall(run, sequence, { action, canonicalInput, kind: "write", state: "intent", refusal: null });
    return { answer: { status: 200, body: { ok: true, result: { planned: true } } }, intent: true };
  }

  if (run.mode === "apply") {
    const [counted] = await db
      .update(functionRuns)
      .set({ writeCount: sql`${functionRuns.writeCount} + 1` })
      .where(and(eq(functionRuns.id, run.id), eq(functionRuns.status, "running")))
      .returning({ writeCount: functionRuns.writeCount });
    if (!counted) return { answer: refuse(409, "RUN_NOT_RUNNING", "This run has ended. Nothing was sent."), intent: false };
    const [planRun] = run.planRunRowId
      ? await db.select({ plan: functionRuns.plan }).from(functionRuns).where(eq(functionRuns.id, run.planRunRowId))
      : [];
    const expected = planRun?.plan?.writes[counted.writeCount - 1];
    const actionChanged = !!expected && (expected.actionVersionId === undefined || expected.actionVersionId !== actionVersionId);
    if (!expected || expected.action !== action || expected.canonicalInput !== canonicalInput || actionChanged) {
      const reason = !expected
        ? `Write ${counted.writeCount} is one more than the approved plan has.`
        : expected.action !== action
          ? `Write ${counted.writeCount} calls "${action}", and the approved plan's calls "${expected.action}".`
          : expected.canonicalInput !== canonicalInput
            ? `Write ${counted.writeCount} to "${action}" has a different input from the approved plan's.`
            : `The action "${action}" has changed since the plan was approved.`;
      await endRunOnDivergence(run.id, reason);
      return {
        answer: refuse(409, "RUN_DIVERGED", `${reason} The run stopped and nothing further was sent. Plan again for a new approval.`),
        intent: false,
      };
    }
    return { plannedSequence: expected.sequence, actionVersionId: expected.actionVersionId ?? null };
  }

  const policy = version.straightThrough;
  if (!policy || !policy.actions.includes(action)) {
    return {
      answer: refuse(403, "PLAN_REQUIRED", `This function may not write to "${action}" without a plan. Run it with mode "plan" and have the plan approved. Nothing was sent.`),
      intent: false,
    };
  }
  const [counted] = await db
    .update(functionRuns)
    .set({ writeCount: sql`${functionRuns.writeCount} + 1` })
    .where(and(eq(functionRuns.id, run.id), eq(functionRuns.status, "running"), lt(functionRuns.writeCount, policy.maxWrites)))
    .returning({ id: functionRuns.id });
  if (!counted) {
    return {
      answer: refuse(403, "PLAN_REQUIRED", `A straight-through run of this function may make at most ${policy.maxWrites} writes. Run it with mode "plan" for more. Nothing was sent.`),
      intent: false,
    };
  }
  return { plannedSequence: null };
}

async function planApprovalOf(run: RunRow, actionVersionId: string | null): Promise<PlanApprovalCover | undefined> {
  if (!run.approvalId) return undefined;
  const [row] = await db
    .select({ status: approvals.status, kind: approvals.kind, decidedBy: approvals.decidedBy, requiredApprovals: approvals.requiredApprovals, decidedAt: approvals.decidedAt, bindingDigest: approvals.bindingDigest })
    .from(approvals)
    .where(and(eq(approvals.workspaceId, run.workspaceId), eq(approvals.environmentId, run.environmentId), eq(approvals.approvalId, run.approvalId)));
  if (!row || row.kind !== "function_plan" || row.status !== "approved" || row.bindingDigest !== run.planDigest || !row.decidedAt) return undefined;
  return { approvalId: run.approvalId, decidedBy: row.decidedBy === "end_user" ? "end_user" : "team", requiredApprovals: row.requiredApprovals, decidedAt: row.decidedAt, actionVersionId };
}

export async function handleFunctionCall(incoming: IncomingCall): Promise<CallAnswer> {
  const secret = env.RUNNER_SHARED_SECRET;
  if (!secret) return refuse(503, "FUNCTION_RUNNER_UNAVAILABLE", "Hosted functions are not configured on this deployment.");
  if (!verifyRunnerRequestWithAny([secret, env.RUNNER_SHARED_SECRET_ROTATING], incoming.signature, "POST", incoming.path, incoming.body)) {
    return refuse(401, "INVALID_RUNNER_SIGNATURE", "The call is not signed by the runner, or the signature is stale.");
  }

  const checked = verifyRunToken(incoming.token);
  if (!checked.ok) {
    return refuse(401, checked.reason === "expired" ? "RUN_TOKEN_EXPIRED" : "RUN_TOKEN_INVALID", "The run token is not valid for this call.");
  }
  const claims: RunTokenClaims = checked.claims;
  if (claims.run !== incoming.runId) {
    return refuse(403, "RUN_TOKEN_MISMATCH", "The run token is for another run.");
  }

  const body = parseBody(incoming.body);
  if (!body) return refuse(400, "INVALID_CALL", "The call must be { kind, action, input, execution }.");

  const [found] = await db
    .select({ run: functionRuns, version: functionVersions })
    .from(functionRuns)
    .innerJoin(functionVersions, eq(functionVersions.id, functionRuns.functionVersionRowId))
    .where(and(
      eq(functionRuns.runId, claims.run),
      eq(functionRuns.workspaceId, claims.workspace),
      eq(functionRuns.environmentId, claims.environment),
      eq(functionVersions.versionId, claims.version),
    ))
    .limit(1);
  if (!found) return refuse(403, "RUN_TOKEN_MISMATCH", "The run token is for another run.");
  const { run, version } = found;
  if (
    run.mode !== claims.mode ||
    (run.endUserId ?? null) !== (claims.endUser ?? null) ||
    (run.mode === "apply" ? !run.planDigest || claims.planDigest !== run.planDigest : claims.planDigest !== null)
  ) {
    return refuse(403, "RUN_TOKEN_MISMATCH", "The run token is for another run.");
  }

  const bound = await db
    .update(functionRuns)
    .set({ runnerExecutionId: body.execution })
    .where(and(
      eq(functionRuns.id, run.id),
      eq(functionRuns.status, "running"),
      or(isNull(functionRuns.runnerExecutionId), eq(functionRuns.runnerExecutionId, body.execution)),
    ))
    .returning({ id: functionRuns.id });
  if (bound.length === 0) {
    const [now] = await db.select({ status: functionRuns.status }).from(functionRuns).where(eq(functionRuns.id, run.id));
    if (now?.status !== "running") return refuse(409, "RUN_NOT_RUNNING", `This run has ended (${now?.status}). Nothing was sent.`);
    return refuse(409, "RUN_EXECUTION_MISMATCH", "This run is bound to another runner request. Nothing was sent.");
  }

  const [counted] = await db
    .update(functionRuns)
    .set({ callCount: sql`${functionRuns.callCount} + 1` })
    .where(and(eq(functionRuns.id, run.id), eq(functionRuns.status, "running")))
    .returning({ callCount: functionRuns.callCount });
  if (!counted) return refuse(409, "RUN_NOT_RUNNING", "This run has ended. Nothing was sent.");
  const sequence = counted.callCount;

  let canonicalInput: string;
  try {
    canonicalInput = canonicalJson(body.input);
  } catch (error) {
    return refuse(400, "INVALID_INPUT", (error as Error).message);
  }
  const stored = { action: body.action, canonicalInput };
  const refused = async (kind: FunctionCallKind, answer: CallAnswer & { status: number }) => {
    const code = answer.body.ok ? null : answer.body.error.code;
    await recordCall(run, sequence, { ...stored, kind, state: "refused", refusal: code });
    return answer;
  };
  const unresolvedKind: FunctionCallKind = body.kind === "read" ? "read" : "write";

  if (sequence > version.maxSubrequests) {
    await endRunOnBudget(run.id, "maxSubrequests");
    return refused(unresolvedKind, refuse(429, "BUDGET_EXCEEDED", `The run used up its maxSubrequests budget (${version.maxSubrequests}).`, { budget: "maxSubrequests" }));
  }

  if (!ACTION_NAME.test(body.action) || !version.allowedActions.includes(body.action)) {
    return refused(unresolvedKind, refuse(403, "ACTION_NOT_ALLOWED", `This function may not call "${body.action}". It is not in the version's allowed actions.`));
  }

  let kind: FunctionCallKind = unresolvedKind;
  let actionVersionId: string | null = null;
  try {
    const action = await resolveActionRow(run.workspaceId, body.action, run.environmentId);
    if (action.name !== body.action) throw new ApiError(404, "ACTION_NOT_FOUND", `Action not found: ${body.action}`);
    kind = action.method === "GET" ? "read" : "write";
    actionVersionId = action.currentVersionId ?? null;
    if (!action.enabled) {
      return refused(kind, refuse(403, "ACTION_DISABLED", `The action "${body.action}" is disabled.`));
    }
  } catch (error) {
    return refused(kind, refusalFromError(error));
  }
  if (body.kind === "read" && kind !== "read") {
    return refused(kind, refuse(400, "NOT_A_READ", `"${body.action}" changes something. Call it with anlyon.invoke, not anlyon.read.`));
  }

  if (await isEnvironmentHalted(run.environmentId)) {
    return refused(kind, refuse(409, "ENVIRONMENT_HALTED", "This environment is halted. Nothing was sent."));
  }
  if (expensiveWorkPaused()) {
    return refused(kind, refuse(503, "EXPENSIVE_WORK_PAUSED", "New processing is temporarily paused to protect the service. Nothing was sent."));
  }

  let plannedSequence: number | null = null;
  let plannedActionVersionId: string | null = null;
  if (kind === "write") {
    const gate = await writeGate(run, version, sequence, body.action, canonicalInput, actionVersionId);
    if ("answer" in gate) {
      if (gate.intent) return gate.answer;
      return refused(kind, gate.answer);
    }
    plannedSequence = gate.plannedSequence;
    plannedActionVersionId = gate.actionVersionId ?? null;
  }
  const stopApply = async (code: string) => {
    if (run.mode === "apply" && kind === "write") await endApplyOnStoppedWrite(run.id, sequence, code);
  };

  const starterRefusal = await starterNoLongerAllowed(run);
  if (starterRefusal) {
    await stopApply("CREDENTIAL_NO_LONGER_ALLOWED");
    return refused(kind, refuse(403, "CREDENTIAL_NO_LONGER_ALLOWED", starterRefusal));
  }

  const [admitted] = await db
    .update(functionRuns)
    .set({ actionCallCount: sql`${functionRuns.actionCallCount} + 1` })
    .where(and(
      eq(functionRuns.id, run.id),
      eq(functionRuns.status, "running"),
      lt(functionRuns.actionCallCount, version.maxActionCalls),
    ))
    .returning({ actionCallCount: functionRuns.actionCallCount });
  if (!admitted) {
    await endRunOnBudget(run.id, "maxActionCalls");
    return refused(kind, refuse(429, "BUDGET_EXCEEDED", `The run used up its maxActionCalls budget (${version.maxActionCalls}).`, { budget: "maxActionCalls" }));
  }

  let reservationId: string | undefined;
  if (run.requestedByKeyId) {
    try {
      const reservation = await reserveBudget({
        apiKeyId: run.requestedByKeyId,
        workspaceId: run.workspaceId,
        environmentId: run.environmentId,
        dimension: "actionInvokes",
        amount: 1,
        effectId: `${run.runId}:${sequence}`,
        fingerprint: createHash("sha256").update(`${body.action}\n${canonicalInput}`).digest("hex"),
      });
      if (!reservation.allowed) {
        await stopApply("BUDGET_EXCEEDED");
        return refused(kind, refuse(402, "BUDGET_EXCEEDED", "The API key that started this run has used up its action budget. Nothing was sent."));
      }
      reservationId = reservation.reservationId ?? undefined;
    } catch (error) {
      const answer = refusalFromError(error);
      await stopApply(answer.body.ok ? "INTERNAL_ERROR" : answer.body.error.code);
      return refused(kind, answer);
    }
  }

  const callRowId = await recordCall(run, sequence, { ...stored, kind, state: "dispatched", refusal: null, plannedSequence });
  try {
    const planApproval = run.mode === "apply" && kind === "write" ? await planApprovalOf(run, plannedActionVersionId) : undefined;
    const result = await invokeAction(run.workspaceId, body.action, body.input, {
      ...(planApproval ? { planApproval } : {}),
      environmentId: run.environmentId,
      endUser: { endUserId: run.endUserId, required: run.endUserRequired },
      requestedByKeyId: run.requestedByKeyId,
      requestedByUserId: run.requestedByUserId,
      ...(reservationId ? { budgetReservationId: reservationId } : {}),
    });
    const { replayed: _replayed, ...invocation } = result;
    await db
      .update(functionRunCalls)
      .set({ invocationId: invocation.id, state: invocation.status === "failed" ? "failed" : "dispatched" })
      .where(eq(functionRunCalls.id, callRowId));
    if (invocation.status !== "succeeded") await stopApply(invocation.status.toUpperCase());
    return { status: 200, body: { ok: true, result: { ...invocation, json: parsedBody(invocation.body) } } };
  } catch (error) {
    if (reservationId) await releaseUndispatchedActionBudget(run.workspaceId, reservationId).catch(() => undefined);
    const answer = refusalFromError(error);
    await db
      .update(functionRunCalls)
      .set({ state: "refused", refusalCode: answer.body.ok ? null : answer.body.error.code })
      .where(eq(functionRunCalls.id, callRowId));
    await stopApply(answer.body.ok ? "INTERNAL_ERROR" : answer.body.error.code);
    return answer;
  }
}

export function parsedBody(body: string | null): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
