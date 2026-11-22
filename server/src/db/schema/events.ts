import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.ts";
import { environments } from "./environments.ts";

export const eventStatusEnum = pgEnum("event_status", [
  "received",
  "fanned_out",
  "no_subscribers",
]);

export const eventTopics = pgTable(
  "event_topics",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),

    topicId: text("topic_id").notNull().unique(),

    name: text("name").notNull(),
    description: text("description"),

    isReserved: boolean("is_reserved").notNull().default(false),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    wsNameUnique: uniqueIndex("event_topics_ws_name_unique").on(
      table.workspaceId,
      table.environmentId,
      table.name
    ),
  })
);

export const eventSubscriptions = pgTable(
  "event_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),
    topicId: uuid("topic_id")
      .references(() => eventTopics.id, { onDelete: "cascade" })
      .notNull(),

    subscriptionId: text("subscription_id").notNull().unique(),

    url: text("url").notNull(),

    eventTypes: text("event_types").array().notNull().default(sql`'{*}'`),

    enabled: boolean("enabled").notNull().default(true),

    secretEncrypted: text("secret_encrypted"),

    headers: jsonb("headers"),

    deliveryFormat: text("delivery_format").$type<"anlyon" | "mcp">().notNull().default("anlyon"),
    expiresAt: timestamp("expires_at"),
    mcpEventName: text("mcp_event_name"),
    mcpPrincipal: text("mcp_principal"),
    mcpEnvironmentId: uuid("mcp_environment_id").references(() => environments.id, { onDelete: "cascade" }),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    topicIdx: index("event_subscriptions_topic_idx").on(table.topicId),
    wsIdx: index("event_subscriptions_ws_idx").on(table.workspaceId, table.environmentId),
  })
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),
    topicId: uuid("topic_id")
      .references(() => eventTopics.id, { onDelete: "cascade" })
      .notNull(),

    eventId: text("event_id").notNull().unique(),

    type: text("type").notNull(),
    data: jsonb("data").notNull().default({}),

    traceRunId: text("trace_run_id"),
    traceParentSpanId: text("trace_parent_span_id"),

    idempotencyKey: text("idempotency_key"),

    status: eventStatusEnum("status").notNull().default("received"),
    subscriptionCount: integer("subscription_count").notNull().default(0),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    wsCreatedIdx: index("events_ws_created_idx").on(table.workspaceId, table.environmentId, table.createdAt),
    topicIdx: index("events_topic_idx").on(table.topicId),
    traceRunIdIdx: index("events_trace_run_id_idx").on(table.traceRunId),
    idempotencyUnique: uniqueIndex("events_idempotency_unique")
      .on(table.workspaceId, table.environmentId, table.topicId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  })
);
