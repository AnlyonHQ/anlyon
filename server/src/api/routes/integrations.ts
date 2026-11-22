import { Hono, type Context } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { requireApiKey, requireApiKeyResourceScopes, requirePermissionForWrites, requireSessionOnly, validateOriginForSession } from "../middleware/auth.ts";
import { assertSsoSessionForWorkspace } from "../../core/sso/sessions.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody, validateQuery } from "../middleware/validation.ts";
import { validateUUID } from "../../utils/uuid-validator.ts";
import { db } from "../../db/index.ts";
import {
  integrationConnections,
  oauthStates,
} from "../../db/schema/integrations.ts";
import { env } from "../../config/env.ts";
import { instanceSetting } from "../../core/instance/settings.ts";
import { ApiError } from "../../utils/errors.ts";
import { auth } from "../../utils/auth.ts";
import {
  encryptIntegrationToken,
  decryptIntegrationToken,
  generateOAuthState,
} from "../../utils/crypto.ts";
import {
  validateDiscordWebhook,
  sendTestDiscordNotification,
} from "../../core/integrations/discord-service.ts";
import {
  generateSlackAuthUrl,
  exchangeSlackCode,
  listSlackChannels,
  sendTestSlackNotification,
  testSlackToken,
  joinSlackChannel,
} from "../../core/integrations/slack-service.ts";
import {
  getWorkspaceIntegrations,
  getIntegrationById,
  deleteIntegration,
  toggleIntegration,
  updateIntegrationEventTypes,
} from "../../core/integrations/integration-service.ts";
import { logger } from "../../lib/logger.ts";
import { isAllowedRedirectTarget, resolveSafeRedirect } from "../../utils/origins.ts";
import { pathParam } from "../params.ts";

const integrationsRouter = new Hono();

integrationsRouter.use("*", requireApiKey);
integrationsRouter.use("*", requireApiKeyResourceScopes("integrations:read", "integrations:write"));
integrationsRouter.use("*", requirePermissionForWrites("integrations.manage"));
integrationsRouter.use("*", rateLimitByWorkspace);

const notificationTypeEnum = z.enum([
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

const createDiscordSchema = z.object({
  name: z.string().min(1).max(100),
  webhookUrl: z
    .string()
    .url()
    .regex(/^https:\/\/discord\.com\/api\/webhooks\//, {
      message: "Invalid Discord webhook URL format",
    }),
  enabledEventTypes: z.array(notificationTypeEnum).optional(),
});

const updateEventTypesSchema = z.object({
  enabledEventTypes: z.array(notificationTypeEnum),
});

const updateSlackChannelSchema = z.object({
  channelId: z.string().min(1),
  channelName: z.string().min(1),
});

const slackOAuthStartSchema = z.object({
  workspaceId: z.string().min(1),
  redirectUrl: z.string().url().optional(),
});

const toggleIntegrationSchema = z.object({
  isActive: z.boolean(),
});

integrationsRouter.get("/", async (c: Context) => {
  const workspaceId = c.get("workspaceId");

  const integrations = await getWorkspaceIntegrations(workspaceId);

  const safeIntegrations = integrations.map((integration) => ({
    id: integration.id,
    type: integration.type,
    name: integration.name,
    isActive: integration.isActive,
    enabledEventTypes: integration.enabledEventTypes,
    lastUsedAt: integration.lastUsedAt,
    lastError: integration.lastError,
    errorCount: integration.errorCount,
    createdAt: integration.createdAt,
    slackTeamId: integration.slackTeamId,
    slackTeamName: integration.slackTeamName,
    slackChannelId: integration.slackChannelId,
    slackChannelName: integration.slackChannelName,
    discordServerId: integration.discordServerId,
    discordChannelName: integration.discordChannelName,
  }));

  return c.json({
    success: true,
    data: safeIntegrations,
  });
});

integrationsRouter.post(
  "/discord",
  validateBody(createDiscordSchema),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const userId = c.get("userId");
    const { name, webhookUrl, enabledEventTypes } = c.get("validatedBody");

    const validation = await validateDiscordWebhook(webhookUrl);
    if (!validation.valid) {
      throw new ApiError(400, "invalid_webhook", validation.error || "Invalid webhook URL");
    }

    const encryptionKey = env.INTEGRATION_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new ApiError(500, "config_error", "Integration encryption is not configured");
    }

    const encryptedWebhookUrl = encryptIntegrationToken(webhookUrl, encryptionKey, workspaceId);

    const [integration] = await db
      .insert(integrationConnections)
      .values({
        workspaceId,
        type: "discord",
        name,
        discordWebhookUrlEncrypted: encryptedWebhookUrl,
        discordServerId: validation.guildId,
        discordChannelName: validation.webhookName,
        enabledEventTypes: enabledEventTypes || [
          "quota_warning",
          "quota_exceeded",
          "payment_failed",
          "security_alert",
          "approval_requested",
          "budget_alert",
          "approval_expired",
          "outcome_unknown",
          "connection_broken",
        ],
        createdBy: userId,
      })
      .returning();

    logger.info(
      {
        workspaceId,
        integrationId: integration.id,
        type: "discord",
      },
      "Discord integration created"
    );

    return c.json({
      success: true,
      data: {
        id: integration.id,
        type: integration.type,
        name: integration.name,
        isActive: integration.isActive,
        enabledEventTypes: integration.enabledEventTypes,
        discordChannelName: integration.discordChannelName,
        createdAt: integration.createdAt,
      },
    });
  }
);

integrationsRouter.post("/discord/:id/test", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const integrationId = validateUUID(pathParam(c, "id"), "Integration ID");

  const integration = await getIntegrationById(integrationId);
  if (!integration || integration.workspaceId !== workspaceId) {
    throw new ApiError(404, "not_found", "Integration not found");
  }

  if (integration.type !== "discord") {
    throw new ApiError(400, "invalid_type", "This is not a Discord integration");
  }

  if (!integration.discordWebhookUrlEncrypted) {
    throw new ApiError(400, "missing_config", "Discord webhook URL is not configured");
  }

  const encryptionKey = env.INTEGRATION_ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new ApiError(500, "config_error", "Integration encryption is not configured");
  }

  const webhookUrl = decryptIntegrationToken(
    integration.discordWebhookUrlEncrypted,
    encryptionKey,
    integration.workspaceId
  );

  const success = await sendTestDiscordNotification(webhookUrl);

  if (!success) {
    throw new ApiError(400, "test_failed", "Failed to send test message to Discord");
  }

  return c.json({
    success: true,
    data: {
      message: "Test message sent to Discord successfully",
    },
  });
});

integrationsRouter.post("/slack/oauth/start", validateBody(slackOAuthStartSchema), async (c: Context) => {
  const body = c.get("validatedBody");
  const workspaceId = body.workspaceId;

  if (!workspaceId) {
    throw new ApiError(400, "missing_workspace_id", "Workspace ID is required");
  }

  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    throw new ApiError(401, "unauthorized", "Authentication required");
  }

  const { hasWorkspaceAccess } = await import("../../core/workspace/service.ts");
  const hasAccess = await hasWorkspaceAccess(workspaceId, session.user.id);
  if (!hasAccess) {
    throw new ApiError(403, "forbidden", "You don't have access to this workspace");
  }
  await validateOriginForSession(c);
  await assertSsoSessionForWorkspace(workspaceId, session.user.id, session.session?.id);
  const { assertMemberPermission } = await import("../../core/workspace/roles.ts");
  await assertMemberPermission(workspaceId, session.user.id, "integrations.manage");

  if (!instanceSetting("slack.client_id") || !instanceSetting("slack.client_secret")) {
    throw new ApiError(500, "config_error", "Slack OAuth is not configured");
  }

  const state = generateOAuthState();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  const redirectUrl = body.redirectUrl && isAllowedRedirectTarget(body.redirectUrl)
    ? body.redirectUrl
    : null;

  await db.insert(oauthStates).values({
    workspaceId,
    userId: session.user.id,
    provider: "slack",
    state,
    expiresAt,
    redirectUrl,
  });

  const redirectUri = `${env.API_BASE_URL}/api/v2/integrations/slack/callback`;
  const authUrl = generateSlackAuthUrl(state, redirectUri);

  return c.json({
    success: true,
    data: {
      authUrl,
      state,
    },
  });
});

integrationsRouter.get("/slack/authorize", requireSessionOnly, async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const userId = c.get("userId");

  if (!instanceSetting("slack.client_id") || !instanceSetting("slack.client_secret")) {
    throw new ApiError(500, "config_error", "Slack OAuth is not configured");
  }

  const state = generateOAuthState();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  const redirectUrl = c.req.query("redirect");
  const safeRedirectUrl = isAllowedRedirectTarget(redirectUrl) ? redirectUrl : null;

  await db.insert(oauthStates).values({
    workspaceId,
    userId,
    provider: "slack",
    state,
    expiresAt,
    redirectUrl: safeRedirectUrl,
  });

  const redirectUri = `${env.API_BASE_URL}/api/v2/integrations/slack/callback`;
  const authUrl = generateSlackAuthUrl(state, redirectUri);

  return c.json({
    success: true,
    data: {
      authUrl,
    },
  });
});

integrationsRouter.get("/slack/callback", async (c: Context) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  if (error) {
    logger.warn({ error }, "Slack OAuth error");
    const frontendUrl = env.FRONTEND_URL || env.BETTER_AUTH_URL;
    return c.redirect(
      `${frontendUrl}/integrations?error=${encodeURIComponent(error)}`
    );
  }

  if (!code || !state) {
    const frontendUrl = env.FRONTEND_URL || env.BETTER_AUTH_URL;
    return c.redirect(
      `${frontendUrl}/integrations?error=${encodeURIComponent("Missing code or state")}`
    );
  }

  const [oauthState] = await db
    .select()
    .from(oauthStates)
    .where(
      and(
        eq(oauthStates.state, state),
        eq(oauthStates.provider, "slack")
      )
    );

  const frontendUrl = env.FRONTEND_URL || env.BETTER_AUTH_URL;

  if (!oauthState) {
    return c.redirect(
      `${frontendUrl}/integrations?error=${encodeURIComponent("Invalid state")}`
    );
  }

  if (new Date() > oauthState.expiresAt) {
    await db.delete(oauthStates).where(eq(oauthStates.id, oauthState.id));
    return c.redirect(
      `${frontendUrl}/integrations?error=${encodeURIComponent("OAuth session expired")}`
    );
  }

  if (oauthState.usedAt) {
    return c.redirect(
      `${frontendUrl}/integrations?error=${encodeURIComponent("OAuth state already used")}`
    );
  }

  const [claimed] = await db
    .update(oauthStates)
    .set({ usedAt: new Date() })
    .where(and(eq(oauthStates.id, oauthState.id), isNull(oauthStates.usedAt)))
    .returning({ id: oauthStates.id });
  if (!claimed) {
    return c.redirect(
      `${frontendUrl}/integrations?error=${encodeURIComponent("OAuth state already used")}`
    );
  }

  const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  const { hasWorkspaceAccess } = await import("../../core/workspace/service.ts");
  if (
    !session ||
    session.user.id !== oauthState.userId ||
    !(await hasWorkspaceAccess(oauthState.workspaceId, session.user.id))
  ) {
    logger.warn(
      { workspaceId: oauthState.workspaceId, hasSession: Boolean(session) },
      "Slack OAuth callback completed by a different or signed-out user; refusing"
    );
    return c.redirect(
      `${frontendUrl}/integrations?error=${encodeURIComponent(
        "Finish connecting Slack while signed in as the person who started it."
      )}`
    );
  }

  try {
    const redirectUri = `${env.API_BASE_URL}/api/v2/integrations/slack/callback`;
    const tokenResponse = await exchangeSlackCode(code, redirectUri);

    if (!tokenResponse.access_token || !tokenResponse.team) {
      throw new Error("Invalid token response from Slack");
    }

    const encryptionKey = env.INTEGRATION_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new Error("Integration encryption is not configured");
    }

    const encryptedToken = encryptIntegrationToken(
      tokenResponse.access_token,
      encryptionKey,
      oauthState.workspaceId
    );

    const [integration] = await db
      .insert(integrationConnections)
      .values({
        workspaceId: oauthState.workspaceId,
        type: "slack",
        name: `Slack - ${tokenResponse.team.name}`,
        slackTeamId: tokenResponse.team.id,
        slackTeamName: tokenResponse.team.name,
        slackAccessTokenEncrypted: encryptedToken,
        slackBotUserId: tokenResponse.bot_user_id,
        enabledEventTypes: [
          "quota_warning",
          "quota_exceeded",
          "payment_failed",
          "security_alert",
          "approval_requested",
          "budget_alert",
          "approval_expired",
          "outcome_unknown",
          "connection_broken",
        ],
        createdBy: oauthState.userId,
      })
      .returning();

    logger.info(
      {
        workspaceId: oauthState.workspaceId,
        integrationId: integration.id,
        teamName: tokenResponse.team.name,
      },
      "Slack integration created"
    );

    const frontendUrl = env.FRONTEND_URL || env.BETTER_AUTH_URL;
    const redirectUrl = resolveSafeRedirect(
      oauthState.redirectUrl ||
      `${frontendUrl}/integrations?slack_success=true&integration_id=${integration.id}`
    );

    return c.redirect(redirectUrl);
  } catch (err) {
    const frontendUrl = env.FRONTEND_URL || env.BETTER_AUTH_URL;
    logger.error(
      {
        error: err instanceof Error ? err.message : "Unknown error",
      },
      "Slack OAuth callback failed"
    );
    return c.redirect(
      `${frontendUrl}/integrations?error=${encodeURIComponent("Failed to connect Slack")}`
    );
  }
});

integrationsRouter.get("/slack/:id/channels", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const integrationId = validateUUID(pathParam(c, "id"), "Integration ID");

  const integration = await getIntegrationById(integrationId);
  if (!integration || integration.workspaceId !== workspaceId) {
    throw new ApiError(404, "not_found", "Integration not found");
  }

  if (integration.type !== "slack") {
    throw new ApiError(400, "invalid_type", "This is not a Slack integration");
  }

  if (!integration.slackAccessTokenEncrypted) {
    throw new ApiError(400, "missing_config", "Slack access token is not configured");
  }

  const encryptionKey = env.INTEGRATION_ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new ApiError(500, "config_error", "Integration encryption is not configured");
  }

  const accessToken = decryptIntegrationToken(
    integration.slackAccessTokenEncrypted,
    encryptionKey,
    integration.workspaceId
  );

  const channels = await listSlackChannels(accessToken);

  return c.json({
    success: true,
    data: channels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      isPrivate: ch.is_private,
      isMember: ch.is_member,
    })),
  });
});

integrationsRouter.patch(
  "/slack/:id/channel",
  validateBody(updateSlackChannelSchema),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const integrationId = validateUUID(pathParam(c, "id"), "Integration ID");
    const { channelId, channelName } = c.get("validatedBody");

    const integration = await getIntegrationById(integrationId);
    if (!integration || integration.workspaceId !== workspaceId) {
      throw new ApiError(404, "not_found", "Integration not found");
    }

    if (integration.type !== "slack") {
      throw new ApiError(400, "invalid_type", "This is not a Slack integration");
    }

    if (!integration.slackAccessTokenEncrypted) {
      throw new ApiError(400, "missing_config", "Slack access token is not configured");
    }

    const encryptionKey = env.INTEGRATION_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new ApiError(500, "config_error", "Integration encryption is not configured");
    }

    const accessToken = decryptIntegrationToken(
      integration.slackAccessTokenEncrypted,
      encryptionKey,
      integration.workspaceId
    );

    const joinResult = await joinSlackChannel(accessToken, channelId);

    await db
      .update(integrationConnections)
      .set({
        slackChannelId: channelId,
        slackChannelName: channelName,
        updatedAt: new Date(),
      })
      .where(eq(integrationConnections.id, integrationId));

    logger.info(
      {
        integrationId,
        channelId,
        channelName,
        autoJoined: joinResult.success,
        isPrivate: joinResult.isPrivate,
      },
      "Slack channel updated"
    );

    return c.json({
      success: true,
      data: {
        message: "Slack channel updated",
        channelId,
        channelName,
        autoJoined: joinResult.success,
        isPrivate: joinResult.isPrivate,
        joinError: joinResult.error,
      },
    });
  }
);

integrationsRouter.post("/slack/:id/test", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const integrationId = validateUUID(pathParam(c, "id"), "Integration ID");

  const integration = await getIntegrationById(integrationId);
  if (!integration || integration.workspaceId !== workspaceId) {
    throw new ApiError(404, "not_found", "Integration not found");
  }

  if (integration.type !== "slack") {
    throw new ApiError(400, "invalid_type", "This is not a Slack integration");
  }

  if (!integration.slackAccessTokenEncrypted || !integration.slackChannelId) {
    throw new ApiError(
      400,
      "missing_config",
      "Slack access token or channel is not configured"
    );
  }

  const encryptionKey = env.INTEGRATION_ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new ApiError(500, "config_error", "Integration encryption is not configured");
  }

  const accessToken = decryptIntegrationToken(
    integration.slackAccessTokenEncrypted,
    encryptionKey,
    integration.workspaceId
  );

  const result = await sendTestSlackNotification(
    accessToken,
    integration.slackChannelId
  );

  if (!result.success) {
    let errorMessage = "Failed to send test message to Slack";
    if (result.error === "not_in_channel") {
      errorMessage = "The Anlyon bot is not in this channel. Please add the bot to the channel first by typing '/invite @Anlyon' in the channel.";
    } else if (result.error === "channel_not_found") {
      errorMessage = "The selected channel no longer exists. Please select a different channel.";
    } else if (result.error === "invalid_auth") {
      errorMessage = "Slack authentication expired. Please reconnect the integration.";
    } else if (result.error) {
      errorMessage = `Slack error: ${result.error}`;
    }
    
    throw new ApiError(400, "test_failed", errorMessage);
  }

  return c.json({
    success: true,
    data: {
      message: "Test message sent to Slack successfully",
    },
  });
});

integrationsRouter.delete("/:id", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const integrationId = validateUUID(pathParam(c, "id"), "Integration ID");

  const integration = await getIntegrationById(integrationId);
  if (!integration || integration.workspaceId !== workspaceId) {
    throw new ApiError(404, "not_found", "Integration not found");
  }

  await deleteIntegration(integrationId);

  logger.info(
    {
      workspaceId,
      integrationId,
      type: integration.type,
    },
    "Integration deleted"
  );

  return c.json({
    success: true,
    data: {
      message: "Integration deleted",
    },
  });
});

integrationsRouter.patch("/:id/toggle", validateBody(toggleIntegrationSchema), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const integrationId = validateUUID(pathParam(c, "id"), "Integration ID");
  const { isActive } = c.get("validatedBody");

  const integration = await getIntegrationById(integrationId);
  if (!integration || integration.workspaceId !== workspaceId) {
    throw new ApiError(404, "not_found", "Integration not found");
  }

  await toggleIntegration(integrationId, isActive);

  return c.json({
    success: true,
    data: {
      message: isActive ? "Integration enabled" : "Integration disabled",
      isActive,
    },
  });
});

integrationsRouter.patch(
  "/:id/events",
  validateBody(updateEventTypesSchema),
  async (c: Context) => {
    const workspaceId = c.get("workspaceId");
    const integrationId = validateUUID(pathParam(c, "id"), "Integration ID");
    const { enabledEventTypes } = c.get("validatedBody");

    const integration = await getIntegrationById(integrationId);
    if (!integration || integration.workspaceId !== workspaceId) {
      throw new ApiError(404, "not_found", "Integration not found");
    }

    await updateIntegrationEventTypes(integrationId, enabledEventTypes);

    return c.json({
      success: true,
      data: {
        message: "Event types updated",
        enabledEventTypes,
      },
    });
  }
);

export default integrationsRouter;
