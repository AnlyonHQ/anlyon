import { pgTable, text, timestamp, uuid, integer, boolean, pgEnum, index, uniqueIndex } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.ts";
import { environments } from "./environments.ts";

export const queueStatusEnum = pgEnum("queue_status", [
  "active",
  "paused",
  "deleted",
]);

export const queues = pgTable("queues", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "cascade" }).notNull(),

  queueId: text("queue_id").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),

  parallelism: integer("parallelism").notNull().default(1),

  status: queueStatusEnum("status").notNull().default("active"),
  isPaused: boolean("is_paused").notNull().default(false),

  isSystem: boolean("is_system").notNull().default(false),

  messageCount: integer("message_count").default(0),
  pendingCount: integer("pending_count").default(0),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  wsEnvironmentNameUnique: uniqueIndex("queues_ws_environment_name_unique").on(table.workspaceId, table.environmentId, table.name),
  wsEnvironmentIdx: index("queues_ws_environment_idx").on(table.workspaceId, table.environmentId),
}));

export type Queue = typeof queues.$inferSelect;
export type NewQueue = typeof queues.$inferInsert;
