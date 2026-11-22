import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  bigint,
  index,
  jsonb,
  real,
  boolean,
  primaryKey,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { environments } from "./environments.ts";
import { workspaces, apiKeys } from "./workspaces.ts";
import { user } from "./user.ts";

export const usageLogs = pgTable("usage_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),

  date: text("date").notNull(),

  messagesPublished: bigint("messages_published", { mode: "number" }).default(0),
  messagesDelivered: bigint("messages_delivered", { mode: "number" }).default(0),
  messagesFailed: bigint("messages_failed", { mode: "number" }).default(0),
  bandwidthBytes: bigint("bandwidth_bytes", { mode: "number" }).default(0),

  eventPublishes: bigint("event_publishes", { mode: "number" }).default(0),

  actionInvokes: bigint("action_invokes", { mode: "number" }).default(0),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("usage_logs_workspace_date_unique").on(table.workspaceId, table.date),
]);

export const keyBudgets = pgTable("key_budgets", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" })
    .notNull(),
  apiKeyId: uuid("api_key_id")
    .references(() => apiKeys.id, { onDelete: "cascade" })
    .notNull()
    .unique(),

  monthlyCostCentsCap: integer("monthly_cost_cents_cap"),

  dimensionCaps: jsonb("dimension_caps").notNull().default({}),

  alertThreshold: real("alert_threshold").notNull().default(0.8),
  alertedAt: timestamp("alerted_at"),

  enabled: boolean("enabled").notNull().default(true),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("key_budgets_workspace_idx").on(table.workspaceId),
]);

export type KeyBudget = typeof keyBudgets.$inferSelect;
export type NewKeyBudget = typeof keyBudgets.$inferInsert;

export const workspaceUsagePeriods = pgTable("workspace_usage_periods", {
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  month: text("month").notNull(),
  actionReserved: bigint("action_reserved", { mode: "number" }).notNull().default(0),
  actionBilled: bigint("action_billed", { mode: "number" }).notNull().default(0),
  conditionDrafts: bigint("condition_drafts", { mode: "number" }).notNull().default(0),
  messagesReserved: bigint("messages_reserved", { mode: "number" }).notNull().default(0),
  messagesBilled: bigint("messages_billed", { mode: "number" }).notNull().default(0),
  bandwidthReserved: bigint("bandwidth_reserved", { mode: "number" }).notNull().default(0),
  bandwidthBilled: bigint("bandwidth_billed", { mode: "number" }).notNull().default(0),
  actionCreditsDrawn: bigint("action_credits_drawn", { mode: "number" }).notNull().default(0),
  functionRuns: bigint("function_runs", { mode: "number" }).notNull().default(0),
}, table => [
  primaryKey({ columns: [table.workspaceId, table.month] }),
  check("workspace_usage_nonnegative", sql`${table.actionReserved} >= 0 AND ${table.actionBilled} >= 0`),
]);

export const messageQuotaReservations = pgTable("message_quota_reservations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  month: text("month").notNull(),
  day: text("day").notNull(),
  count: integer("count").notNull(),
  bytes: bigint("bytes", { mode: "number" }).notNull(),
  state: text("state").$type<"reserved" | "billed" | "released">().notNull().default("reserved"),
}, table => [index("message_quota_day_idx").on(table.workspaceId, table.day),
  check("message_quota_quantity", sql`${table.count} > 0 AND ${table.bytes} >= 0`),
  check("message_quota_state", sql`${table.state} IN ('reserved', 'billed', 'released')`)]);

export const workspaceBudgets = pgTable("workspace_budgets", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  maxOverageCents: integer("max_overage_cents").notNull().default(0),
  alertThresholds: jsonb("alert_thresholds").$type<number[]>().notNull().default([50, 75, 90, 100]),
  behaviourAtMax: text("behaviour_at_max").$type<"alert_only">().notNull().default("alert_only"),
  enabled: boolean("enabled").notNull().default(false),
}, table => [
  check("workspace_budget_alert_only", sql`${table.behaviourAtMax} = 'alert_only'`),
  check("workspace_budget_nonnegative", sql`${table.maxOverageCents} >= 0`),
]);

export const workspaceBudgetPeriods = pgTable("workspace_budget_periods", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  month: text("month").notNull(),
  projectedOverageCents: bigint("projected_overage_cents", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.workspaceId, table.month] })]);

export const workspaceActionCredits = pgTable("workspace_action_credits", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  units: bigint("units", { mode: "number" }).notNull(),
  usedUnits: bigint("used_units", { mode: "number" }).notNull().default(0),
  sourceOrderId: text("source_order_id").notNull().unique(),
  grantedAt: timestamp("granted_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, table => [
  index("workspace_action_credits_expiry_idx").on(table.workspaceId, table.expiresAt),
  check("workspace_action_credits_positive", sql`${table.units} > 0`),
  check("workspace_action_credits_used_within", sql`${table.usedUnits} >= 0 AND ${table.usedUnits} <= ${table.units}`),
]);

export const budgetPeriods = pgTable("budget_periods", {
  apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "cascade" }).notNull(),
  month: text("month").notNull(),
  messages: bigint("messages", { mode: "number" }).notNull().default(0),
  eventPublishes: bigint("event_publishes", { mode: "number" }).notNull().default(0),
  actionInvokes: bigint("action_invokes", { mode: "number" }).notNull().default(0),
  costMicrocents: bigint("cost_microcents", { mode: "bigint" }).notNull().default(sql`0`),
  reconciliationRequired: boolean("reconciliation_required").notNull().default(false),
  reconciliationNote: text("reconciliation_note"),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
}, table => [
  primaryKey({ columns: [table.apiKeyId, table.month] }),
  check("budget_period_nonnegative", sql`${table.messages} >= 0 AND ${table.eventPublishes} >= 0 AND ${table.actionInvokes} >= 0 AND ${table.costMicrocents} >= 0`),
]);

export const budgetReservations = pgTable("budget_reservations", {
  id: uuid("id").defaultRandom().primaryKey(),
  apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "cascade" }).notNull(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "cascade" }).notNull(),
  effectId: text("effect_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  dimension: text("dimension").$type<"messages" | "eventPublishes" | "actionInvokes">().notNull(),
  amount: bigint("amount", { mode: "number" }).notNull(),
  month: text("month").notNull(),
  costMicrocents: bigint("cost_microcents", { mode: "bigint" }).notNull(),
  state: text("state").$type<"reserved" | "settled" | "refunded">().notNull().default("reserved"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, table => [
  uniqueIndex("budget_effect_active_idx").on(table.apiKeyId, table.effectId, table.dimension).where(sql`${table.state} <> 'refunded'`),
  index("budget_effect_history_idx").on(table.apiKeyId, table.effectId, table.dimension, table.createdAt),
  check("budget_reservation_quantity", sql`${table.amount} >= 0 AND ${table.costMicrocents} >= 0`),
  check("budget_reservation_state", sql`${table.state} IN ('reserved', 'settled', 'refunded')`),
  check("budget_reservation_dimension", sql`${table.dimension} IN ('messages', 'eventPublishes', 'cacheLookups', 'memoryOps', 'actionInvokes')`),
]);
