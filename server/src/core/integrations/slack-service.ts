import { logger } from "../../lib/logger.ts";
import { env } from "../../config/env.ts";
import { instanceSetting } from "../instance/settings.ts";
import type { notifications } from "../../db/schema/notifications.ts";
import { adviceSummary } from "../assistant/notification-text.ts";
import { absoluteActionUrl } from "../notifications/console-link.ts";

const SLACK_OAUTH_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_CONVERSATIONS_LIST_URL = "https://slack.com/api/conversations.list";
const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_AUTH_TEST_URL = "https://slack.com/api/auth.test";

const SLACK_SCOPES = [
  "chat:write",
  "channels:read",
  "groups:read",
  "team:read",
  "channels:join",
  "users:read",
  "users:read.email",
].join(",");

const PRIORITY_EMOJIS: Record<string, string> = {
  low: ":information_source:",
  medium: ":warning:",
  high: ":exclamation:",
  critical: ":rotating_light:",
};

const PRIORITY_COLORS: Record<string, string> = {
  low: "#6b7280",
  medium: "#3b82f6",
  high: "#f59e0b",
  critical: "#ef4444",
};

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  elements?: any[];
  accessory?: any;
}

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: {
    id: string;
    name: string;
  };
  authed_user?: {
    id: string;
  };
}

interface SlackChannel {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
}

interface SlackConversationsResponse {
  ok: boolean;
  error?: string;
  channels?: SlackChannel[];
  response_metadata?: {
    next_cursor?: string;
  };
}

interface SlackPostMessageResponse {
  ok: boolean;
  error?: string;
  channel?: string;
  ts?: string;
  message?: any;
}

export function generateSlackAuthUrl(
  state: string,
  redirectUri: string
): string {
  if (!instanceSetting("slack.client_id")) {
    throw new Error("SLACK_CLIENT_ID is not configured");
  }

  const params = new URLSearchParams({
    client_id: instanceSetting("slack.client_id")!,
    scope: SLACK_SCOPES,
    redirect_uri: redirectUri,
    state,
  });

  return `${SLACK_OAUTH_URL}?${params.toString()}`;
}

export async function exchangeSlackCode(
  code: string,
  redirectUri: string
): Promise<SlackOAuthResponse> {
  if (!instanceSetting("slack.client_id") || !instanceSetting("slack.client_secret")) {
    throw new Error("Slack OAuth credentials are not configured");
  }

  const response = await fetch(SLACK_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: instanceSetting("slack.client_id")!,
      client_secret: instanceSetting("slack.client_secret")!,
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(15000),
  });

  const data: SlackOAuthResponse = await response.json();

  if (!data.ok) {
    logger.error({ error: data.error }, "Slack OAuth token exchange failed");
    throw new Error(`Slack OAuth failed: ${data.error}`);
  }

  logger.info(
    {
      teamId: data.team?.id,
      teamName: data.team?.name,
    },
    "Slack OAuth token exchange successful"
  );

  return data;
}

export async function testSlackToken(accessToken: string): Promise<{
  valid: boolean;
  teamId?: string;
  teamName?: string;
  botUserId?: string;
  error?: string;
}> {
  try {
    const response = await fetch(SLACK_AUTH_TEST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    const data = await response.json();

    if (!data.ok) {
      return { valid: false, error: data.error };
    }

    return {
      valid: true,
      teamId: data.team_id,
      teamName: data.team,
      botUserId: data.bot_id || data.user_id,
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function listSlackChannels(
  accessToken: string
): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
    });

    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await fetch(
      `${SLACK_CONVERSATIONS_LIST_URL}?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15000),
      }
    );

    const data: SlackConversationsResponse = await response.json();

    if (!data.ok) {
      logger.error({ error: data.error }, "Failed to list Slack channels");
      throw new Error(`Failed to list Slack channels: ${data.error}`);
    }

    if (data.channels) {
      channels.push(
        ...data.channels.filter(
          (ch) => !ch.is_private || ch.is_member
        )
      );
    }

    cursor = data.response_metadata?.next_cursor;
  } while (cursor);

  return channels.sort((a, b) => a.name.localeCompare(b.name));
}

export async function joinSlackChannel(
  accessToken: string,
  channelId: string
): Promise<{ success: boolean; error?: string; isPrivate?: boolean }> {
  try {
    const response = await fetch("https://slack.com/api/conversations.join", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: channelId }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await response.json();

    if (!data.ok) {
      if (data.error === "method_not_supported_for_channel_type") {
        return { success: false, isPrivate: true };
      }
      if (data.error === "already_in_channel") {
        return { success: true };
      }
      return { success: false, error: data.error };
    }

    return { success: true };
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        channelId,
      },
      "Failed to join Slack channel"
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export function formatSlackMessage(
  notification: typeof notifications.$inferSelect
): { blocks: SlackBlock[]; text: string; attachments?: any[] } {
  const priority = notification.priority || "medium";
  const emoji = PRIORITY_EMOJIS[priority] || ":bell:";
  const color = PRIORITY_COLORS[priority] || PRIORITY_COLORS.medium;

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${emoji} ${notification.title}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: notification.message,
      },
    },
  ];

  if (notification.metadata && typeof notification.metadata === "object") {
    const metadata = notification.metadata as Record<string, any>;
    const fields: Array<{ type: string; text: string }> = [];

    if (metadata.currentUsage !== undefined && metadata.limit !== undefined) {
      fields.push({
        type: "mrkdwn",
        text: `*Usage:* ${metadata.currentUsage.toLocaleString()} / ${metadata.limit.toLocaleString()}`,
      });
    }
    if (metadata.percentage !== undefined) {
      fields.push({
        type: "mrkdwn",
        text: `*Percentage:* ${metadata.percentage}%`,
      });
    }

    if (fields.length > 0) {
      blocks.push({
        type: "section",
        // @ts-ignore - Slack's field format
        fields,
      });
    }
  }

  const advice = adviceSummary(notification.metadata);
  if (advice) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: [`*${advice.headline}*`, ...advice.reasons.map((r) => `• ${r}`)].join("\n") },
    });
  }

  if (notification.actionUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: notification.actionLabel || "View Details",
            emoji: true,
          },
          url: absoluteActionUrl(notification.actionUrl),
          style: "primary",
        },
      ],
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Sent from Anlyon | Priority: ${priority.charAt(0).toUpperCase() + priority.slice(1)}`,
      },
    ],
  });

  return {
    blocks,
    text: `${notification.title}: ${notification.message}`,
    attachments: [
      {
        color,
      },
    ],
  };
}

export async function sendSlackNotification(
  accessToken: string,
  channelId: string,
  notification: typeof notifications.$inferSelect
): Promise<void> {
  const payload = formatSlackMessage(notification);

  try {
    const response = await fetch(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: channelId,
        ...payload,
      }),
      signal: AbortSignal.timeout(30000),
    });

    const data: SlackPostMessageResponse = await response.json();

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }

    logger.info(
      {
        notificationId: notification.id,
        notificationType: notification.type,
        channel: channelId,
        messageTs: data.ts,
      },
      "Slack notification sent"
    );
  } catch (error) {
    logger.error(
      {
        notificationId: notification.id,
        channel: channelId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to send Slack notification"
    );
    throw error;
  }
}

export async function sendTestSlackNotification(
  accessToken: string,
  channelId: string
): Promise<{ success: boolean; error?: string }> {
  const testPayload = {
    channel: channelId,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🧪 Test Notification",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "This is a test notification from *Anlyon*. If you see this message, your Slack integration is working correctly!",
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: "*Status:*\n✅ Connection successful",
          },
          {
            type: "mrkdwn",
            text: "*Integration:*\nSlack Bot",
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Sent from Anlyon | Test Message",
          },
        ],
      },
    ],
    text: "Test notification from Anlyon",
  };

  try {
    const response = await fetch(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(testPayload),
      signal: AbortSignal.timeout(10000),
    });

    const data: SlackPostMessageResponse = await response.json();

    logger.info(
      {
        channel: channelId,
        success: data.ok,
        error: data.error,
      },
      "Slack test notification sent"
    );

    return { success: data.ok, error: data.error };
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Slack test notification failed"
    );
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}
