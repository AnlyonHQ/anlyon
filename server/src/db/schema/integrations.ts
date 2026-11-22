import {
  pgTable,
  text,
  timestamp,
  uuid,
  pgEnum,
  boolean,
  jsonb,
  index,
  integer,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.ts";
import { user } from "./user.ts";

export const integrationTypeEnum = pgEnum("integration_type", [
  "slack",
  "discord",
]);

export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),

    type: integrationTypeEnum("type").notNull(),

    name: text("name").notNull(),

    isActive: boolean("is_active").default(true).notNull(),

    slackTeamId: text("slack_team_id"),
    slackTeamName: text("slack_team_name"),
    slackChannelId: text("slack_channel_id"),
    slackChannelName: text("slack_channel_name"),
    slackAccessTokenEncrypted: text("slack_access_token_encrypted"),
    slackBotUserId: text("slack_bot_user_id"),

    discordWebhookUrlEncrypted: text("discord_webhook_url_encrypted"),
    discordServerId: text("discord_server_id"),
    discordChannelName: text("discord_channel_name"),

    enabledEventTypes: jsonb("enabled_event_types")
      .default([
        "quota_warning",
        "quota_exceeded",
        "payment_failed",
        "security_alert",
      ])
      .notNull(),

    lastUsedAt: timestamp("last_used_at"),
    lastError: text("last_error"),
    errorCount: integer("error_count").default(0).notNull(),

    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_integration_connections_workspace").on(table.workspaceId),
    index("idx_integration_connections_type").on(table.workspaceId, table.type),
    index("idx_integration_connections_active").on(
      table.workspaceId,
      table.isActive
    ),
  ]
);

export const oauthStates = pgTable(
  "oauth_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => user.id, { onDelete: "cascade" })
      .notNull(),

    provider: text("provider").notNull(),

    state: text("state").notNull().unique(),

    redirectUrl: text("redirect_url"),

    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_oauth_states_state").on(table.state),
    index("idx_oauth_states_expires").on(table.expiresAt),
  ]
);

export type IntegrationConnection = typeof integrationConnections.$inferSelect;
export type NewIntegrationConnection = typeof integrationConnections.$inferInsert;
export type OAuthState = typeof oauthStates.$inferSelect;
export type NewOAuthState = typeof oauthStates.$inferInsert;
