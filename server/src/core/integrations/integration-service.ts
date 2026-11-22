import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import {
  integrationConnections,
  type IntegrationConnection,
} from "../../db/schema/integrations.ts";
import type { notifications } from "../../db/schema/notifications.ts";
import { logger } from "../../lib/logger.ts";
import { env } from "../../config/env.ts";
import { decryptIntegrationToken } from "../../utils/crypto.ts";
import { sendDiscordNotification } from "./discord-service.ts";
import { sendSlackNotification } from "./slack-service.ts";

export async function getWorkspaceIntegrations(
  workspaceId: string
): Promise<IntegrationConnection[]> {
  return db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.workspaceId, workspaceId),
        eq(integrationConnections.isActive, true)
      )
    );
}

export async function getIntegrationsByType(
  workspaceId: string,
  type: "slack" | "discord"
): Promise<IntegrationConnection[]> {
  return db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.workspaceId, workspaceId),
        eq(integrationConnections.type, type),
        eq(integrationConnections.isActive, true)
      )
    );
}

function isEventTypeEnabled(
  integration: IntegrationConnection,
  notificationType: string
): boolean {
  const enabledTypes = integration.enabledEventTypes as string[];
  return Array.isArray(enabledTypes) && enabledTypes.includes(notificationType);
}

async function updateIntegrationLastUsed(integrationId: string): Promise<void> {
  await db
    .update(integrationConnections)
    .set({
      lastUsedAt: new Date(),
      lastError: null,
      errorCount: 0,
      updatedAt: new Date(),
    })
    .where(eq(integrationConnections.id, integrationId));
}

async function recordIntegrationError(
  integrationId: string,
  error: Error
): Promise<void> {
  const integration = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, integrationId))
    .then((rows) => rows[0]);

  if (integration) {
    await db
      .update(integrationConnections)
      .set({
        lastError: error.message,
        errorCount: integration.errorCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(integrationConnections.id, integrationId));
  }
}

async function interactiveApprovalChannel(
  notification: typeof notifications.$inferSelect
): Promise<{ integrationId: string; channelId: string } | null> {
  if (notification.type !== "approval_requested") return null;
  const approvalId = (notification.metadata as Record<string, unknown> | null)?.approvalId;
  if (typeof approvalId !== "string") return null;
  try {
    const { slackApprovalChannelFor } = await import("../slack-approvals/service.ts");
    return await slackApprovalChannelFor(notification.workspaceId, approvalId);
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : "Unknown error" },
      "Slack approvals channel lookup failed; notifying every channel"
    );
    return null;
  }
}

export async function sendToSlackIntegrations(
  notification: typeof notifications.$inferSelect
): Promise<{ sent: number; failed: number }> {
  const integrations = await getIntegrationsByType(
    notification.workspaceId,
    "slack"
  );

  let sent = 0;
  let failed = 0;

  const interactive = await interactiveApprovalChannel(notification);

  for (const integration of integrations) {
    if (!isEventTypeEnabled(integration, notification.type)) {
      logger.debug(
        {
          integrationId: integration.id,
          notificationType: notification.type,
        },
        "Skipping Slack integration - event type not enabled"
      );
      continue;
    }

    if (
      interactive &&
      interactive.integrationId === integration.id &&
      interactive.channelId === integration.slackChannelId
    ) {
      logger.debug(
        { integrationId: integration.id },
        "Skipping Slack integration - the approval is posted there with buttons"
      );
      continue;
    }

    if (
      !integration.slackAccessTokenEncrypted ||
      !integration.slackChannelId
    ) {
      logger.warn(
        {
          integrationId: integration.id,
        },
        "Skipping Slack integration - missing token or channel"
      );
      continue;
    }

    try {
      const encryptionKey = env.INTEGRATION_ENCRYPTION_KEY;
      if (!encryptionKey) {
        throw new Error("INTEGRATION_ENCRYPTION_KEY is not configured");
      }

      const accessToken = decryptIntegrationToken(
        integration.slackAccessTokenEncrypted,
        encryptionKey,
        integration.workspaceId
      );

      await sendSlackNotification(
        accessToken,
        integration.slackChannelId,
        notification
      );

      await updateIntegrationLastUsed(integration.id);
      sent++;
    } catch (error) {
      logger.error(
        {
          integrationId: integration.id,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to send to Slack integration"
      );
      await recordIntegrationError(
        integration.id,
        error instanceof Error ? error : new Error("Unknown error")
      );
      failed++;
    }
  }

  return { sent, failed };
}

export async function sendToDiscordIntegrations(
  notification: typeof notifications.$inferSelect
): Promise<{ sent: number; failed: number }> {
  const integrations = await getIntegrationsByType(
    notification.workspaceId,
    "discord"
  );

  let sent = 0;
  let failed = 0;

  for (const integration of integrations) {
    if (!isEventTypeEnabled(integration, notification.type)) {
      logger.debug(
        {
          integrationId: integration.id,
          notificationType: notification.type,
        },
        "Skipping Discord integration - event type not enabled"
      );
      continue;
    }

    if (!integration.discordWebhookUrlEncrypted) {
      logger.warn(
        {
          integrationId: integration.id,
        },
        "Skipping Discord integration - missing webhook URL"
      );
      continue;
    }

    try {
      const encryptionKey = env.INTEGRATION_ENCRYPTION_KEY;
      if (!encryptionKey) {
        throw new Error("INTEGRATION_ENCRYPTION_KEY is not configured");
      }

      const webhookUrl = decryptIntegrationToken(
        integration.discordWebhookUrlEncrypted,
        encryptionKey,
        integration.workspaceId
      );

      await sendDiscordNotification(webhookUrl, notification);

      await updateIntegrationLastUsed(integration.id);
      sent++;
    } catch (error) {
      logger.error(
        {
          integrationId: integration.id,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to send to Discord integration"
      );
      await recordIntegrationError(
        integration.id,
        error instanceof Error ? error : new Error("Unknown error")
      );
      failed++;
    }
  }

  return { sent, failed };
}

export async function sendToAllIntegrations(
  notification: typeof notifications.$inferSelect
): Promise<{ slack: { sent: number; failed: number }; discord: { sent: number; failed: number } }> {
  const [slackResults, discordResults] = await Promise.all([
    sendToSlackIntegrations(notification),
    sendToDiscordIntegrations(notification),
  ]);

  logger.info(
    {
      notificationId: notification.id,
      notificationType: notification.type,
      slack: slackResults,
      discord: discordResults,
    },
    "Sent notification to integrations"
  );

  return {
    slack: slackResults,
    discord: discordResults,
  };
}

export async function hasActiveIntegrations(
  workspaceId: string
): Promise<boolean> {
  const integrations = await getWorkspaceIntegrations(workspaceId);
  return integrations.length > 0;
}

export async function getIntegrationById(
  integrationId: string
): Promise<IntegrationConnection | null> {
  const result = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, integrationId));
  return result[0] || null;
}

export async function deleteIntegration(integrationId: string): Promise<void> {
  await db
    .delete(integrationConnections)
    .where(eq(integrationConnections.id, integrationId));
}

export async function toggleIntegration(
  integrationId: string,
  isActive: boolean
): Promise<void> {
  await db
    .update(integrationConnections)
    .set({
      isActive,
      updatedAt: new Date(),
    })
    .where(eq(integrationConnections.id, integrationId));
}

export async function updateIntegrationEventTypes(
  integrationId: string,
  enabledEventTypes: string[]
): Promise<void> {
  await db
    .update(integrationConnections)
    .set({
      enabledEventTypes,
      updatedAt: new Date(),
    })
    .where(eq(integrationConnections.id, integrationId));
}
