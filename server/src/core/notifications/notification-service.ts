import { db } from "../../db/index.ts";
import {
  notifications,
  notificationPreferences,
  notificationUserPreferences,
  notificationDeliveryLog,
  alertHistory,
} from "../../db/schema/notifications.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { eq, and, desc, gte, notInArray } from "drizzle-orm";
import { logger } from "../../lib/logger.ts";
import { decryptSecret, encryptSecret, secretEnvelopeVersion } from "../../utils/crypto.ts";
import { env } from "../../config/env.ts";
import { ApiError, NotFoundError } from "../../utils/errors.ts";
import {
  sendToSlackIntegrations,
  sendToDiscordIntegrations,
} from "../integrations/integration-service.ts";

export type NotificationType =
  | "quota_warning"
  | "quota_exceeded"
  | "payment_failed"
  | "plan_upgraded"
  | "plan_downgraded"
  | "feature_enabled"
  | "system_alert"
  | "security_alert"
  | "delivery_failure_spike"
  | "api_key_expiring"
  | "approval_requested"
  | "budget_alert"
  | "approval_expired"
  | "outcome_unknown"
  | "connection_broken";

export type NotificationChannel = "email" | "webhook" | "in_app" | "slack" | "discord";

export type NotificationPriority = "low" | "medium" | "high" | "critical";

export interface CreateNotificationInput {
  workspaceId: string;
  userId?: string;
  type: NotificationType;
  priority?: NotificationPriority;
  title: string;
  message: string;
  metadata?: Record<string, any>;
  actionUrl?: string;
  actionLabel?: string;
  expiresAt?: Date;
}

export interface NotificationDeliveryOptions {
  channels?: NotificationChannel[];
  forceDelivery?: boolean;
}

export function toPublicNotificationPreferences(
  prefs: typeof notificationPreferences.$inferSelect
) {
  return {
    emailEnabled: prefs.emailEnabled,
    webhookEnabled: prefs.webhookEnabled,
    inAppEnabled: prefs.inAppEnabled,
    slackEnabled: prefs.slackEnabled,
    discordEnabled: prefs.discordEnabled,
    emailRecipients: prefs.emailRecipients,
    webhookUrl: prefs.webhookUrl,
    hasWebhookSecret: Boolean(prefs.webhookSecret),
    quotaAlertThresholds: prefs.quotaAlertThresholds,
    enabledTypes: prefs.enabledTypes,
    createdAt: prefs.createdAt,
    updatedAt: prefs.updatedAt,
  };
}

export function toPublicNotification(notification: typeof notifications.$inferSelect) {
  return {
    id: notification.id,
    type: notification.type,
    priority: notification.priority,
    title: notification.title,
    message: notification.message,
    metadata: notification.metadata,
    actionUrl: notification.actionUrl,
    actionLabel: notification.actionLabel,
    isRead: notification.isRead,
    readAt: notification.readAt,
    createdAt: notification.createdAt,
    expiresAt: notification.expiresAt,
  };
}

export async function createNotification(
  input: CreateNotificationInput
): Promise<typeof notifications.$inferSelect> {
  const notification = await db
    .insert(notifications)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      type: input.type,
      priority: input.priority || "medium",
      title: input.title,
      message: input.message,
      metadata: input.metadata as any,
      actionUrl: input.actionUrl,
      actionLabel: input.actionLabel,
      expiresAt: input.expiresAt,
    })
    .returning();
  return notification[0];
}

export async function sendNotification(
  notification: typeof notifications.$inferSelect,
  options: NotificationDeliveryOptions = {}
): Promise<void> {
  const { workspaceId, type } = notification;

  let [prefs] = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.workspaceId, workspaceId));

  if (!prefs) {
    try {
      prefs = await initializeNotificationPreferences(workspaceId);
    } catch (error) {
      logger.warn({ workspaceId, error }, "Failed to initialize notification preferences");
      if (!options.forceDelivery) return;
    }
  }

  const channels = options.channels || getEnabledChannels(prefs);

  const enabledTypes = (prefs?.enabledTypes as string[]) || [];
  if (!options.forceDelivery && !enabledTypes.includes(type)) {
    return;
  }

  const deliveryPromises = channels.map((channel) =>
    deliverNotification(notification, channel, prefs)
  );

  await Promise.allSettled(deliveryPromises);
}

export async function createAndSendNotification(
  input: CreateNotificationInput,
  options: NotificationDeliveryOptions = {}
): Promise<typeof notifications.$inferSelect> {
  const notification = await createNotification(input);
  await sendNotification(notification, options);
  return notification;
}

function getEnabledChannels(
  prefs: typeof notificationPreferences.$inferSelect | undefined
): NotificationChannel[] {
  const channels: NotificationChannel[] = [];

  if (prefs?.emailEnabled) channels.push("email");
  if (prefs?.webhookEnabled && prefs.webhookUrl) channels.push("webhook");
  if (prefs?.inAppEnabled) channels.push("in_app");
  if (prefs?.slackEnabled) channels.push("slack");
  if (prefs?.discordEnabled) channels.push("discord");

  return channels;
}

async function deliverNotification(
  notification: typeof notifications.$inferSelect,
  channel: NotificationChannel,
  prefs: typeof notificationPreferences.$inferSelect | undefined
): Promise<void> {
  const deliveryLog: typeof notificationDeliveryLog.$inferInsert = {
    workspaceId: notification.workspaceId,
    notificationId: notification.id,
    type: notification.type,
    channel,
    recipient: "",
    status: "pending",
    payload: notification as any,
    sentAt: null,
    errorMessage: null,
    retryCount: "0",
  };

  try {
    switch (channel) {
      case "in_app":
        deliveryLog.recipient = notification.userId || "workspace";
        deliveryLog.status = "sent";
        break;

      case "email":
        if (prefs?.emailRecipients) {
          const recipients = prefs.emailRecipients as string[];
          await sendEmailNotification(notification, recipients);
          deliveryLog.recipient = recipients.join(", ");
          deliveryLog.status = "sent";
        }
        break;

      case "webhook":
        if (prefs?.webhookUrl) {
          await sendWebhookNotification(
            notification,
            prefs.webhookUrl,
            webhookSecretOf(prefs)
          );
          deliveryLog.recipient = prefs.webhookUrl;
          deliveryLog.status = "sent";
        }
        break;

      case "slack": {
        const slackResults = await sendToSlackIntegrations(notification);
        deliveryLog.recipient = `slack_integrations:${slackResults.sent}`;
        deliveryLog.status = slackResults.sent > 0 ? "sent" : (slackResults.failed > 0 ? "failed" : "sent");
        if (slackResults.failed > 0) {
          deliveryLog.errorMessage = `${slackResults.failed} Slack integration(s) failed`;
        }
        break;
      }

      case "discord": {
        const discordResults = await sendToDiscordIntegrations(notification);
        deliveryLog.recipient = `discord_integrations:${discordResults.sent}`;
        deliveryLog.status = discordResults.sent > 0 ? "sent" : (discordResults.failed > 0 ? "failed" : "sent");
        if (discordResults.failed > 0) {
          deliveryLog.errorMessage = `${discordResults.failed} Discord integration(s) failed`;
        }
        break;
      }
    }

    deliveryLog.sentAt = new Date();
  } catch (error) {
    deliveryLog.status = "failed";
    deliveryLog.errorMessage = error instanceof Error ? error.message : "Unknown error";

    logger.error(
      {
        notificationId: notification.id,
        channel,
        error,
      },
      "Notification delivery failed"
    );
  }

  await db.insert(notificationDeliveryLog).values(deliveryLog as any);
}

async function sendEmailNotification(
  notification: typeof notifications.$inferSelect,
  recipients: string[]
): Promise<void> {
  const { sendEmailNotification: sendEmail } = await import("./email-service.ts");
  await sendEmail(notification, recipients);
}

async function sendWebhookNotification(
  notification: typeof notifications.$inferSelect,
  webhookUrl: string,
  secret?: string
): Promise<void> {
  const { sendWebhookNotification: sendWebhook } = await import("./webhook-service.ts");
  await sendWebhook(notification, webhookUrl, secret);
}

export async function markNotificationAsRead(
  notificationId: string,
  workspaceId: string
): Promise<void> {
  const result = await db
    .update(notifications)
    .set({
      isRead: true,
      readAt: new Date(),
    })
    .where(
      and(eq(notifications.id, notificationId), eq(notifications.workspaceId, workspaceId))
    )
    .returning({ id: notifications.id });

  if (result.length === 0) {
    throw new NotFoundError("Notification");
  }

  logger.debug({ notificationId, workspaceId }, "Notification marked as read");
}

export async function deleteNotification(
  notificationId: string,
  workspaceId: string
): Promise<void> {
  const result = await db
    .delete(notifications)
    .where(
      and(eq(notifications.id, notificationId), eq(notifications.workspaceId, workspaceId))
    )
    .returning({ id: notifications.id });

  if (result.length === 0) {
    throw new NotFoundError("Notification not found");
  }

  logger.debug({ notificationId, workspaceId }, "Notification dismissed");
}

export async function markAllNotificationsAsRead(workspaceId: string): Promise<void> {
  await db
    .update(notifications)
    .set({
      isRead: true,
      readAt: new Date(),
    })
    .where(
      and(eq(notifications.workspaceId, workspaceId), eq(notifications.isRead, false))
    );

  logger.debug({ workspaceId }, "All notifications marked as read");
}

export async function getNotifications(
  workspaceId: string,
  options: {
    userId?: string;
    unreadOnly?: boolean;
    limit?: number;
    mutedTypes?: readonly NotificationType[];
  } = {}
): Promise<typeof notifications.$inferSelect[]> {
  const { userId, unreadOnly = false, limit = 50, mutedTypes = [] } = options;

  const conditions = [eq(notifications.workspaceId, workspaceId)];

  if (userId) {
    conditions.push(eq(notifications.userId, userId));
  }

  if (mutedTypes.length > 0) {
    conditions.push(notInArray(notifications.type, [...mutedTypes]));
  }

  if (unreadOnly) {
    conditions.push(eq(notifications.isRead, false));
  }

  return db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export async function getUnreadCount(
  workspaceId: string,
  userId?: string,
  mutedTypes: readonly NotificationType[] = []
): Promise<number> {
  const conditions = [
    eq(notifications.workspaceId, workspaceId),
    eq(notifications.isRead, false),
  ];

  if (userId) {
    conditions.push(eq(notifications.userId, userId));
  }

  if (mutedTypes.length > 0) {
    conditions.push(notInArray(notifications.type, [...mutedTypes]));
  }

  const result = await db
    .select()
    .from(notifications)
    .where(and(...conditions));

  return result.length;
}

export async function wasAlertRecentlySent(
  workspaceId: string,
  alertType: string,
  windowHours: number = 24
): Promise<boolean> {
  const cutoffTime = new Date();
  cutoffTime.setHours(cutoffTime.getHours() - windowHours);

  const alertKey = `${workspaceId}:${alertType}`;

  const [recentAlert] = await db
    .select()
    .from(alertHistory)
    .where(
      and(
        eq(alertHistory.workspaceId, workspaceId),
        eq(alertHistory.alertKey, alertKey),
        gte(alertHistory.createdAt, cutoffTime)
      )
    )
    .limit(1);

  return !!recentAlert;
}

export async function recordAlertSent(
  workspaceId: string,
  alertType: string,
  metadata?: Record<string, any>,
  expiresInHours: number = 24
): Promise<void> {
  const alertKey = `${workspaceId}:${alertType}`;
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + expiresInHours);

  await db.insert(alertHistory).values({
    workspaceId,
    alertType,
    alertKey,
    metadata: metadata as any,
    expiresAt,
  });

  logger.debug({ workspaceId, alertType, alertKey }, "Alert recorded");
}

export async function initializeNotificationPreferences(
  workspaceId: string,
  emailRecipients: string[] = []
): Promise<typeof notificationPreferences.$inferSelect> {
  const [prefs] = await db
    .insert(notificationPreferences)
    .values({
      workspaceId,
      emailRecipients: emailRecipients as any,
    })
    .onConflictDoNothing()
    .returning();

  if (prefs) return prefs;

  const existing = await getNotificationPreferences(workspaceId);
  if (!existing) {
    throw new ApiError(500, "preferences_initialization_failed", "Failed to initialize notification preferences");
  }
  return existing;
}

function encryptWebhookSecret(workspaceId: string, secret: string): string {
  return encryptSecret(secret, env.DELIVERY_SECRET_MASTER_KEY, { store: "notification-webhook", workspaceId, name: "webhook_secret" });
}

export function webhookSecretOf(prefs: { workspaceId: string; webhookSecret: string | null }): string | undefined {
  if (!prefs.webhookSecret) return undefined;
  if (secretEnvelopeVersion(prefs.webhookSecret) !== "v3") return prefs.webhookSecret;
  try {
    return decryptSecret(prefs.webhookSecret, env.DELIVERY_SECRET_MASTER_KEY, { store: "notification-webhook", workspaceId: prefs.workspaceId, name: "webhook_secret" });
  } catch (error) {
    logger.error({ workspaceId: prefs.workspaceId, error }, "Notification webhook secret could not be decrypted; deliveries go unsigned until it is set again");
    return undefined;
  }
}

export async function updateNotificationPreferences(
  workspaceId: string,
  updates: Partial<typeof notificationPreferences.$inferInsert>
): Promise<typeof notificationPreferences.$inferSelect> {
  const [updated] = await db
    .update(notificationPreferences)
    .set({
      ...updates,
      ...(typeof updates.webhookSecret === "string" && updates.webhookSecret.length > 0
        ? { webhookSecret: encryptWebhookSecret(workspaceId, updates.webhookSecret) }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(notificationPreferences.workspaceId, workspaceId))
    .returning();

  if (!updated) {
    throw new NotFoundError("Notification preferences");
  }

  logger.info({ workspaceId }, "Notification preferences updated");

  return updated;
}

export async function getNotificationUserPreferences(
  workspaceId: string,
  userId: string
): Promise<{ mutedTypes: NotificationType[]; updatedAt: Date | null }> {
  const [row] = await db
    .select({
      mutedTypes: notificationUserPreferences.mutedTypes,
      updatedAt: notificationUserPreferences.updatedAt,
    })
    .from(notificationUserPreferences)
    .where(
      and(
        eq(notificationUserPreferences.workspaceId, workspaceId),
        eq(notificationUserPreferences.userId, userId)
      )
    );

  return { mutedTypes: (row?.mutedTypes ?? []) as NotificationType[], updatedAt: row?.updatedAt ?? null };
}

export async function updateNotificationUserPreferences(
  workspaceId: string,
  userId: string,
  mutedTypes: readonly NotificationType[]
): Promise<{ mutedTypes: NotificationType[]; updatedAt: Date | null }> {
  const unique = [...new Set(mutedTypes)];
  const [row] = await db
    .insert(notificationUserPreferences)
    .values({ workspaceId, userId, mutedTypes: unique })
    .onConflictDoUpdate({
      target: [notificationUserPreferences.workspaceId, notificationUserPreferences.userId],
      set: { mutedTypes: unique, updatedAt: new Date() },
    })
    .returning({
      mutedTypes: notificationUserPreferences.mutedTypes,
      updatedAt: notificationUserPreferences.updatedAt,
    });

  logger.info({ workspaceId, userId }, "Member notification preferences updated");

  return { mutedTypes: row.mutedTypes as NotificationType[], updatedAt: row.updatedAt };
}

export async function getNotificationPreferences(
  workspaceId: string
): Promise<typeof notificationPreferences.$inferSelect | undefined> {
  const [prefs] = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.workspaceId, workspaceId));

  return prefs;
}
