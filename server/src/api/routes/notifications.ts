import { Hono, type Context } from "hono";
import { callerAuthority, requireApiKey, requireApiKeyScope, requirePermission } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody, validateQuery } from "../middleware/validation.ts";
import { z } from "zod";
import {
  getNotifications,
  getUnreadCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  getNotificationPreferences,
  updateNotificationPreferences,
  initializeNotificationPreferences,
  getNotificationUserPreferences,
  updateNotificationUserPreferences,
  toPublicNotification,
  toPublicNotificationPreferences,
} from "../../core/notifications/notification-service.ts";
import { sendTestWebhook } from "../../core/notifications/webhook-service.ts";
import { ApiError, AuthorizationError } from "../../utils/errors.ts";
import { validateUUID } from "../../utils/uuid-validator.ts";
import { pathParam } from "../params.ts";

const notificationsRouter = new Hono();

notificationsRouter.use("*", requireApiKey);
const NOTIFICATION_WRITE_SCOPES: readonly string[] = ["notifications:write", "notifications:manage"];
const requireNotificationsRead = requireApiKeyScope("notifications:read");

notificationsRouter.use("*", async (c, next) => {
  if (c.req.method === "GET") return requireNotificationsRead(c, next);
  const { scopes } = callerAuthority(c);
  if (scopes !== null && !scopes.some((scope) => NOTIFICATION_WRITE_SCOPES.includes(scope))) {
    throw new AuthorizationError(
      "This credential is missing a required scope: notifications:write or notifications:manage",
    );
  }
  await next();
});
notificationsRouter.use("*", rateLimitByWorkspace);

async function callerMutedTypes(c: Context) {
  const userId = c.get("userId") as string | undefined;
  if (!userId) return [];
  return (await getNotificationUserPreferences(c.get("workspaceId"), userId)).mutedTypes;
}

function requireUserId(c: Context): string {
  const userId = c.get("userId") as string | undefined;
  if (!userId) {
    throw new ApiError(
      403,
      "USER_IDENTITY_REQUIRED",
      "Your own notification preferences need a user. Use a console session or an OAuth connection. An API key has no user.",
    );
  }
  return userId;
}

const notificationTypeSchema = z.enum([
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

const notificationsQuerySchema = z.object({
  unreadOnly: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

notificationsRouter.get("/", validateQuery(notificationsQuerySchema), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const { unreadOnly, limit } = c.get("validatedQuery");
  const mutedTypes = await callerMutedTypes(c);

  const notifications = await getNotifications(workspaceId, {
    unreadOnly: unreadOnly === "true",
    limit,
    mutedTypes,
  });

  const unreadCount = await getUnreadCount(workspaceId, undefined, mutedTypes);

  return c.json({
    success: true,
    data: {
      notifications: notifications.map(toPublicNotification),
      unreadCount,
      total: notifications.length,
    },
  });
});

notificationsRouter.get("/unread-count", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const count = await getUnreadCount(workspaceId, undefined, await callerMutedTypes(c));

  return c.json({
    success: true,
    data: {
      count,
    },
  });
});

notificationsRouter.patch("/:id/read", requireApiKeyScope("notifications:write"), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const notificationId = validateUUID(pathParam(c, "id"), "Notification ID");

  await markNotificationAsRead(notificationId, workspaceId);

  return c.json({
    success: true,
    data: {
      message: "Notification marked as read",
    },
  });
});

notificationsRouter.patch("/read-all", requireApiKeyScope("notifications:write"), async (c: Context) => {
  const workspaceId = c.get("workspaceId");

  await markAllNotificationsAsRead(workspaceId);

  return c.json({
    success: true,
    data: {
      message: "All notifications marked as read",
    },
  });
});

notificationsRouter.delete("/:id", requireApiKeyScope("notifications:write"), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const notificationId = validateUUID(pathParam(c, "id"), "Notification ID");

  await deleteNotification(notificationId, workspaceId);

  return c.json({
    success: true,
    data: { message: "Notification dismissed" },
  });
});

notificationsRouter.get("/preferences", async (c: Context) => {
  const workspaceId = c.get("workspaceId");

  let prefs = await getNotificationPreferences(workspaceId);

  if (!prefs) {
    prefs = await initializeNotificationPreferences(workspaceId);
  }

  return c.json({
    success: true,
    data: toPublicNotificationPreferences(prefs),
  });
});

const updatePreferencesSchema = z.object({
  emailEnabled: z.boolean().optional(),
  webhookEnabled: z.boolean().optional(),
  inAppEnabled: z.boolean().optional(),
  slackEnabled: z.boolean().optional(),
  discordEnabled: z.boolean().optional(),
  emailRecipients: z.array(z.string().email()).max(50).optional(),
  webhookUrl: z.string().url().optional().nullable(),
  webhookSecret: z.string().max(4096).optional().nullable(),
  quotaAlertThresholds: z.array(z.number().int().min(0).max(100)).max(20).optional(),
  enabledTypes: z.array(notificationTypeSchema).max(notificationTypeSchema.options.length).optional(),
}).refine((body) => Object.keys(body).length > 0, {
  message: "At least one preference field is required",
});

notificationsRouter.patch(
  "/preferences",
  requireApiKeyScope("notifications:manage"),
  requirePermission("notifications.manage"),
  validateBody(updatePreferencesSchema),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const body = c.get("validatedBody");

    let prefs = await getNotificationPreferences(workspaceId);
    if (!prefs) {
      prefs = await initializeNotificationPreferences(workspaceId);
    }

    const updated = await updateNotificationPreferences(workspaceId, body as any);

    return c.json({
      success: true,
      data: toPublicNotificationPreferences(updated),
    });
  }
);

const testWebhookSchema = z.object({
  webhookUrl: z.string().url(),
  webhookSecret: z.string().optional(),
});

notificationsRouter.post(
  "/preferences/test-webhook",
  requireApiKeyScope("notifications:manage"),
  requirePermission("notifications.manage"),
  validateBody(testWebhookSchema),
  async (c: Context) => {
    const { webhookUrl, webhookSecret } = c.get("validatedBody");

    const success = await sendTestWebhook(webhookUrl, webhookSecret);

    if (!success) {
      throw new ApiError(400, "webhook_test_failed", "Webhook test failed. Please check your endpoint.");
    }

    return c.json({
      success: true,
      data: {
        message: "Test webhook sent successfully",
      },
    });
  }
);

notificationsRouter.get("/preferences/me", async (c: Context) => {
  const prefs = await getNotificationUserPreferences(c.get("workspaceId"), requireUserId(c));
  return c.json({ success: true, data: prefs });
});

const updateMyPreferencesSchema = z.object({
  mutedTypes: z.array(notificationTypeSchema).max(notificationTypeSchema.options.length),
});

notificationsRouter.patch(
  "/preferences/me",
  requireApiKeyScope("notifications:write"),
  validateBody(updateMyPreferencesSchema),
  async (c: Context) => {
    const { mutedTypes } = c.get("validatedBody");
    const prefs = await updateNotificationUserPreferences(c.get("workspaceId"), requireUserId(c), mutedTypes);
    return c.json({ success: true, data: prefs });
  }
);

export default notificationsRouter;
