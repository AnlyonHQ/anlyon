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
  real,
  primaryKey,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.ts";
import { approvals } from "./approvals.ts";

export interface AssistantAutoApprove {
  enabled: boolean;
  actions: string[];
  environments?: string[];
  maxAmount?: number | null;
  minConfidence: number;
  maxRisk: number;
  minHistory: number;
}

export const DEFAULT_AUTO_APPROVE: AssistantAutoApprove = {
  enabled: false,
  actions: [],
  minConfidence: 0.9,
  maxRisk: 1,
  minHistory: 20,
};

export const workspaceAssistantSettings = pgTable("workspace_assistant_settings", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  consentVersion: text("consent_version"),
  consentedByUserId: text("consented_by_user_id"),
  consentedAt: timestamp("consented_at"),
  excludedFields: jsonb("excluded_fields").$type<string[]>().notNull().default([]),
  autoApprove: jsonb("auto_approve").$type<AssistantAutoApprove>().notNull().default(DEFAULT_AUTO_APPROVE),
  auditSampleRate: real("audit_sample_rate").notNull().default(0.1),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const approvalAdviceStatusEnum = pgEnum("approval_advice_status", [
  "pending",
  "ready",
  "failed",
  "skipped",
]);

export const approvalAdviceRecommendationEnum = pgEnum("approval_advice_recommendation", [
  "approve",
  "deny",
  "review",
]);

export interface AdviceFlags {
  injectionSuspected: number | null;
  consistentWithHistory: number | null;
  amountUnusual: number | null;
}

export interface AdviceHistory {
  approved: number;
  denied: number;
  maxAmount: number | null;
  medianAmount: number | null;
}

export const approvalAdvice = pgTable(
  "approval_advice",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    approvalId: uuid("approval_id")
      .notNull()
      .unique()
      .references(() => approvals.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    status: approvalAdviceStatusEnum("status").notNull().default("pending"),
    statusReason: text("status_reason"),
    model: text("model"),
    recommendation: approvalAdviceRecommendationEnum("recommendation"),
    risk: real("risk"),
    confidence: real("confidence"),
    flags: jsonb("flags").$type<AdviceFlags>(),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    history: jsonb("history").$type<AdviceHistory>(),
    inputTokens: integer("input_tokens"),
    latencyMs: integer("latency_ms"),
    attempts: integer("attempts").notNull().default(0),
    claimedAt: timestamp("claimed_at"),
    auditRequested: boolean("audit_requested").notNull().default(false),
    auditVerdict: text("audit_verdict"),
    auditedByUserId: text("audited_by_user_id"),
    auditedAt: timestamp("audited_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    wsCreatedIdx: index("approval_advice_ws_created_idx").on(table.workspaceId, table.createdAt),
    pendingIdx: index("approval_advice_status_created_idx").on(table.status, table.createdAt),
  }),
);

export const assistantUsage = pgTable(
  "assistant_usage",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    period: text("period").notNull(),
    kind: text("kind").notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.period, table.kind] }),
  }),
);
