import { pgTable, text, timestamp, uuid, pgEnum, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.ts";
import { user } from "./user.ts";

export const notificationTypeEnum = pgEnum("notification_type", [
  "quota_warning",
  "quota_exceeded",
  "payment_failed",
  "plan_upgraded",
  "plan_downgraded",
  "feature_enabled",
  "system_alert",
  "security_alert",
  "delivery_failure_spike",
  "api_key_expiring",
  "approval_requested",
  "budget_alert",
  "approval_expired",
  "outcome_unknown",
  "connection_broken",
]);

export const notificationChannelEnum = pgEnum("notification_channel", [
  "email",
  "webhook",
  "in_app",
  "slack",
  "discord",
]);

export const notificationPriorityEnum = pgEnum("notification_priority", [
  "low",
  "medium",
  "high",
  "critical",
]);

export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" })
    .notNull(),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),

  type: notificationTypeEnum("type").notNull(),
  priority: notificationPriorityEnum("priority").notNull().default("medium"),
  title: text("title").notNull(),
  message: text("message").notNull(),
  metadata: jsonb("metadata"),

  actionUrl: text("action_url"),
  actionLabel: text("action_label"),

  isRead: boolean("is_read").default(false).notNull(),
  readAt: timestamp("read_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
}, (table) => [
  index("idx_notifications_workspace_id").on(table.workspaceId),
  index("idx_notifications_user_id").on(table.userId),
  index("idx_notifications_unread").on(table.workspaceId, table.isRead),
]);

export const notificationPreferences = pgTable("notification_preferences", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" })
    .notNull()
    .unique(),

  emailEnabled: boolean("email_enabled").default(true).notNull(),
  webhookEnabled: boolean("webhook_enabled").default(false).notNull(),
  inAppEnabled: boolean("in_app_enabled").default(true).notNull(),
  slackEnabled: boolean("slack_enabled").default(false).notNull(),
  discordEnabled: boolean("discord_enabled").default(false).notNull(),

  emailRecipients: jsonb("email_recipients").default([]),

  webhookUrl: text("webhook_url"),
  webhookSecret: text("webhook_secret"),

  quotaAlertThresholds: jsonb("quota_alert_thresholds").default([50, 75, 90, 100]),

  enabledTypes: jsonb("enabled_types").default([
    "quota_warning",
    "quota_exceeded",
    "payment_failed",
    "security_alert",
    "approval_requested",
    "budget_alert",
    "approval_expired",
    "outcome_unknown",
    "connection_broken",
  ]),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const notificationUserPreferences = pgTable("notification_user_preferences", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" })
    .notNull(),
  userId: text("user_id")
    .references(() => user.id, { onDelete: "cascade" })
    .notNull(),
  mutedTypes: jsonb("muted_types").$type<string[]>().default([]).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("notification_user_preferences_ws_user_unique").on(table.workspaceId, table.userId),
]);

export const notificationDeliveryLog = pgTable("notification_delivery_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" })
    .notNull(),
  notificationId: uuid("notification_id").references(() => notifications.id, {
    onDelete: "set null",
  }),

  type: notificationTypeEnum("type").notNull(),
  channel: notificationChannelEnum("channel").notNull(),
  recipient: text("recipient").notNull(),

  status: text("status").notNull(),
  errorMessage: text("error_message"),
  retryCount: text("retry_count").default("0"),

  payload: jsonb("payload"),

  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const alertHistory = pgTable("alert_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" })
    .notNull(),

  alertType: text("alert_type").notNull(),
  alertKey: text("alert_key").notNull(),

  metadata: jsonb("metadata"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
});
