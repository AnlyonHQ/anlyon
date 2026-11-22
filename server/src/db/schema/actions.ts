import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  jsonb,
  boolean,
  pgEnum,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.ts";
import { environments } from "./environments.ts";
import { secretStores } from "./secret-stores.ts";

export interface ActionAdapterConfig {
  type: string;
  config: Record<string, unknown>;
  credentialSecret: string;
}

export interface ActionImpactDeclaration {
  dimension: string;
  unit: string;
  amount: string;
  bound: "exact" | "upper_bound";
}

export interface ActionVerifyDeclaration {
  url: string;
  status: number;
  match: Array<{ path: string; equals: string | number | boolean | null; absent?: boolean }>;
  graphql?: { query: string; variables?: Record<string, string | number | boolean | null> };
}

export interface ActionMcpBinding {
  upstreamId: string;
  toolName: string;
  toolHash: string;
  suggestedClass: "read" | "write" | "irreversible" | "destructive";
  oauthConnection?: string;
  endUserKey?: { connection: string; header: string };
  schemaCheck?: "full" | "loose";
  schemaCheckReason?: string;
}

export interface ActionDeclarations {
  impact: ActionImpactDeclaration | null;
  verify: ActionVerifyDeclaration | null;
}

export const actionMethodEnum = pgEnum("action_method", [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

export const actionInvocationStatusEnum = pgEnum("action_invocation_status", [
  "pending_approval",
  "running",
  "succeeded",
  "failed",
  "unknown",
  "denied",
  "expired",
]);

export interface SecretConnectionRef {
  provider: "anlyon" | "nango";
  integrationId: string;
  connectionId: string;
  status?: "active" | "needs_reauth";
}

export type SecretHealthReason =
  | "key_rejected"
  | "access_revoked"
  | "refresh_failed"
  | "store_unreachable"
  | "store_denied"
  | "reference_not_found";

export interface SecretHealth {
  status: "active" | "needs_reauth" | "unreachable";
  checkedAt: string | null;
  reason: SecretHealthReason | null;
}

export interface SecretExternalRef {
  storeRowId: string;
  store: string;
  storeType: "aws_secrets_manager" | "hashicorp_vault";
  path: string;
  key: string | null;
  version: string | null;
}

export const workspaceSecrets = pgTable(
  "workspace_secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),

    secretId: text("secret_id").notNull().unique(),

    name: text("name").notNull(),

    valueEncrypted: text("value_encrypted").notNull(),

    description: text("description"),
    lastUsedAt: timestamp("last_used_at"),

    allowedHosts: jsonb("allowed_hosts").$type<string[]>(),

    allowedPlacements: jsonb("allowed_placements").$type<string[]>(),

    kind: text("kind").$type<"static" | "connection" | "external">().default("static").notNull(),

    connection: jsonb("connection").$type<SecretConnectionRef>(),

    integrationId: text("integration_id"),

    health: jsonb("health").$type<SecretHealth>(),

    secretStoreId: uuid("secret_store_id").references(() => secretStores.id),
    external: jsonb("external").$type<SecretExternalRef>(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    wsNameUnique: uniqueIndex("workspace_secrets_ws_name_unique").on(
      table.workspaceId,
      table.environmentId,
      table.name
    ),
  })
);

export const actions = pgTable(
  "actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),

    actionId: text("action_id").notNull().unique(),

    name: text("name").notNull(),
    description: text("description"),

    method: actionMethodEnum("method").notNull().default("POST"),

    urlTemplate: text("url_template").notNull(),

    headers: jsonb("headers").notNull().default({}),

    bodyTemplate: jsonb("body_template"),

    inputSchema: jsonb("input_schema").notNull().default({}),

    requiresApproval: boolean("requires_approval").notNull().default(false),

    adapter: jsonb("adapter").$type<ActionAdapterConfig | null>(),

    declarations: jsonb("declarations").$type<ActionDeclarations | null>(),

    mcp: jsonb("mcp").$type<ActionMcpBinding | null>(),

    currentVersionId: text("current_version_id"),
    enabled: boolean("enabled").notNull().default(true),

    archivedAt: timestamp("archived_at"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    wsNameUnique: uniqueIndex("actions_ws_name_unique")
      .on(table.workspaceId, table.environmentId, table.name)
      .where(sql`${table.archivedAt} is null`),
    actionIdIdx: index("actions_action_id_idx").on(table.actionId),
  })
);

export const actionVersions = pgTable(
  "action_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),
    actionId: uuid("action_id")
      .references(() => actions.id, { onDelete: "cascade" })
      .notNull(),

    actionVersionId: text("action_version_id").notNull().unique(),
    version: integer("version").notNull(),

    method: actionMethodEnum("method").notNull(),
    urlTemplate: text("url_template").notNull(),
    headers: jsonb("headers").notNull().default({}),
    bodyTemplate: jsonb("body_template"),
    inputSchema: jsonb("input_schema").notNull().default({}),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    adapter: jsonb("adapter").$type<ActionAdapterConfig | null>(),
    declarations: jsonb("declarations").$type<ActionDeclarations | null>(),
    mcp: jsonb("mcp").$type<ActionMcpBinding | null>(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    versionUnique: unique("action_versions_action_version_unique").on(table.actionId, table.version),
    actionIdx: index("idx_action_versions_action_id").on(table.actionId),
    environmentIdx: index("idx_action_versions_environment_id").on(table.environmentId),
  })
);

export const actionInvocations = pgTable(
  "action_invocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),
    actionId: uuid("action_id")
      .references(() => actions.id, { onDelete: "cascade" })
      .notNull(),

    invocationId: text("invocation_id").notNull().unique(),
    budgetReservationId: uuid("budget_reservation_id"),
    usageMonth: text("usage_month"),
    usageState: text("usage_state").$type<"reserved" | "billed" | "released">(),
    dispatchClaimedAt: timestamp("dispatch_claimed_at", { withTimezone: true }),

    status: actionInvocationStatusEnum("status").notNull().default("running"),

    input: jsonb("input").notNull().default({}),

    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    errorMessage: text("error_message"),

    approvalId: text("approval_id"),

    requestedByKeyId: uuid("requested_by_key_id"),

    definitionSnapshot: jsonb("definition_snapshot").$type<Record<string, unknown>>(),

    actionVersionId: text("action_version_id"),

    traceRunId: text("trace_run_id"),
    traceParentSpanId: text("trace_parent_span_id"),

    durationMs: integer("duration_ms"),

    decision: jsonb("decision").$type<Record<string, unknown>>(),

    idempotencyKey: text("idempotency_key"),
    idempotencyFingerprint: text("idempotency_fingerprint"),

    retryOfInvocationId: text("retry_of_invocation_id"),

    effectId: text("effect_id"),

    endUserId: text("end_user_id"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    wsCreatedIdx: index("action_invocations_ws_created_idx").on(
      table.workspaceId,
      table.environmentId,
      table.createdAt
    ),
    actionIdIdx: index("action_invocations_action_id_idx").on(table.actionId),
    invocationIdIdx: index("action_invocations_invocation_id_idx").on(table.invocationId),
    approvalIdIdx: index("action_invocations_approval_id_idx").on(table.approvalId),
    traceRunIdIdx: index("action_invocations_trace_run_id_idx").on(table.traceRunId),
    idempotencyUnique: uniqueIndex("action_invocations_idempotency_unique")
      .on(table.workspaceId, table.environmentId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    retryOfUnique: uniqueIndex("action_invocations_retry_of_unique")
      .on(table.retryOfInvocationId)
      .where(sql`retry_of_invocation_id IS NOT NULL`),
    endUserIdx: index("action_invocations_env_end_user_idx").on(table.environmentId, table.endUserId),
  })
);

export const invocationResolutions = pgTable(
  "invocation_resolutions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "cascade" }).notNull(),
    invocationId: uuid("invocation_id").references(() => actionInvocations.id, { onDelete: "cascade" }).notNull(),
    outcome: text("outcome").$type<"succeeded" | "failed">().notNull(),
    evidence: text("evidence").notNull(),
    externalReference: text("external_reference"),
    actorType: text("actor_type").$type<"api_key" | "user">().notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    invocationUnique: unique("invocation_resolutions_invocation_unique").on(table.invocationId),
    wsIdx: index("invocation_resolutions_ws_idx").on(table.workspaceId, table.environmentId),
  })
);

export type ActionVersion = typeof actionVersions.$inferSelect;
export type WorkspaceSecret = typeof workspaceSecrets.$inferSelect;
export type NewWorkspaceSecret = typeof workspaceSecrets.$inferInsert;
export type Action = typeof actions.$inferSelect;
export type NewAction = typeof actions.$inferInsert;
export type ActionInvocation = typeof actionInvocations.$inferSelect;
export type InvocationResolution = typeof invocationResolutions.$inferSelect;
export type NewActionInvocation = typeof actionInvocations.$inferInsert;
