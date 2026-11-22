import { pgTable, text, timestamp, uuid, pgEnum, bigint, integer, index, uniqueIndex, unique, jsonb, boolean, check } from "drizzle-orm/pg-core";
import { user } from "./user.ts";
import { environments } from "./environments.ts";
import { sql } from "drizzle-orm";

export const planEnum = pgEnum("plan", ["free", "paygo", "enterprise", "production", "growth", "starter"]);
export const roleEnum = pgEnum("role", ["owner", "admin", "member", "approver", "viewer"]);

export const workspaceColumns = () => ({
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: planEnum("plan").notNull().default("free"),
  pendingPlan: planEnum("pending_plan"),
  
  subscriptionStatus: text("subscription_status").default("active"),

  billingInterval: text("billing_interval").$type<"month" | "year">(),
  currentPeriodEnd: timestamp("current_period_end"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),

  trialEndsAt: timestamp("trial_ends_at"),

  deliverySuspendedAt: timestamp("delivery_suspended_at"),
  deliverySuspendedReason: text("delivery_suspended_reason"),

  monthlyMessageQuota: text("monthly_message_quota").default("1000"),

  currentMonthMessages: bigint("current_month_messages", { mode: "number" }).default(0),
  currentMonthBandwidth: bigint("current_month_bandwidth", { mode: "number" }).default(0),
  usageResetDate: timestamp("usage_reset_date"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const workspaces = pgTable("workspaces", workspaceColumns());

export const workspaceMembers = pgTable("workspace_members", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }).notNull(),
  role: roleEnum("role").notNull().default("member"),
  emergencyAccess: boolean("emergency_access").notNull().default(false),

  invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
  invitedAt: timestamp("invited_at").defaultNow(),

  joinedAt: timestamp("joined_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("workspace_members_workspace_user_unique").on(table.workspaceId, table.userId),
  index("idx_workspace_members_user_id").on(table.userId),
  check("workspace_members_no_owner_role", sql`${table.role} <> 'owner'`),
  check("workspace_members_emergency_access_admin", sql`NOT ${table.emergencyAccess} OR ${table.role} = 'admin'`),
]);

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  environmentId: uuid("environment_id")
    .references(() => environments.id, { onDelete: "cascade" })
    .notNull(),

  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  budgetPrincipal: text("budget_principal").unique(),

  version: integer("version").notNull().default(1),

  isActive: text("is_active").default("true"),
  scopes: jsonb("scopes").$type<string[]>(),
  endUserRequired: boolean("end_user_required").notNull().default(false),

  lastUsedAt: timestamp("last_used_at"),

  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
}, (table) => [
  index("idx_api_keys_workspace_id").on(table.workspaceId),
  index("idx_api_keys_environment_id").on(table.environmentId),
  uniqueIndex("idx_api_keys_key_hash").on(table.keyHash),
]);

export const apiKeyHistory = pgTable("api_key_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "cascade" }).notNull(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),

  previousKeyHashEncrypted: text("previous_key_hash_encrypted").notNull(),
  previousKeyPrefix: text("previous_key_prefix").notNull(),

  version: integer("version").notNull(),

  rotatedAt: timestamp("rotated_at").defaultNow().notNull(),
  rollbackExpiresAt: timestamp("rollback_expires_at").notNull(),

  rotatedBy: text("rotated_by").references(() => user.id, { onDelete: "set null" }),
}, (table) => [
  index("idx_api_key_history_api_key_id").on(table.apiKeyId),
  index("idx_api_key_history_workspace_id").on(table.workspaceId),
]);

export const deliverySecrets = pgTable("delivery_secrets", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),

  secretEncrypted: text("secret_encrypted").notNull(),
  secretPrefix: text("secret_prefix").notNull(),

  version: integer("version").notNull().default(1),
  isActive: text("is_active").default("true"),

  lastUsedAt: timestamp("last_used_at"),

  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  deactivatedAt: timestamp("deactivated_at"),
}, (table) => [
  index("delivery_secrets_workspace_active_idx").on(table.workspaceId, table.isActive),
  uniqueIndex("delivery_secrets_one_active_per_workspace")
    .on(table.workspaceId)
    .where(sql`${table.isActive} = 'true'`),
]);
