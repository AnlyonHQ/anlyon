import { relations } from "drizzle-orm";
import { user } from "./user.ts";
import { session } from "./session.ts";
import { account } from "./account.ts";
import { workspaces, workspaceMembers, apiKeys, deliverySecrets } from "./workspaces.ts";
import { messages } from "./messages.ts";
import { usageLogs } from "./billing.ts";
import { notifications, notificationPreferences, notificationDeliveryLog, alertHistory } from "./notifications.ts";

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  workspaceMemberships: many(workspaceMembers, { relationName: "member" }),
  createdApiKeys: many(apiKeys),
  createdDeliverySecrets: many(deliverySecrets),
  notifications: many(notifications),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const workspaceRelations = relations(workspaces, ({ many }) => ({
  members: many(workspaceMembers),
  apiKeys: many(apiKeys),
  deliverySecrets: many(deliverySecrets),
  messages: many(messages),
  usageLogs: many(usageLogs),
  notifications: many(notifications),
  notificationPreferences: many(notificationPreferences),
  alertHistory: many(alertHistory),
}));

export const workspaceMemberRelations = relations(workspaceMembers, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMembers.workspaceId],
    references: [workspaces.id],
  }),
  user: one(user, {
    fields: [workspaceMembers.userId],
    references: [user.id],
    relationName: "member",
  }),
  inviter: one(user, {
    fields: [workspaceMembers.invitedBy],
    references: [user.id],
    relationName: "inviter",
  }),
}));

export const apiKeyRelations = relations(apiKeys, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [apiKeys.workspaceId],
    references: [workspaces.id],
  }),
  creator: one(user, {
    fields: [apiKeys.createdBy],
    references: [user.id],
  }),
}));

export const deliverySecretRelations = relations(deliverySecrets, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [deliverySecrets.workspaceId],
    references: [workspaces.id],
  }),
  creator: one(user, {
    fields: [deliverySecrets.createdBy],
    references: [user.id],
  }),
}));

export const messageRelations = relations(messages, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [messages.workspaceId],
    references: [workspaces.id],
  }),
}));

export const usageLogRelations = relations(usageLogs, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [usageLogs.workspaceId],
    references: [workspaces.id],
  }),
}));

export const notificationRelations = relations(notifications, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [notifications.workspaceId],
    references: [workspaces.id],
  }),
  user: one(user, {
    fields: [notifications.userId],
    references: [user.id],
  }),
}));

export const notificationPreferencesRelations = relations(notificationPreferences, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [notificationPreferences.workspaceId],
    references: [workspaces.id],
  }),
}));

export const notificationDeliveryLogRelations = relations(notificationDeliveryLog, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [notificationDeliveryLog.workspaceId],
    references: [workspaces.id],
  }),
  notification: one(notifications, {
    fields: [notificationDeliveryLog.notificationId],
    references: [notifications.id],
  }),
}));

export const alertHistoryRelations = relations(alertHistory, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [alertHistory.workspaceId],
    references: [workspaces.id],
  }),
}));