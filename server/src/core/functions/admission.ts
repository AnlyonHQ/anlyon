import { and, count, eq, gt, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { workspaceUsagePeriods } from "../../db/schema/billing.ts";
import { functionRuns } from "../../db/schema/functions.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { getMonthKey } from "../../lib/workspace-cache.ts";
import { ApiError, NotFoundError } from "../../utils/errors.ts";
import { getPlanLimits, type FunctionRunLimits } from "../plans/limits.ts";
import { PaymentRequiredError, QuotaExceededError, billingSettingsUrl } from "../billing/usage-enforcement.ts";
import { MAX_RUN_TOKEN_SECONDS } from "./run-token.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const RUN_SLOT_SECONDS = MAX_RUN_TOKEN_SECONDS + 60;
const MINUTE_MS = 60_000;

export class FunctionRunConcurrencyError extends ApiError {
  constructor(cap: number) {
    super(
      429,
      "FUNCTION_RUN_CONCURRENCY_LIMIT",
      `Your plan allows ${cap} function ${cap === 1 ? "run" : "runs"} at once, and that many are running. Nothing ran. Retry when one ends.`,
      { limit: "concurrentRuns", cap },
    );
    this.name = "FunctionRunConcurrencyError";
  }
}

export class FunctionRunRateError extends ApiError {
  constructor(cap: number) {
    super(
      429,
      "FUNCTION_RUN_RATE_LIMITED",
      `Your plan allows ${cap} function runs to start a minute. Nothing ran. Retry in a minute.`,
      { limit: "runStartsPerMinute", cap },
    );
    this.name = "FunctionRunRateError";
  }
}

function monthlyRefusal(cap: number): QuotaExceededError {
  const error = new QuotaExceededError(
    `Your plan allows ${cap.toLocaleString("en-US")} function runs a month, and this month's are used. Nothing ran. ` +
      `They come back on the 1st (UTC), or change plan at ${billingSettingsUrl()}.`,
    0,
  );
  error.details = { limit: "runsPerMonth", cap, remainingQuota: 0 };
  return error;
}

const periodWhere = (workspaceId: string, month: string) =>
  and(eq(workspaceUsagePeriods.workspaceId, workspaceId), eq(workspaceUsagePeriods.month, month));

async function runningCount(query: Pick<Transaction, "select">, workspaceId: string, now: Date): Promise<number> {
  const [row] = await query
    .select({ value: count() })
    .from(functionRuns)
    .where(and(
      eq(functionRuns.workspaceId, workspaceId),
      eq(functionRuns.status, "running"),
      gt(functionRuns.createdAt, new Date(now.getTime() - RUN_SLOT_SECONDS * 1000)),
    ));
  return Number(row?.value ?? 0);
}

export async function admitFunctionRun(tx: Transaction, workspaceId: string, now: Date = new Date()): Promise<string> {
  const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
  if (!workspace) throw new NotFoundError("Workspace");
  const limits = getPlanLimits(workspace.plan, workspace);
  if (limits.usagePolicy.actionInvokes.kind === "payment-required") {
    throw new PaymentRequiredError(
      `This workspace has no plan, so functions do not run. Choose a plan at ${billingSettingsUrl()} to run them.`,
    );
  }
  const { concurrentRuns, runStartsPerMinute, runsPerMonth } = limits.functionRuns;

  if (concurrentRuns !== "unlimited" && (await runningCount(tx, workspaceId, now)) >= concurrentRuns) {
    throw new FunctionRunConcurrencyError(concurrentRuns);
  }
  if (runStartsPerMinute !== "unlimited") {
    const [recent] = await tx
      .select({ value: count() })
      .from(functionRuns)
      .where(and(eq(functionRuns.workspaceId, workspaceId), gt(functionRuns.createdAt, new Date(now.getTime() - MINUTE_MS))));
    if (Number(recent?.value ?? 0) >= runStartsPerMinute) throw new FunctionRunRateError(runStartsPerMinute);
  }

  const month = getMonthKey();
  await tx.insert(workspaceUsagePeriods).values({ workspaceId, month }).onConflictDoNothing();
  const [period] = await tx.select().from(workspaceUsagePeriods).where(periodWhere(workspaceId, month)).for("update");
  if (runsPerMonth !== "unlimited" && (period?.functionRuns ?? 0) >= runsPerMonth) throw monthlyRefusal(runsPerMonth);
  await tx
    .update(workspaceUsagePeriods)
    .set({ functionRuns: sql`${workspaceUsagePeriods.functionRuns} + 1` })
    .where(periodWhere(workspaceId, month));
  return month;
}

export async function releaseFunctionRun(workspaceId: string, month: string): Promise<void> {
  await db
    .update(workspaceUsagePeriods)
    .set({ functionRuns: sql`greatest(${workspaceUsagePeriods.functionRuns} - 1, 0)` })
    .where(periodWhere(workspaceId, month));
}

export interface FunctionRunUsage {
  used: number;
  running: number;
  limits: FunctionRunLimits;
}

export async function getFunctionRunUsage(workspaceId: string, now: Date = new Date()): Promise<FunctionRunUsage> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new NotFoundError("Workspace");
  const [period] = await db.select({ functionRuns: workspaceUsagePeriods.functionRuns }).from(workspaceUsagePeriods)
    .where(periodWhere(workspaceId, getMonthKey()));
  return {
    used: period?.functionRuns ?? 0,
    running: await runningCount(db, workspaceId, now),
    limits: getPlanLimits(workspace.plan, workspace).functionRuns,
  };
}
