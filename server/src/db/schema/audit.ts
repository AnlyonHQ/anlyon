import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.ts";

export const auditEvents = pgTable(
  "audit_events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    txId: bigint("tx_id", { mode: "number" })
      .notNull()
      .default(sql`(pg_current_xact_id()::text)::bigint`),
    eventId: text("event_id").notNull().unique(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id"),
    type: text("type").notNull(),
    category: text("category").notNull(),
    outcome: text("outcome"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    backfilled: boolean("backfilled").notNull().default(false),
    context: jsonb("context").$type<Record<string, unknown>>(),
    endUserId: text("end_user_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    deliveryIdx: index("audit_events_delivery_idx").on(table.workspaceId, table.txId, table.seq),
    occurredIdx: index("audit_events_ws_occurred_idx").on(table.workspaceId, table.occurredAt),
    listIdx: index("audit_events_ws_seq_idx").on(table.workspaceId, table.seq.desc()),
    endUserIdx: index("audit_events_env_end_user_idx").on(table.environmentId, table.endUserId),
  })
);

export const auditSettings = pgTable("audit_settings", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  retentionDays: integer("retention_days"),
  allowPrivateDestinations: boolean("allow_private_destinations").notNull().default(false),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const auditSinks = pgTable(
  "audit_sinks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sinkId: text("sink_id").notNull().unique(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    type: text("type").$type<"webhook" | "s3" | "datadog" | "splunk">().notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    credentialsHint: text("credentials_hint"),
    enabled: boolean("enabled").notNull().default(true),
    eventTypes: text("event_types").array().notNull().default(sql`'{*}'`),
    environmentIds: uuid("environment_ids").array(),
    includeHistory: boolean("include_history").notNull().default(false),

    cursorTxId: bigint("cursor_tx_id", { mode: "number" }).notNull(),
    cursorSeq: bigint("cursor_seq", { mode: "number" }).notNull(),

    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: text("last_error"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    deliveredCount: bigint("delivered_count", { mode: "number" }).notNull().default(0),

    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    wsIdx: index("audit_sinks_ws_idx").on(table.workspaceId),
    dueIdx: index("audit_sinks_due_idx").on(table.enabled, table.nextAttemptAt),
  })
);

export const auditSinkDeadLetters = pgTable(
  "audit_sink_dead_letters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    sinkId: uuid("sink_id")
      .references(() => auditSinks.id, { onDelete: "cascade" })
      .notNull(),
    fromTxId: bigint("from_tx_id", { mode: "number" }).notNull(),
    fromSeq: bigint("from_seq", { mode: "number" }).notNull(),
    toTxId: bigint("to_tx_id", { mode: "number" }).notNull(),
    toSeq: bigint("to_seq", { mode: "number" }).notNull(),
    eventCount: integer("event_count").notNull(),
    firstEventId: text("first_event_id").notNull(),
    lastEventId: text("last_event_id").notNull(),
    attempts: integer("attempts").notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastRetryAt: timestamp("last_retry_at", { withTimezone: true }),
    redeliveredAt: timestamp("redelivered_at", { withTimezone: true }),
  },
  (table) => ({
    sinkIdx: index("audit_sink_dead_letters_sink_idx").on(table.sinkId, table.createdAt),
  })
);

export const auditArchives = pgTable(
  "audit_archives",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    environmentId: uuid("environment_id"),
    day: text("day").notNull(),
    objectKey: text("object_key").notNull().unique(),
    manifestKey: text("manifest_key").notNull(),
    recordCount: integer("record_count").notNull(),
    firstSeq: bigint("first_seq", { mode: "number" }).notNull(),
    lastSeq: bigint("last_seq", { mode: "number" }).notNull(),
    firstOccurredAt: timestamp("first_occurred_at", { withTimezone: true }).notNull(),
    lastOccurredAt: timestamp("last_occurred_at", { withTimezone: true }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    contentSha256: text("content_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
  },
  (table) => ({
    rangeIdx: index("audit_archives_ws_range_idx").on(table.workspaceId, table.lastOccurredAt),
  })
);

export const auditLifecycle = pgTable("audit_lifecycle", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  contractRetentionMonths: integer("contract_retention_months"),
  contractSetBy: text("contract_set_by"),
  planRetentionMonths: integer("plan_retention_months"),
  floorMonths: integer("floor_months"),
  floorUntil: timestamp("floor_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;
export type AuditSinkRow = typeof auditSinks.$inferSelect;
export type AuditDeadLetterRow = typeof auditSinkDeadLetters.$inferSelect;
export type AuditArchiveRow = typeof auditArchives.$inferSelect;
export type AuditLifecycleRow = typeof auditLifecycle.$inferSelect;
