import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.ts";
import { environments } from "./environments.ts";
import { actions, actionInvocations } from "./actions.ts";

export const effectStageEnum = pgEnum("effect_stage", [
  "awaiting_approval",
  "ready",
  "dispatching",
  "reconciling",
  "settled",
  "rejected",
]);

export const effectOutcomeEnum = pgEnum("effect_outcome", [
  "not_dispatched",
  "pending",
  "succeeded",
  "failed",
  "unknown",
]);

export type EffectStage = (typeof effectStageEnum.enumValues)[number];
export type EffectOutcome = (typeof effectOutcomeEnum.enumValues)[number];
export type PartialEffect = "none" | "possible" | "confirmed";
export type OutcomeSource = "provider" | "manual" | "system";
export type EffectGrade = "confirmed" | "acknowledged" | "unknown" | "failed" | "refused" | "denied" | "pending";

const GRADE = sql`CASE
  WHEN stage = 'rejected' THEN CASE WHEN rejection_reason = 'approval_denied' THEN 'denied' ELSE 'refused' END
  WHEN outcome = 'succeeded' THEN CASE WHEN outcome_verified AND outcome_source = 'provider' THEN 'confirmed' ELSE 'acknowledged' END
  WHEN outcome = 'failed' THEN 'failed'
  WHEN outcome = 'unknown' THEN 'unknown'
  ELSE 'pending'
END`;

export const actionEffects = pgTable(
  "action_effects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "cascade" }).notNull(),
    actionId: uuid("action_id").references(() => actions.id, { onDelete: "cascade" }).notNull(),
    invocationId: uuid("invocation_id").references(() => actionInvocations.id, { onDelete: "cascade" }).notNull(),

    effectId: text("effect_id").notNull().unique(),

    operationKey: text("operation_key").notNull(),
    requestDigest: text("request_digest").notNull(),

    actionName: text("action_name").notNull(),
    actionVersionId: text("action_version_id").notNull(),
    adapterType: text("adapter_type").notNull(),
    adapterVersion: text("adapter_version").notNull(),

    requestedByKeyId: uuid("requested_by_key_id"),
    requestedByUserId: text("requested_by_user_id"),
    endUserId: text("end_user_id"),

    targetAccount: text("target_account").notNull(),
    resourceKey: text("resource_key").notNull(),
    target: jsonb("target").$type<Record<string, unknown>>().notNull(),
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    impact: jsonb("impact").$type<Array<Record<string, unknown>>>().notNull(),
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull(),
    providerIdempotencyKey: text("provider_idempotency_key"),

    previewId: uuid("preview_id"),
    bindingDigest: text("binding_digest"),
    approvalId: text("approval_id"),
    approvalConsumedAt: timestamp("approval_consumed_at", { withTimezone: true }),

    dependsOn: jsonb("depends_on").$type<Array<{ effectId: string; outcome: string }>>().notNull().default([]),
    compensatesEffectId: text("compensates_effect_id"),

    stage: effectStageEnum("stage").notNull(),
    outcome: effectOutcomeEnum("outcome").notNull().default("not_dispatched"),
    partialEffect: text("partial_effect").$type<PartialEffect>().notNull().default("none"),
    outcomeSource: text("outcome_source").$type<OutcomeSource>(),
    providerReference: text("provider_reference"),
    rejectionReason: text("rejection_reason"),
    outcomeVerified: boolean("outcome_verified").notNull().default(false),
    grade: text("grade").$type<EffectGrade>().notNull().generatedAlwaysAs(GRADE),

    firstDispatchedAt: timestamp("first_dispatched_at", { withTimezone: true }),
    outcomeAt: timestamp("outcome_at", { withTimezone: true }),

    nextReconcileAt: timestamp("next_reconcile_at", { withTimezone: true }),
    reconcileAttempts: integer("reconcile_attempts").notNull().default(0),
    reconcileLeaseOwner: text("reconcile_lease_owner"),
    reconcileLeaseUntil: timestamp("reconcile_lease_until", { withTimezone: true }),
    reconcileExhausted: boolean("reconcile_exhausted").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    scopedIdentity: unique("action_effects_scoped_identity").on(table.id, table.workspaceId, table.environmentId),
    operationUnique: uniqueIndex("action_effects_operation_unique").on(table.workspaceId, table.environmentId, table.operationKey),
    invocationUnique: uniqueIndex("action_effects_invocation_unique").on(table.invocationId),
    previewUnique: uniqueIndex("action_effects_preview_unique").on(table.previewId).where(sql`preview_id IS NOT NULL`),
    wsCreatedIdx: index("action_effects_ws_created_idx").on(table.workspaceId, table.environmentId, table.createdAt),
    endUserIdx: index("action_effects_env_end_user_idx").on(table.environmentId, table.endUserId),
    reconcileDueIdx: index("action_effects_reconcile_due_idx").on(table.nextReconcileAt).where(sql`next_reconcile_at IS NOT NULL`),
    stageIdx: index("action_effects_stage_idx").on(table.stage),
    partialCheck: check("action_effects_partial_effect_check", sql`partial_effect IN ('none', 'possible', 'confirmed')`),
    sourceCheck: check("action_effects_outcome_source_check", sql`outcome_source IS NULL OR outcome_source IN ('provider', 'manual', 'system')`),
    verifiedCheck: check("action_effects_outcome_verified_check",
      sql`NOT outcome_verified OR (outcome = 'succeeded' AND outcome_source = 'provider')`),
  })
);

export const effectAttempts = pgTable(
  "effect_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    environmentId: uuid("environment_id").notNull(),
    effectId: uuid("effect_id").notNull(),
    attemptNo: integer("attempt_no").notNull(),
    kind: text("kind").$type<"dispatch" | "replay" | "reconcile">().notNull(),
    status: text("status").$type<"started" | "completed" | "abandoned">().notNull().default("started"),
    leaseOwner: text("lease_owner").notNull(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
    observedOutcome: text("observed_outcome"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => ({
    effectFk: foreignKey({
      name: "effect_attempts_effect_scope_fk",
      columns: [table.effectId, table.workspaceId, table.environmentId],
      foreignColumns: [actionEffects.id, actionEffects.workspaceId, actionEffects.environmentId],
    }).onDelete("cascade"),
    attemptUnique: unique("effect_attempts_effect_attempt_unique").on(table.effectId, table.attemptNo),
    oneDispatch: uniqueIndex("effect_attempts_one_dispatch").on(table.effectId).where(sql`kind = 'dispatch'`),
    oneWriteInFlight: uniqueIndex("effect_attempts_one_write_in_flight").on(table.effectId)
      .where(sql`status = 'started' AND kind IN ('dispatch', 'replay')`),
    staleIdx: index("effect_attempts_started_lease_idx").on(table.leaseUntil).where(sql`status = 'started'`),
    kindCheck: check("effect_attempts_kind_check", sql`kind IN ('dispatch', 'replay', 'reconcile')`),
    statusCheck: check("effect_attempts_status_check", sql`status IN ('started', 'completed', 'abandoned')`),
  })
);

export type EvidenceSource =
  | "provider_response"
  | "provider_lookup"
  | "system"
  | "operator_note"
  | "manual_resolution"
  | "preview";

export const effectEvidence = pgTable(
  "effect_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    environmentId: uuid("environment_id").notNull(),
    effectId: uuid("effect_id").notNull(),
    attemptId: uuid("attempt_id"),
    source: text("source").$type<EvidenceSource>().notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    impliedOutcome: text("implied_outcome"),
    providerIds: jsonb("provider_ids").$type<Record<string, string>>().notNull().default({}),
    summary: text("summary").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    actorType: text("actor_type").$type<"api_key" | "user" | "system">().notNull().default("system"),
    actorId: text("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    effectFk: foreignKey({
      name: "effect_evidence_effect_scope_fk",
      columns: [table.effectId, table.workspaceId, table.environmentId],
      foreignColumns: [actionEffects.id, actionEffects.workspaceId, actionEffects.environmentId],
    }).onDelete("cascade"),
    effectIdx: index("effect_evidence_effect_idx").on(table.effectId, table.createdAt),
    sourceCheck: check("effect_evidence_source_check",
      sql`source IN ('provider_response', 'provider_lookup', 'system', 'operator_note', 'manual_resolution', 'preview')`),
  })
);

export const effectPreviews = pgTable(
  "effect_previews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "cascade" }).notNull(),
    actionId: uuid("action_id").references(() => actions.id, { onDelete: "cascade" }).notNull(),
    previewId: text("preview_id").notNull().unique(),
    actionName: text("action_name").notNull(),
    actionVersionId: text("action_version_id").notNull(),
    adapterType: text("adapter_type").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    requestDigest: text("request_digest").notNull(),
    bindingDigest: text("binding_digest").notNull(),
    targetAccount: text("target_account").notNull(),
    resourceKey: text("resource_key").notNull(),
    target: jsonb("target").$type<Record<string, unknown>>().notNull(),
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    impact: jsonb("impact").$type<Array<Record<string, unknown>>>().notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    blocks: jsonb("blocks").$type<Array<Record<string, unknown>>>().notNull(),
    preconditions: jsonb("preconditions").$type<Record<string, unknown>>().notNull(),
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull(),
    allowances: jsonb("allowances").$type<Array<Record<string, unknown>>>().notNull().default([]),
    evidenceObservedAt: timestamp("evidence_observed_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    supersedesPreviewId: text("supersedes_preview_id"),
    requestedByKeyId: uuid("requested_by_key_id"),
    endUserId: text("end_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    wsIdx: index("effect_previews_ws_idx").on(table.workspaceId, table.environmentId, table.createdAt),
  })
);

export type ImpactDimension = string;
export type LimitPeriod = "day" | "month" | "total";
export type LimitScope = "environment" | "end_user";

export const impactLimits = pgTable(
  "impact_limits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "cascade" }).notNull(),
    limitId: text("limit_id").notNull().unique(),
    name: text("name").notNull(),
    dimension: text("dimension").$type<ImpactDimension>().notNull(),
    currency: text("currency"),
    actionName: text("action_name"),
    resourcePrefix: text("resource_prefix"),
    scope: text("scope").$type<LimitScope>().notNull().default("environment"),
    period: text("period").$type<LimitPeriod>().notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    outstandingReserved: bigint("outstanding_reserved", { mode: "number" }).notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    wsIdx: index("impact_limits_ws_idx").on(table.workspaceId, table.environmentId),
    dimensionCheck: check("impact_limits_dimension_check", sql`dimension ~ '^[a-z][a-z0-9_]{0,31}$'`),
    currencyCheck: check("impact_limits_currency_check",
      sql`(dimension = 'money' AND currency ~ '^[a-z]{3}$') OR (dimension <> 'money' AND currency IS NULL)`),
    periodCheck: check("impact_limits_period_check", sql`period IN ('day', 'month', 'total')`),
    scopeCheck: check("impact_limits_scope_check", sql`scope IN ('environment', 'end_user')`),
    amountCheck: check("impact_limits_amount_check", sql`amount >= 0`),
    outstandingCheck: check("impact_limits_outstanding_check", sql`outstanding_reserved >= 0`),
  })
);

export const impactLimitPeriods = pgTable(
  "impact_limit_periods",
  {
    limitId: uuid("limit_id").references(() => impactLimits.id, { onDelete: "cascade" }).notNull(),
    periodKey: text("period_key").notNull(),
    consumed: bigint("consumed", { mode: "number" }).notNull().default(0),
    reserved: bigint("reserved", { mode: "number" }).notNull().default(0),
    unknownExposure: bigint("unknown_exposure", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "impact_limit_periods_pk", columns: [table.limitId, table.periodKey] }),
    nonNegative: check("impact_limit_periods_non_negative",
      sql`consumed >= 0 AND reserved >= 0 AND unknown_exposure >= 0 AND unknown_exposure <= reserved`),
  })
);

export const impactReservations = pgTable(
  "impact_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    environmentId: uuid("environment_id").notNull(),
    effectId: uuid("effect_id").notNull(),
    limitId: uuid("limit_id").references(() => impactLimits.id, { onDelete: "cascade" }).notNull(),
    periodKey: text("period_key").notNull(),
    dimension: text("dimension").$type<ImpactDimension>().notNull(),
    currency: text("currency"),
    amount: bigint("amount", { mode: "number" }).notNull(),
    state: text("state").$type<"reserved" | "settled" | "released">().notNull().default("reserved"),
    exposure: text("exposure").$type<"dispatching" | "pending" | "unknown" | "partial">(),
    settledAmount: bigint("settled_amount", { mode: "number" }).notNull().default(0),
    releasedAmount: bigint("released_amount", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => ({
    effectFk: foreignKey({
      name: "impact_reservations_effect_scope_fk",
      columns: [table.effectId, table.workspaceId, table.environmentId],
      foreignColumns: [actionEffects.id, actionEffects.workspaceId, actionEffects.environmentId],
    }).onDelete("cascade"),
    effectLimitUnique: unique("impact_reservations_effect_limit_unique").on(table.effectId, table.limitId),
    limitStateIdx: index("impact_reservations_limit_state_idx").on(table.limitId, table.state),
    stateCheck: check("impact_reservations_state_check", sql`state IN ('reserved', 'settled', 'released')`),
    amountsCheck: check("impact_reservations_amounts_check",
      sql`amount >= 0 AND settled_amount >= 0 AND released_amount >= 0 AND settled_amount + released_amount <= amount`),
  })
);

export type ActionEffect = typeof actionEffects.$inferSelect;
export type EffectAttempt = typeof effectAttempts.$inferSelect;
export type EffectEvidenceRow = typeof effectEvidence.$inferSelect;
export type EffectPreview = typeof effectPreviews.$inferSelect;
export type ImpactLimit = typeof impactLimits.$inferSelect;
export type ImpactLimitPeriod = typeof impactLimitPeriods.$inferSelect;
export type ImpactReservation = typeof impactReservations.$inferSelect;
