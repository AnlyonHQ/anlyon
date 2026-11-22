import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.ts";
import { environments } from "./environments.ts";
import { integrationConnections } from "./integrations.ts";
import { approvals } from "./approvals.ts";
import { user } from "./user.ts";

export const slackApprovalRoutes = pgTable(
  "slack_approval_routes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),
    integrationId: uuid("integration_id")
      .references(() => integrationConnections.id, { onDelete: "cascade" })
      .notNull(),
    channelId: text("channel_id").notNull(),
    channelName: text("channel_name").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("slack_approval_routes_environment_unique").on(table.environmentId),
    index("slack_approval_routes_workspace_idx").on(table.workspaceId),
  ],
);

export const slackApprovalMessages = pgTable(
  "slack_approval_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    approvalId: uuid("approval_id")
      .references(() => approvals.id, { onDelete: "cascade" })
      .notNull(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    integrationId: uuid("integration_id")
      .references(() => integrationConnections.id, { onDelete: "cascade" })
      .notNull(),
    slackTeamId: text("slack_team_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageTs: text("message_ts"),
    renderedDigest: text("rendered_digest"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("slack_approval_messages_approval_unique").on(table.approvalId),
    index("slack_approval_messages_lookup_idx").on(table.slackTeamId, table.channelId, table.messageTs),
  ],
);

export const slackUserLinks = pgTable(
  "slack_user_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    slackTeamId: text("slack_team_id").notNull(),
    slackUserId: text("slack_user_id").notNull(),
    userId: text("user_id")
      .references(() => user.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("slack_user_links_slack_user_unique").on(table.workspaceId, table.slackTeamId, table.slackUserId),
    uniqueIndex("slack_user_links_user_unique").on(table.workspaceId, table.slackTeamId, table.userId),
  ],
);

export const slackApprovalActions = pgTable(
  "slack_approval_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    approvalId: uuid("approval_id")
      .references(() => approvals.id, { onDelete: "cascade" })
      .notNull(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    slackTeamId: text("slack_team_id").notNull(),
    slackUserId: text("slack_user_id").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    identifiedBy: text("identified_by"),
    decision: text("decision").notNull(),
    result: text("result").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("slack_approval_actions_approval_idx").on(table.approvalId, table.createdAt)],
);

export type SlackApprovalRoute = typeof slackApprovalRoutes.$inferSelect;
export type SlackApprovalMessage = typeof slackApprovalMessages.$inferSelect;
export type SlackUserLink = typeof slackUserLinks.$inferSelect;
