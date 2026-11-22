import { pgTable, text, timestamp, uuid, jsonb, integer, index } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.ts";

export const messageExecutionLogs = pgTable("message_execution_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageId: text("message_id").notNull(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),

  attemptNumber: integer("attempt_number").notNull(),
  status: text("status").notNull(),

  requestUrl: text("request_url"),
  requestMethod: text("request_method"),
  requestHeaders: jsonb("request_headers"),
  requestBody: jsonb("request_body"),

  responseStatus: integer("response_status"),
  responseHeaders: jsonb("response_headers"),
  responseBody: text("response_body"),

  errorMessage: text("error_message"),
  errorCode: text("error_code"),

  duration: integer("duration"),
  timestamp: timestamp("timestamp").defaultNow().notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  messageIdIdx: index("idx_execution_logs_message_id").on(table.messageId),
  workspaceIdIdx: index("idx_execution_logs_workspace_id").on(table.workspaceId),
  timestampIdx: index("idx_execution_logs_timestamp").on(table.timestamp),
}));
