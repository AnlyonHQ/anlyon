import { logger } from "../../lib/logger.ts";
import { safeFetch } from "../../lib/safe-http.ts";
import type { notifications } from "../../db/schema/notifications.ts";
import { adviceSummary } from "../assistant/notification-text.ts";
import { absoluteActionUrl } from "../notifications/console-link.ts";

const DISCORD_WEBHOOK_REGEX =
  /^https:\/\/discord\.com\/api\/webhooks\/\d+\/[\w-]+$/;

const PRIORITY_COLORS: Record<string, number> = {
  low: 0x6b7280,
  medium: 0x3b82f6,
  high: 0xf59e0b,
  critical: 0xef4444,
};

const PRIORITY_EMOJIS: Record<string, string> = {
  low: "ℹ️",
  medium: "⚠️",
  high: "❗",
  critical: "🚨",
};

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string; icon_url?: string };
  timestamp?: string;
}

interface DiscordWebhookPayload {
  content?: string;
  embeds: DiscordEmbed[];
  username?: string;
  avatar_url?: string;
}

interface WebhookValidationResult {
  valid: boolean;
  error?: string;
  guildId?: string;
  channelId?: string;
  webhookName?: string;
}

export async function validateDiscordWebhook(
  webhookUrl: string
): Promise<WebhookValidationResult> {
  if (!DISCORD_WEBHOOK_REGEX.test(webhookUrl)) {
    return {
      valid: false,
      error:
        "Invalid Discord webhook URL format. Expected: https://discord.com/api/webhooks/ID/TOKEN",
    };
  }

  try {
    const response = await safeFetch(webhookUrl, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      if (response.status === 404) {
        return {
          valid: false,
          error: "Webhook not found. It may have been deleted.",
        };
      }
      if (response.status === 401) {
        return {
          valid: false,
          error: "Invalid webhook token.",
        };
      }
      return {
        valid: false,
        error: `Webhook validation failed with status ${response.status}`,
      };
    }

    const data = await response.json();

    return {
      valid: true,
      guildId: data.guild_id,
      channelId: data.channel_id,
      webhookName: data.name,
    };
  } catch (error) {
    logger.error(
      {
        webhookUrl: webhookUrl.substring(0, 50) + "...",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to validate Discord webhook"
    );
    return {
      valid: false,
      error: "Failed to validate webhook. Please check the URL and try again.",
    };
  }
}

export function formatDiscordMessage(
  notification: typeof notifications.$inferSelect
): DiscordWebhookPayload {
  const priority = notification.priority || "medium";
  const emoji = PRIORITY_EMOJIS[priority] || "📢";
  const color = PRIORITY_COLORS[priority] || PRIORITY_COLORS.medium;

  const embed: DiscordEmbed = {
    title: `${emoji} ${notification.title}`,
    description: notification.message,
    color,
    timestamp: new Date().toISOString(),
    footer: {
      text: `Anlyon • ${priority.charAt(0).toUpperCase() + priority.slice(1)} Priority`,
    },
  };

  if (notification.metadata && typeof notification.metadata === "object") {
    const metadata = notification.metadata as Record<string, any>;
    const fields: Array<{ name: string; value: string; inline: boolean }> = [];

    if (metadata.currentUsage !== undefined && metadata.limit !== undefined) {
      fields.push({
        name: "Usage",
        value: `${metadata.currentUsage.toLocaleString()} / ${metadata.limit.toLocaleString()}`,
        inline: true,
      });
    }
    if (metadata.percentage !== undefined) {
      fields.push({
        name: "Percentage",
        value: `${metadata.percentage}%`,
        inline: true,
      });
    }

    const advice = adviceSummary(metadata);
    if (advice) {
      fields.push({ name: advice.headline, value: advice.reasons.map((r) => `• ${r}`).join("\n") || "—", inline: false });
    }

    if (fields.length > 0) {
      embed.fields = fields;
    }
  }

  if (notification.actionUrl) {
    embed.fields = embed.fields || [];
    embed.fields.push({
      name: notification.actionLabel || "Take Action",
      value: `[Click here](${absoluteActionUrl(notification.actionUrl)})`,
      inline: false,
    });
  }

  return {
    embeds: [embed],
    username: "Anlyon",
    avatar_url: "https://anlyon.com/logo.png",
  };
}

export async function sendDiscordNotification(
  webhookUrl: string,
  notification: typeof notifications.$inferSelect
): Promise<void> {
  const payload = formatDiscordMessage(notification);

  try {
    const response = await safeFetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Discord webhook failed with status ${response.status}: ${errorText}`
      );
    }

    logger.info(
      {
        notificationId: notification.id,
        notificationType: notification.type,
        status: response.status,
      },
      "Discord notification sent"
    );
  } catch (error) {
    logger.error(
      {
        notificationId: notification.id,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to send Discord notification"
    );
    throw error;
  }
}

export async function sendTestDiscordNotification(
  webhookUrl: string
): Promise<boolean> {
  const testPayload: DiscordWebhookPayload = {
    embeds: [
      {
        title: "🧪 Test Notification",
        description:
          "This is a test notification from Anlyon. If you see this message, your Discord integration is working correctly!",
        color: PRIORITY_COLORS.low,
        timestamp: new Date().toISOString(),
        footer: {
          text: "Anlyon • Test Message",
        },
        fields: [
          {
            name: "Status",
            value: "✅ Connection successful",
            inline: true,
          },
          {
            name: "Integration",
            value: "Discord Webhook",
            inline: true,
          },
        ],
      },
    ],
    username: "Anlyon",
    avatar_url: "https://anlyon.com/logo.png",
  };

  try {
    const response = await safeFetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(testPayload),
      signal: AbortSignal.timeout(10000),
    });

    logger.info(
      {
        webhookUrl: webhookUrl.substring(0, 50) + "...",
        status: response.status,
        success: response.ok,
      },
      "Discord test notification sent"
    );

    return response.ok;
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Discord test notification failed"
    );
    return false;
  }
}
