import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  jsonb,
  index,
  unique,
  numeric,
  pgEnum,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.ts";
import { environments } from "./environments.ts";

export const runStatusEnum = pgEnum("run_status", ["running", "succeeded", "failed", "cancelled"]);

export const spanTypeEnum = pgEnum("span_type", [
  "model_call",
  "context_assembly",
  "session_read",
  "session_write",
  "memory_recall",
  "memory_write",
  "tool_call",
  "action_call",
  "approval_wait",
  "approval_decision",
  "workflow_step",
  "queue_delivery",
  "event_delivery",
  "custom",
  "budget_check",
]);

export const spanStatusEnum = pgEnum("span_status", ["running", "succeeded", "failed"]);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),
    agentId: text("agent_id"),
    agentVersionId: text("agent_version_id"),
    runId: text("run_id").notNull().unique(),
    name: text("name"),
    status: runStatusEnum("status").notNull().default("running"),
    userId: text("user_id"),
    application: text("application"),
    input: jsonb("input"),
    output: jsonb("output"),
    error: jsonb("error").$type<Record<string, unknown>>(),
    tokens: integer("tokens"),
    cost: numeric("cost"),
    tags: jsonb("tags").$type<string[]>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    endedAt: timestamp("ended_at"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    wsIdx: index("idx_runs_workspace_id").on(table.workspaceId),
    envIdx: index("idx_runs_environment_id").on(table.environmentId),
    wsStartedIdx: index("idx_runs_ws_started").on(table.workspaceId, table.startedAt),
    agentIdx: index("idx_runs_agent_id").on(table.agentId),
  }),
);

export const spans = pgTable(
  "spans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),
    runId: uuid("run_id")
      .references(() => runs.id, { onDelete: "cascade" })
      .notNull(),
    spanId: text("span_id").notNull(),
    parentSpanId: text("parent_span_id"),
    name: text("name").notNull(),
    type: spanTypeEnum("type").notNull().default("custom"),
    status: spanStatusEnum("status").notNull().default("running"),
    input: jsonb("input"),
    output: jsonb("output"),
    error: jsonb("error").$type<Record<string, unknown>>(),
    model: text("model"),
    provider: text("provider"),
    tokens: jsonb("tokens").$type<Record<string, number>>(),
    cost: numeric("cost"),
    attributes: jsonb("attributes").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at").notNull(),
    endedAt: timestamp("ended_at"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    spanUnique: unique("spans_run_span_unique").on(table.runId, table.spanId),
    runIdx: index("idx_spans_run_id").on(table.runId),
    parentIdx: index("idx_spans_parent").on(table.runId, table.parentSpanId),
  }),
);

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Span = typeof spans.$inferSelect;
export type NewSpan = typeof spans.$inferInsert;
