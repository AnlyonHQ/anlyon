import { sql } from "drizzle-orm";
import { type AnyPgColumn, boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { environments } from "./environments.ts";
import { workspaces } from "./workspaces.ts";

export type FunctionLanguage = "javascript" | "python";
export type FunctionRunMode = "straight_through" | "plan" | "apply";
export type FunctionRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "budget_exceeded"
  | "planned"
  | "awaiting_approval"
  | "diverged";
export type FunctionBudgetName = "maxActionCalls" | "maxCpuMs" | "maxSubrequests" | "timeoutMs";
export type FunctionCallKind = "read" | "write";
export type FunctionCallState = "intent" | "dispatched" | "refused" | "failed";

export interface StraightThroughPolicy {
  actions: string[];
  maxWrites: number;
}

export interface FunctionPlan {
  writes: Array<{
    sequence: number;
    action: string;
    canonicalInput: string;
    actionVersionId?: string | null;
  }>;
}

export interface FunctionBudgets {
  maxActionCalls: number;
  maxCpuMs: number;
  maxSubrequests: number;
  timeoutMs: number;
}

export interface FunctionRunReceipt {
  functionId: string;
  functionVersionId: string;
  digest: string;
  inputDigest: string;
  mode: FunctionRunMode;
  planDigest: string | null;
  approvalId: string | null;
  planRunId: string | null;
  calls: Array<{
    sequence: number;
    action: string;
    kind: FunctionCallKind;
    state: FunctionCallState;
    invocationId: string | null;
    refusal: string | null;
    plannedSequence: number | null;
  }>;
  outcome: Exclude<FunctionRunStatus, "running">;
  budget: FunctionBudgetName | null;
  finishedAt: string;
}

export const functions = pgTable(
  "functions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "cascade" }).notNull(),
    functionId: text("function_id").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    currentVersionId: text("current_version_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("functions_env_name_unique").on(table.environmentId, table.name).where(sql`${table.archivedAt} is null`),
  ],
);

export const functionVersions = pgTable(
  "function_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "cascade" }).notNull(),
    functionRowId: uuid("function_row_id").references(() => functions.id, { onDelete: "cascade" }).notNull(),
    versionId: text("version_id").notNull().unique(),
    version: integer("version").notNull(),
    language: text("language").$type<FunctionLanguage>().notNull(),
    sourceModules: jsonb("source_modules").$type<Record<string, string>>().notNull(),
    digest: text("digest").notNull(),
    allowedActions: jsonb("allowed_actions").$type<string[]>().notNull(),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().notNull().default({}),
    maxActionCalls: integer("max_action_calls").notNull(),
    maxCpuMs: integer("max_cpu_ms").notNull(),
    maxSubrequests: integer("max_subrequests").notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    straightThrough: jsonb("straight_through").$type<StraightThroughPolicy | null>(),
    review: jsonb("review").$type<Record<string, unknown>>(),
    publishedByKeyId: uuid("published_by_key_id"),
    publishedByUserId: text("published_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("function_versions_function_version_unique").on(table.functionRowId, table.version),
    check("function_versions_language_check", sql`${table.language} IN ('javascript', 'python')`),
    check(
      "function_versions_budgets_check",
      sql`${table.maxActionCalls} > 0 AND ${table.maxCpuMs} > 0 AND ${table.maxSubrequests} > 0 AND ${table.timeoutMs} > 0`,
    ),
  ],
);

export const functionRuns = pgTable(
  "function_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "cascade" }).notNull(),
    functionRowId: uuid("function_row_id").references(() => functions.id, { onDelete: "cascade" }).notNull(),
    functionVersionRowId: uuid("function_version_row_id").references(() => functionVersions.id, { onDelete: "cascade" }).notNull(),
    runId: text("run_id").notNull().unique(),
    mode: text("mode").$type<FunctionRunMode>().notNull().default("straight_through"),
    status: text("status").$type<FunctionRunStatus>().notNull().default("running"),
    endUserId: text("end_user_id"),
    endUserRequired: boolean("end_user_required").notNull().default(false),
    input: jsonb("input").notNull().default({}),
    inputDigest: text("input_digest").notNull(),
    output: jsonb("output"),
    error: jsonb("error").$type<{ code: string; message: string } | null>(),
    logs: jsonb("logs").$type<string[]>().notNull().default([]),
    budgetExceeded: text("budget_exceeded").$type<FunctionBudgetName>(),
    actionCallCount: integer("action_call_count").notNull().default(0),
    callCount: integer("call_count").notNull().default(0),
    runnerExecutionId: text("runner_execution_id"),
    planDigest: text("plan_digest"),
    approvalId: text("approval_id"),
    plan: jsonb("plan").$type<FunctionPlan>(),
    planRunRowId: uuid("plan_run_row_id").references((): AnyPgColumn => functionRuns.id, { onDelete: "cascade" }),
    appliedByRunId: text("applied_by_run_id"),
    writeCount: integer("write_count").notNull().default(0),
    receipt: jsonb("receipt").$type<FunctionRunReceipt>(),
    requestedByKeyId: uuid("requested_by_key_id"),
    requestedByUserId: text("requested_by_user_id"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("function_runs_function_idx").on(table.functionRowId, table.createdAt),
    index("function_runs_env_end_user_idx").on(table.environmentId, table.endUserId),
    index("function_runs_plan_run_idx").on(table.planRunRowId),
    index("function_runs_workspace_created_idx").on(table.workspaceId, table.createdAt),
    check("function_runs_mode_check", sql`${table.mode} IN ('straight_through', 'plan', 'apply')`),
    check(
      "function_runs_status_check",
      sql`${table.status} IN ('running', 'succeeded', 'failed', 'budget_exceeded', 'planned', 'awaiting_approval', 'diverged')`,
    ),
  ],
);

export const functionRunCalls = pgTable(
  "function_run_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "cascade" }).notNull(),
    runRowId: uuid("run_row_id").references(() => functionRuns.id, { onDelete: "cascade" }).notNull(),
    sequence: integer("sequence").notNull(),
    actionName: text("action_name").notNull(),
    canonicalInput: text("canonical_input").notNull(),
    kind: text("kind").$type<FunctionCallKind>().notNull(),
    state: text("state").$type<FunctionCallState>().notNull(),
    invocationId: text("invocation_id"),
    refusalCode: text("refusal_code"),
    plannedSequence: integer("planned_sequence"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("function_run_calls_run_sequence_unique").on(table.runRowId, table.sequence),
    check("function_run_calls_kind_check", sql`${table.kind} IN ('read', 'write')`),
    check("function_run_calls_state_check", sql`${table.state} IN ('intent', 'dispatched', 'refused', 'failed')`),
  ],
);
