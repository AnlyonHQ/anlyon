import { createHash } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.ts";
import {
  functionRunCalls,
  functionRuns,
  functions,
  functionVersions,
  type FunctionBudgetName,
  type FunctionPlan,
  type FunctionRunMode,
  type FunctionRunReceipt,
  type FunctionRunStatus,
} from "../../db/schema/functions.ts";
import { approvals } from "../../db/schema/approvals.ts";
import { createLogger } from "../../lib/logger.ts";
import { generateFunctionRunId } from "../../utils/crypto.ts";
import { ApiError, ValidationError } from "../../utils/errors.ts";
import { validateAgainstSchema } from "../../utils/json-schema.ts";
import { resolveActionRow } from "../actions/definitions.ts";
import { createFunctionPlanApproval } from "../approvals/service.ts";
import { recordAuditEvent } from "../audit/recorder.ts";
import type { AuditActor } from "../audit/event-schema.ts";
import { canonicalJson } from "../effects/canonical.ts";
import { EndUserRequiredError } from "../end-users/errors.ts";
import { NO_END_USER, type EndUserContext } from "../end-users/identity.ts";
import { FunctionRunNotFoundError, FunctionRunnerUnavailableError } from "./errors.ts";
import { mintRunToken, runTokenLifetimeSeconds } from "./run-token.ts";
import { RunnerTimeoutError, runnerConfig, sendRun, type RunnerRunResponse } from "./runner-client.ts";
import { decidePlan, planDigestOf, plannedWrites, type PlannedWrite } from "./plans.ts";
import type { FunctionVersionReview } from "./review.ts";
import { budgetsOf, resolveFunction, sourceOf, type Scope } from "./service.ts";
import { admitFunctionRun, releaseFunctionRun } from "./admission.ts";

const logger = createLogger({ module: "function-runs" });

type RunRow = typeof functionRuns.$inferSelect;
type CallRow = typeof functionRunCalls.$inferSelect;

export interface FunctionRunCallView {
  sequence: number;
  action: string;
  kind: CallRow["kind"];
  state: CallRow["state"];
  invocationId: string | null;
  refusal: string | null;
  plannedSequence: number | null;
  createdAt: Date;
}

export interface FunctionRunPlanView {
  digest: string;
  writes: PlannedWrite[];
  approval: { id: string; status: "pending" | "approved" | "denied" | "expired"; decider: "team" | "end_user" } | null;
  appliedByRunId: string | null;
}

export interface FunctionRunView {
  id: string;
  functionId: string;
  functionName: string;
  functionVersionId: string;
  mode: RunRow["mode"];
  status: FunctionRunStatus;
  endUserId: string | null;
  input: unknown;
  inputDigest: string;
  output: unknown;
  error: { code: string; message: string } | null;
  logs: string[];
  budget: FunctionBudgetName | null;
  actionCalls: number;
  calls: FunctionRunCallView[];
  plan: FunctionRunPlanView | null;
  planRunId: string | null;
  planDigest: string | null;
  approvalId: string | null;
  receipt: FunctionRunReceipt | null;
  durationMs: number | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export function isolationKeyOf(workspaceId: string, endUserId: string | null): string {
  if (!endUserId) return "shared";
  return createHash("sha256").update(`${workspaceId}\n${endUserId}`).digest("hex").slice(0, 32);
}

export function inputDigestOf(input: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;
}

function callView(row: CallRow): FunctionRunCallView {
  return {
    sequence: row.sequence,
    action: row.actionName,
    kind: row.kind,
    state: row.state,
    invocationId: row.invocationId,
    refusal: row.refusalCode,
    plannedSequence: row.plannedSequence,
    createdAt: row.createdAt,
  };
}

async function publicRunId(rowId: string | null): Promise<string | null> {
  if (!rowId) return null;
  const [row] = await db.select({ runId: functionRuns.runId }).from(functionRuns).where(eq(functionRuns.id, rowId));
  return row?.runId ?? null;
}

async function planView(run: RunRow): Promise<FunctionRunPlanView | null> {
  if (run.mode !== "plan" || !run.plan || !run.planDigest) return null;
  let approval: FunctionRunPlanView["approval"] = null;
  if (run.approvalId) {
    const [row] = await db
      .select({ status: approvals.status, decidedBy: approvals.decidedBy, expiresAt: approvals.expiresAt })
      .from(approvals)
      .where(and(eq(approvals.workspaceId, run.workspaceId), eq(approvals.approvalId, run.approvalId)));
    if (row) {
      const status = row.status === "pending" && row.expiresAt.getTime() <= Date.now() ? "expired" : row.status;
      approval = { id: run.approvalId, status, decider: row.decidedBy === "end_user" ? "end_user" : "team" };
    }
  }
  return { digest: run.planDigest, writes: plannedWrites(run.plan), approval, appliedByRunId: run.appliedByRunId };
}

async function callsOf(runRowId: string): Promise<CallRow[]> {
  return db.select().from(functionRunCalls).where(eq(functionRunCalls.runRowId, runRowId)).orderBy(asc(functionRunCalls.sequence));
}

async function viewOf(run: RunRow): Promise<FunctionRunView> {
  const [names] = await db
    .select({ functionId: functions.functionId, name: functions.name, versionId: functionVersions.versionId })
    .from(functions)
    .innerJoin(functionVersions, eq(functionVersions.id, run.functionVersionRowId))
    .where(eq(functions.id, run.functionRowId));
  return {
    id: run.runId,
    functionId: names!.functionId,
    functionName: names!.name,
    functionVersionId: names!.versionId,
    mode: run.mode,
    status: run.status,
    endUserId: run.endUserId,
    input: run.input,
    inputDigest: run.inputDigest,
    output: run.output ?? null,
    error: run.error ?? null,
    logs: run.logs ?? [],
    budget: run.budgetExceeded ?? null,
    actionCalls: run.actionCallCount,
    calls: (await callsOf(run.id)).map(callView),
    plan: await planView(run),
    planRunId: await publicRunId(run.planRunRowId),
    planDigest: run.mode === "apply" ? run.planDigest : null,
    approvalId: run.mode === "apply" ? run.approvalId : null,
    receipt: run.receipt ?? null,
    durationMs: run.durationMs,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
  };
}

export async function endRunOnBudget(runRowId: string, budget: FunctionBudgetName): Promise<boolean> {
  const ended = await db
    .update(functionRuns)
    .set({
      status: "budget_exceeded",
      budgetExceeded: budget,
      error: { code: "BUDGET_EXCEEDED", message: `The run used up its ${budget} budget.` },
    })
    .where(and(eq(functionRuns.id, runRowId), eq(functionRuns.status, "running")))
    .returning({ id: functionRuns.id });
  return ended.length > 0;
}

export async function endRunOnDivergence(runRowId: string, reason: string): Promise<boolean> {
  const ended = await db
    .update(functionRuns)
    .set({ status: "diverged", error: { code: "RUN_DIVERGED", message: reason } })
    .where(and(eq(functionRuns.id, runRowId), eq(functionRuns.status, "running")))
    .returning({ id: functionRuns.id });
  return ended.length > 0;
}

function reviewForApproval(review: FunctionVersionReview) {
  return {
    summary: review.ai?.status === "reviewed" ? review.ai.summary : null,
    suggestedRiskTier: review.ai?.status === "reviewed" ? review.ai.suggestedRiskTier : null,
    confidence: review.ai?.status === "reviewed" ? review.ai.confidence : null,
    truncated: review.ai?.status === "reviewed" ? review.ai.truncated : false,
    riskyPatterns: review.ai?.status === "reviewed" ? review.ai.riskyPatterns.map((pattern) => pattern.description) : [],
    computedActionNames: review.ast.computedActionNames.length,
    writesInLoop: review.ast.writesInLoop.length,
    riskyApis: [...new Set(review.ast.risky.map((risk) => risk.api))],
  };
}

async function planOf(run: RunRow): Promise<FunctionPlan> {
  const intents = (await callsOf(run.id)).filter((call) => call.state === "intent");
  const versions = new Map<string, string | null>();
  for (const name of new Set(intents.map((call) => call.actionName))) {
    versions.set(name, (await resolveActionRow(run.workspaceId, name, run.environmentId)).currentVersionId ?? null);
  }
  return {
    writes: intents.map((call) => ({
      sequence: call.sequence,
      action: call.actionName,
      canonicalInput: call.canonicalInput,
      actionVersionId: versions.get(call.actionName) ?? null,
    })),
  };
}

interface FinishContext {
  scope: Scope;
  functionName: string;
  functionVersionId: string;
  review: FunctionVersionReview | null;
  requestedByKeyId: string | null;
  requestedByUserId: string | null;
}

async function settleSucceeded(run: RunRow, ctx: FinishContext): Promise<Partial<RunRow>> {
  if (run.mode === "plan") {
    const plan = await planOf(run);
    const planDigest = planDigestOf({ functionVersionId: ctx.functionVersionId, inputDigest: run.inputDigest, endUserId: run.endUserId, plan });
    if (plan.writes.length === 0) return { status: "planned", plan, planDigest };
    const writes = plannedWrites(plan);
    const decision = await decidePlan({ workspaceId: run.workspaceId, environmentId: run.environmentId }, writes, run.endUserId);
    const approval = await createFunctionPlanApproval(
      ctx.scope,
      {
        title: `Run function "${ctx.functionName}"`,
        description: `${writes.length} ${writes.length === 1 ? "write" : "writes"}: ${[...new Set(writes.map((write) => write.action))].join(", ")}. Approving lets one run of this version, with this input, make exactly these writes in this order.`,
        payload: {
          functionName: ctx.functionName,
          functionVersionId: ctx.functionVersionId,
          planRunId: run.runId,
          planDigest,
          inputDigest: run.inputDigest,
          writes,
          ...(ctx.review ? { review: reviewForApproval(ctx.review) } : {}),
          ...(run.endUserId ? { endUserId: run.endUserId } : {}),
        },
        planDigest,
        endUserId: run.endUserId,
        decision,
      },
      { requestedByKeyId: ctx.requestedByKeyId, requestedByUserId: ctx.requestedByUserId },
    );
    return { status: "awaiting_approval", plan, planDigest, approvalId: approval.id };
  }
  if (run.mode === "apply" && run.planRunRowId) {
    const [planRun] = await db.select({ plan: functionRuns.plan }).from(functionRuns).where(eq(functionRuns.id, run.planRunRowId));
    const planned = planRun?.plan?.writes.length ?? 0;
    if (run.writeCount < planned) {
      return {
        status: "diverged",
        error: { code: "RUN_DIVERGED", message: `The run made ${run.writeCount} of the ${planned} approved writes. The rest were not sent.` },
      };
    }
  }
  return { status: "succeeded" };
}

export async function endApplyOnStoppedWrite(runRowId: string, sequence: number, code: string): Promise<boolean> {
  const ended = await db
    .update(functionRuns)
    .set({
      status: "failed",
      error: { code: "APPLY_STOPPED", message: `Approved write at call ${sequence} did not go through (${code}). Nothing further was sent.` },
    })
    .where(and(eq(functionRuns.id, runRowId), eq(functionRuns.status, "running")))
    .returning({ id: functionRuns.id });
  return ended.length > 0;
}

async function finishRun(run: RunRow, outcome: RunnerRunResponse, startedAt: number, ctx: FinishContext): Promise<RunRow> {
  const durationMs = Date.now() - startedAt;
  const finishedAt = new Date();
  let settled: Partial<RunRow> = { status: outcome.status };
  if (outcome.status === "succeeded") {
    const [current] = await db.select().from(functionRuns).where(eq(functionRuns.id, run.id));
    if (current?.status === "running") {
      try {
        settled = await settleSucceeded(current, ctx);
      } catch (error) {
        const code = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
        settled = { status: "failed", error: { code, message: (error as Error).message } };
      }
    }
  }
  const ended = await db
    .update(functionRuns)
    .set({
      budgetExceeded: outcome.status === "budget_exceeded" ? outcome.budget ?? null : null,
      output: outcome.status === "succeeded" ? (outcome.output ?? null) : null,
      error: outcome.error ?? null,
      ...settled,
      logs: outcome.logs,
      durationMs,
      finishedAt,
    })
    .where(and(eq(functionRuns.id, run.id), eq(functionRuns.status, "running")))
    .returning();
  let row = ended[0];
  if (!row) {
    [row] = await db
      .update(functionRuns)
      .set({ logs: outcome.logs, durationMs, finishedAt })
      .where(eq(functionRuns.id, run.id))
      .returning();
  }

  const version = (await db.select().from(functionVersions).where(eq(functionVersions.id, run.functionVersionRowId)))[0]!;
  const fn = (await db.select({ functionId: functions.functionId }).from(functions).where(eq(functions.id, run.functionRowId)))[0]!;
  const calls = await callsOf(run.id);
  const receipt: FunctionRunReceipt = {
    functionId: fn.functionId,
    functionVersionId: version.versionId,
    digest: version.digest,
    inputDigest: run.inputDigest,
    mode: run.mode,
    planDigest: row!.planDigest,
    approvalId: row!.approvalId,
    planRunId: await publicRunId(row!.planRunRowId),
    calls: calls.map((call) => ({
      sequence: call.sequence,
      action: call.actionName,
      kind: call.kind,
      state: call.state,
      invocationId: call.invocationId,
      refusal: call.refusalCode,
      plannedSequence: call.plannedSequence,
    })),
    outcome: row!.status === "running" ? "failed" : (row!.status as FunctionRunReceipt["outcome"]),
    budget: row!.budgetExceeded ?? null,
    finishedAt: finishedAt.toISOString(),
  };
  const [withReceipt] = await db.update(functionRuns).set({ receipt }).where(eq(functionRuns.id, run.id)).returning();
  return withReceipt!;
}

function auditTypeOf(row: RunRow): string {
  if (row.status === "diverged") return "function.run_diverged";
  if (row.mode === "plan" && (row.status === "planned" || row.status === "awaiting_approval")) return "function.run_planned";
  if (row.mode === "apply" && row.status === "succeeded") return "function.run_applied";
  return "function.run_finished";
}

export interface StartRunOptions {
  endUser?: EndUserContext;
  requestedByKeyId?: string | null;
  requestedByUserId?: string | null;
  actor: AuditActor;
  mode?: FunctionRunMode;
  planRunId?: string;
  send?: typeof sendRun;
}

function planRefusal(code: string, message: string): ApiError {
  return new ApiError(409, code, message);
}

export const PLAN_APPLY_WINDOW_HOURS = 24;

async function approvedPlanFor(scope: Scope, fnRowId: string, planRunId: string, endUserId: string | null) {
  const [planRun] = await db
    .select()
    .from(functionRuns)
    .where(and(
      eq(functionRuns.workspaceId, scope.workspaceId),
      eq(functionRuns.environmentId, scope.environmentId),
      eq(functionRuns.runId, planRunId),
    ))
    .limit(1);
  if (!planRun || planRun.functionRowId !== fnRowId || (planRun.endUserId ?? null) !== endUserId) {
    throw new FunctionRunNotFoundError(planRunId);
  }
  if (planRun.mode !== "plan") throw planRefusal("NOT_A_PLAN", `Run ${planRunId} is not a plan run.`);
  if (planRun.status === "planned") throw planRefusal("PLAN_HAS_NO_WRITES", `Plan ${planRunId} has no writes, so there is nothing to apply.`);
  if (planRun.status !== "awaiting_approval" || !planRun.plan || !planRun.planDigest || !planRun.approvalId) {
    throw planRefusal("PLAN_NOT_APPROVED", `Plan ${planRunId} ended ${planRun.status} and cannot be applied.`);
  }
  const [approval] = await db
    .select({ status: approvals.status, kind: approvals.kind, bindingDigest: approvals.bindingDigest, decidedAt: approvals.decidedAt })
    .from(approvals)
    .where(and(eq(approvals.workspaceId, scope.workspaceId), eq(approvals.environmentId, scope.environmentId), eq(approvals.approvalId, planRun.approvalId)));
  if (!approval || approval.kind !== "function_plan" || approval.bindingDigest !== planRun.planDigest) {
    throw planRefusal("PLAN_NOT_APPROVED", `Plan ${planRunId} has no approval for its writes.`);
  }
  if (approval.status !== "approved") {
    throw planRefusal("PLAN_NOT_APPROVED", `Plan ${planRunId}'s approval ${planRun.approvalId} is ${approval.status}. A plan is applied once it is approved.`);
  }
  if (planRun.appliedByRunId) {
    throw planRefusal("PLAN_ALREADY_APPLIED", `Plan ${planRunId} was already applied by run ${planRun.appliedByRunId}. Plan again for another approval.`);
  }
  if (!approval.decidedAt || Date.now() - approval.decidedAt.getTime() > PLAN_APPLY_WINDOW_HOURS * 3_600_000) {
    throw planRefusal(
      "PLAN_EXPIRED",
      `Plan ${planRunId} was approved more than ${PLAN_APPLY_WINDOW_HOURS} hours ago, so what it read may have changed. Nothing was sent. Plan again for a new approval.`,
    );
  }
  return planRun;
}

export async function startRun(scope: Scope, ref: string, input: Record<string, unknown> | undefined, opts: StartRunOptions): Promise<FunctionRunView> {
  const endUser = opts.endUser ?? NO_END_USER;
  const mode: FunctionRunMode = opts.mode ?? "plan";
  if (endUser.required && !endUser.endUserId) throw new EndUserRequiredError();
  const fn = await resolveFunction(scope, ref);

  const planRun = mode === "apply"
    ? await approvedPlanFor(scope, fn.id, opts.planRunId ?? "", endUser.endUserId)
    : null;
  const versionCondition = planRun
    ? eq(functionVersions.id, planRun.functionVersionRowId)
    : fn.currentVersionId
      ? eq(functionVersions.versionId, fn.currentVersionId)
      : null;
  if (!versionCondition) throw new ApiError(409, "FUNCTION_NOT_PUBLISHED", `Function ${fn.name} has no published version yet.`);
  const [version] = await db
    .select()
    .from(functionVersions)
    .where(and(eq(functionVersions.functionRowId, fn.id), versionCondition));
  if (!version) throw new ApiError(409, "FUNCTION_NOT_PUBLISHED", `Function ${fn.name} has no published version yet.`);

  const runInput = planRun && input === undefined ? (planRun.input as Record<string, unknown>) : (input ?? {});
  if (Object.keys(version.inputSchema ?? {}).length > 0) {
    const checked = validateAgainstSchema(version.inputSchema, runInput);
    if (!checked.valid) throw new ValidationError(`Invalid input: ${checked.errors.join("; ")}`);
  }
  let inputDigest: string;
  try {
    inputDigest = inputDigestOf(runInput);
  } catch (error) {
    throw new ValidationError(`Invalid input: ${(error as Error).message}`);
  }
  if (planRun && inputDigest !== planRun.inputDigest) {
    throw planRefusal("PLAN_INPUT_MISMATCH", `An apply run takes the same input as its plan. Omit input to use the plan's.`);
  }
  const send = opts.send ?? sendRun;
  if (!runnerConfig()) {
    throw new FunctionRunnerUnavailableError("Hosted functions are not configured on this deployment. Nothing ran.");
  }

  const runId = generateFunctionRunId();
  const budgets = budgetsOf(version);
  const { run, usageMonth } = await db.transaction(async (tx) => {
    if (planRun) {
      const claimed = await tx
        .update(functionRuns)
        .set({ appliedByRunId: runId })
        .where(and(eq(functionRuns.id, planRun.id), isNull(functionRuns.appliedByRunId)))
        .returning({ id: functionRuns.id });
      if (claimed.length === 0) {
        throw planRefusal("PLAN_ALREADY_APPLIED", `Plan ${planRun.runId} was already applied. Plan again for another approval.`);
      }
    }
    const month = await admitFunctionRun(tx, scope.workspaceId);
    const [inserted] = await tx
      .insert(functionRuns)
      .values({
        workspaceId: scope.workspaceId,
        environmentId: scope.environmentId,
        functionRowId: fn.id,
        functionVersionRowId: version.id,
        runId,
        mode,
        status: "running",
        endUserId: endUser.endUserId,
        endUserRequired: endUser.required,
        input: runInput,
        inputDigest,
        planRunRowId: planRun?.id ?? null,
        planDigest: planRun?.planDigest ?? null,
        approvalId: planRun?.approvalId ?? null,
        requestedByKeyId: opts.requestedByKeyId ?? null,
        requestedByUserId: opts.requestedByUserId ?? null,
      })
      .returning();
    return { run: inserted!, usageMonth: month };
  });

  const runToken = mintRunToken(
    {
      run: run!.runId,
      version: version.versionId,
      workspace: scope.workspaceId,
      environment: scope.environmentId,
      endUser: endUser.endUserId,
      endUserRequired: endUser.required,
      mode,
      planDigest: planRun?.planDigest ?? null,
    },
    runTokenLifetimeSeconds(budgets.timeoutMs),
  );

  const finish: FinishContext = {
    scope,
    functionName: fn.name,
    functionVersionId: version.versionId,
    review: (version.review as FunctionVersionReview | null) ?? null,
    requestedByKeyId: opts.requestedByKeyId ?? null,
    requestedByUserId: opts.requestedByUserId ?? null,
  };
  const startedAt = Date.now();
  let outcome: RunnerRunResponse;
  try {
    outcome = await send({
      runId: run!.runId,
      functionVersionId: version.versionId,
      digest: version.digest,
      language: version.language,
      source: sourceOf(version),
      input: runInput,
      mode,
      allowedActions: version.allowedActions,
      budgets,
      runToken,
      isolation: isolationKeyOf(scope.workspaceId, endUser.endUserId),
    });
  } catch (error) {
    if (error instanceof RunnerTimeoutError) {
      outcome = {
        status: "budget_exceeded",
        budget: "timeoutMs",
        error: { code: "BUDGET_EXCEEDED", message: `The run took longer than ${budgets.timeoutMs} ms.` },
        logs: [],
        durationMs: Date.now() - startedAt,
      };
    } else {
      const code = error instanceof ApiError ? error.code : "FUNCTION_RUNNER_UNAVAILABLE";
      const failed = await finishRun(run!, { status: "failed", error: { code, message: (error as Error).message }, logs: [], durationMs: 0 }, startedAt, finish);
      if (failed.callCount === 0) {
        await releaseFunctionRun(scope.workspaceId, usageMonth);
        if (planRun) {
          await db
            .update(functionRuns)
            .set({ appliedByRunId: null })
            .where(and(eq(functionRuns.id, planRun.id), eq(functionRuns.appliedByRunId, runId)));
        }
      }
      throw error instanceof ApiError ? error : new FunctionRunnerUnavailableError();
    }
  }

  const finished = await finishRun(run!, outcome, startedAt, finish);
  logger.info(
    { workspaceId: scope.workspaceId, runId: finished.runId, mode, status: finished.status, budget: finished.budgetExceeded, calls: finished.callCount },
    "Function run finished",
  );
  recordAuditEvent({
    workspaceId: scope.workspaceId,
    environmentId: scope.environmentId,
    endUserId: finished.endUserId,
    type: auditTypeOf(finished),
    actor: opts.actor,
    resource: { type: "function_run", id: finished.runId },
    outcome: finished.status,
    data: {
      functionName: fn.name,
      functionVersionId: version.versionId,
      mode: finished.mode,
      status: finished.status,
      budget: finished.budgetExceeded,
      actionCalls: finished.actionCallCount,
      writes: finished.writeCount,
      ...(finished.planDigest ? { planDigest: finished.planDigest } : {}),
      ...(finished.approvalId ? { approvalId: finished.approvalId } : {}),
      ...(planRun ? { planRunId: planRun.runId } : {}),
      ...(finished.status === "diverged" && finished.error ? { reason: finished.error.message } : {}),
    },
  });
  return viewOf(finished);
}

export async function getRun(scope: Scope, runId: string): Promise<FunctionRunView> {
  const [run] = await db
    .select()
    .from(functionRuns)
    .where(and(
      eq(functionRuns.workspaceId, scope.workspaceId),
      eq(functionRuns.environmentId, scope.environmentId),
      eq(functionRuns.runId, runId),
    ))
    .limit(1);
  if (!run) throw new FunctionRunNotFoundError(runId);
  return viewOf(run);
}

export interface FunctionRunListItem {
  id: string;
  functionVersionId: string;
  version: number;
  mode: FunctionRunMode;
  status: FunctionRunStatus;
  endUserId: string | null;
  actionCalls: number;
  budget: FunctionBudgetName | null;
  error: { code: string; message: string } | null;
  approvalId: string | null;
  durationMs: number | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export const MAX_LISTED_RUNS = 100;

export async function listRuns(
  scope: Scope,
  ref: string,
  opts: { endUserId?: string; limit?: number } = {},
): Promise<FunctionRunListItem[]> {
  const fn = await resolveFunction(scope, ref);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_LISTED_RUNS);
  const rows = await db
    .select({ run: functionRuns, versionId: functionVersions.versionId, version: functionVersions.version })
    .from(functionRuns)
    .innerJoin(functionVersions, eq(functionVersions.id, functionRuns.functionVersionRowId))
    .where(and(
      eq(functionRuns.functionRowId, fn.id),
      ...(opts.endUserId !== undefined ? [eq(functionRuns.endUserId, opts.endUserId)] : []),
    ))
    .orderBy(desc(functionRuns.createdAt))
    .limit(limit);
  return rows.map(({ run, versionId, version }) => ({
    id: run.runId,
    functionVersionId: versionId,
    version,
    mode: run.mode,
    status: run.status,
    endUserId: run.endUserId,
    actionCalls: run.actionCallCount,
    budget: run.budgetExceeded ?? null,
    error: run.error ?? null,
    approvalId: run.approvalId,
    durationMs: run.durationMs,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
  }));
}
