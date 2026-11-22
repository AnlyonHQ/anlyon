import { pgTable, text, timestamp, uuid, jsonb, integer, pgEnum, index, uniqueIndex } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.ts";
import { queues } from "./queues.ts";
import { environments } from "./environments.ts";

export const messageStatusEnum = pgEnum("message_status", [
  "pending",
  "scheduled",
  "processing",
  "delivered",
  "failed",
  "cancelled",
]);

export const httpMethodEnum = pgEnum("http_method", [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "cascade" }).notNull(),
  queueId: uuid("queue_id").references(() => queues.id, { onDelete: "set null" }),

  messageId: text("message_id").notNull().unique(),
  contentHash: text("content_hash"),

  url: text("url").notNull(),
  method: httpMethodEnum("method").notNull().default("POST"),

  headers: jsonb("headers"),
  body: jsonb("body"),

  scheduledFor: timestamp("scheduled_for"),

  status: messageStatusEnum("status").notNull().default("pending"),
  attempts: integer("attempts").default(0),
  maxRetries: integer("max_retries").default(3),

  responseStatus: integer("response_status"),
  responseBody: text("response_body"),
  errorMessage: text("error_message"),

  deliveredAt: timestamp("delivered_at"),
  failedAt: timestamp("failed_at"),

  callbackUrl: text("callback_url"),
  failureCallbackUrl: text("failure_callback_url"),

  eventId: uuid("event_id"),
  eventSubscriptionId: uuid("event_subscription_id"),

  traceRunId: text("trace_run_id"),
  traceParentSpanId: text("trace_parent_span_id"),
  traceStartedAt: timestamp("trace_started_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("messages_ws_environment_created_idx").on(table.workspaceId, table.environmentId, table.createdAt),
  index("messages_event_id_idx").on(table.eventId),
  index("messages_trace_run_id_idx").on(table.traceRunId),
]);

export const messageEnqueueOutbox = pgTable("message_enqueue_outbox", {
  messageId: text("message_id").primaryKey().references(() => messages.messageId, { onDelete: "cascade" }),
  commands: jsonb("commands").$type<Array<Array<string | number>>>().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [index("message_enqueue_outbox_created_idx").on(table.createdAt)]);

export const archivalTracking = pgTable("archival_tracking", {
  id: uuid("id").defaultRandom().primaryKey(),
  partitionName: text("partition_name").notNull(),
  logType: text("log_type").notNull(),
  partitionDate: timestamp("partition_date").notNull(),
  status: text("status").notNull().default("pending"),
  totalRecords: integer("total_records"),
  archivedRecords: integer("archived_records").default(0),
  r2ManifestKeys: jsonb("r2_manifest_keys"),
  archivalStartedAt: timestamp("archival_started_at"),
  archivalCompletedAt: timestamp("archival_completed_at"),
  partitionDroppedAt: timestamp("partition_dropped_at"),
  lastError: text("last_error"),
  retryCount: integer("retry_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  partitionNameIdx: index("idx_archival_partition_name").on(table.partitionName),
  statusIdx: index("idx_archival_status").on(table.status),
  partitionDateIdx: index("idx_archival_partition_date").on(table.partitionDate),
  partitionUniqueIdx: uniqueIndex("idx_archival_partition_unique").on(table.partitionName, table.logType),
}));
