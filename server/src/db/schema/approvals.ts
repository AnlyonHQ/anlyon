import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  pgEnum,
  index,
  integer,
  boolean,
  numeric,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.ts";
import { environments } from "./environments.ts";

export const approvalKindEnum = pgEnum("approval_kind", ["action", "custom", "function_plan"]);

export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "denied",
  "expired",
]);

export const approvalDecisionOriginEnum = pgEnum("approval_decision_origin", [
  "human",
  "policy",
  "system",
  "unknown",
  "assistant",
]);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),

    approvalId: text("approval_id").notNull().unique(),

    kind: approvalKindEnum("kind").notNull().default("custom"),
    status: approvalStatusEnum("status").notNull().default("pending"),

    title: text("title").notNull(),
    description: text("description"),

    payload: jsonb("payload").notNull().default({}),

    requestedByKeyId: uuid("requested_by_key_id"),
    requestedByUserId: text("requested_by_user_id"),
    requestedByOAuthClientId: text("requested_by_oauth_client_id"),
    decidedByUserId: text("decided_by_user_id"),
    decidedByKeyId: uuid("decided_by_key_id"),
    decisionNote: text("decision_note"),

    traceRunId: text("trace_run_id"),
    traceParentSpanId: text("trace_parent_span_id"),
    traceStartedAt: timestamp("trace_started_at"),

    requiredApprovals: integer("required_approvals").notNull().default(1),
    approvedCount: integer("approved_count").notNull().default(0),
    matchedPolicyId: text("matched_policy_id"),
    matchedPolicyVersion: integer("matched_policy_version"),
    policyExplanation: text("policy_explanation"),

    decisionOrigin: approvalDecisionOriginEnum("decision_origin"),

    previewId: text("preview_id"),
    bindingDigest: text("binding_digest"),

    endUserId: text("end_user_id"),
    decidedBy: text("decided_by").$type<"team" | "end_user">().notNull().default("team"),

    expiresAt: timestamp("expires_at").notNull(),
    decidedAt: timestamp("decided_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    wsStatusIdx: index("approvals_ws_status_idx").on(table.workspaceId, table.environmentId, table.status),
    originIdx: index("approvals_ws_origin_idx").on(table.workspaceId, table.environmentId, table.decisionOrigin, table.createdAt),
    traceRunIdIdx: index("approvals_trace_run_id_idx").on(table.traceRunId),
    statusExpiresIdx: index("approvals_status_expires_idx").on(table.status, table.expiresAt),
    approvalIdIdx: index("approvals_approval_id_idx").on(table.approvalId),
    endUserIdx: index("approvals_env_end_user_idx").on(table.environmentId, table.endUserId),
  })
);

export const approvalPolicyEffectEnum = pgEnum("approval_policy_effect", [
  "require_approval",
  "auto_approve",
  "auto_deny",
]);

export const approvalPolicyMatchKindEnum = pgEnum("approval_policy_match_kind", [
  "any",
  "action",
  "custom",
]);

export const approvalPolicies = pgTable(
  "approval_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),
    policyId: text("policy_id").notNull().unique(),
    name: text("name").notNull(),
    priority: integer("priority").notNull().default(100),
    enabled: boolean("enabled").notNull().default(true),

    matchKind: approvalPolicyMatchKindEnum("match_kind").notNull().default("any"),
    matchActionName: text("match_action_name"),
    matchAgentId: text("match_agent_id"),
    matchUserId: text("match_user_id"),
    matchTags: jsonb("match_tags").$type<string[]>(),
    minAmount: numeric("min_amount"),
    conditions: jsonb("conditions").$type<Record<string, unknown>>(),
    condition: text("condition"),
    managedByFile: text("managed_by_file"),
    managedKey: text("managed_key"),

    effect: approvalPolicyEffectEnum("effect").notNull().default("require_approval"),
    requiredApprovals: integer("required_approvals").notNull().default(1),
    decidedBy: text("decided_by").$type<"team" | "end_user">().notNull().default("team"),

    version: integer("version").notNull().default(1),
    scopeReviewedAt: timestamp("scope_reviewed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    nameUnique: unique("approval_policies_env_name_unique").on(table.environmentId, table.name),
    envPriorityIdx: index("approval_policies_env_priority_idx").on(table.environmentId, table.priority),
    managedKeyUnique: uniqueIndex("approval_policies_managed_key_unique")
      .on(table.environmentId, table.managedByFile, table.managedKey)
      .where(sql`managed_by_file IS NOT NULL`),
  })
);

export const approvalPolicyVersions = pgTable("approval_policy_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "cascade" }).notNull(),
  policyId: text("policy_id").notNull(),
  version: integer("version").notNull(),
  operation: text("operation").$type<"created" | "updated" | "deleted" | "baseline">().notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  contentHash: text("content_hash").notNull(),
  actorType: text("actor_type").$type<"api_key" | "user" | "unknown">().notNull(),
  actorId: text("actor_id"),
  changeNote: text("change_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  policyVersionUnique: unique("approval_policy_versions_policy_version_unique").on(table.policyId, table.version),
  scopeIndex: index("approval_policy_versions_scope_idx").on(table.workspaceId, table.environmentId, table.policyId),
}));

export const approvalDecisionEnum = pgEnum("approval_decision", ["approve", "deny"]);

export const approvalDecisions = pgTable(
  "approval_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    approvalId: uuid("approval_id")
      .references(() => approvals.id, { onDelete: "cascade" })
      .notNull(),
    deciderKeyId: uuid("decider_key_id"),
    deciderUserId: text("decider_user_id"),
    decision: approvalDecisionEnum("decision").notNull(),
    note: text("note"),
    selfApproved: boolean("self_approved").default(false).notNull(),
    decidedAt: timestamp("decided_at").defaultNow().notNull(),
  },
  (table) => ({
    approvalIdx: index("approval_decisions_approval_idx").on(table.approvalId),
    keyUnique: uniqueIndex("approval_decisions_key_unique")
      .on(table.approvalId, table.deciderKeyId)
      .where(sql`${table.deciderKeyId} IS NOT NULL`),
    userUnique: uniqueIndex("approval_decisions_user_unique")
      .on(table.approvalId, table.deciderUserId)
      .where(sql`${table.deciderUserId} IS NOT NULL`),
    assistantUnique: uniqueIndex("approval_decisions_assistant_unique")
      .on(table.approvalId)
      .where(sql`${table.deciderKeyId} IS NULL AND ${table.deciderUserId} IS NULL`),
  })
);

export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
export type ApprovalPolicy = typeof approvalPolicies.$inferSelect;
export type NewApprovalPolicy = typeof approvalPolicies.$inferInsert;
export type ApprovalDecision = typeof approvalDecisions.$inferSelect;
export type NewApprovalDecision = typeof approvalDecisions.$inferInsert;
