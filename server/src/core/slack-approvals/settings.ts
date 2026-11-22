import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { integrationConnections, oauthStates } from "../../db/schema/integrations.ts";
import { slackApprovalRoutes, slackUserLinks } from "../../db/schema/slack-approvals.ts";
import { env } from "../../config/env.ts";
import { instanceSetting } from "../instance/settings.ts";
import { generateOAuthState } from "../../utils/crypto.ts";
import { ApiError, NotFoundError, ValidationError } from "../../utils/errors.ts";
import { getEnvironment } from "../environments/service.ts";
import { joinSlackChannel } from "../integrations/slack-service.ts";
import { decryptIntegrationToken } from "../../utils/crypto.ts";
import { interactionsRequestUrl, slackApprovalsReady } from "./service.ts";
import { SLACK_OIDC_AUTHORIZE_URL, exchangeOpenIdCode } from "./slack-api.ts";

export const IDENTITY_STATE_PROVIDER = "slack_identity";
const STATE_TTL_MS = 10 * 60 * 1000;

export interface SlackApprovalsSettings {
  ready: boolean;
  requestUrl: string | null;
  installs: Array<{ integrationId: string; teamId: string | null; teamName: string | null; isActive: boolean }>;
  routes: Array<{ environmentId: string; integrationId: string; channelId: string; channelName: string; updatedAt: Date }>;
  links: Array<{ slackTeamId: string; slackUserId: string; createdAt: Date }>;
}

export async function getSlackApprovalsSettings(workspaceId: string, userId: string | null): Promise<SlackApprovalsSettings> {
  const installs = await db.select().from(integrationConnections).where(and(
    eq(integrationConnections.workspaceId, workspaceId),
    eq(integrationConnections.type, "slack"),
  ));
  const routes = await db.select().from(slackApprovalRoutes).where(eq(slackApprovalRoutes.workspaceId, workspaceId));
  const links = userId
    ? await db.select().from(slackUserLinks).where(and(eq(slackUserLinks.workspaceId, workspaceId), eq(slackUserLinks.userId, userId)))
    : [];
  return {
    ready: slackApprovalsReady(),
    requestUrl: interactionsRequestUrl(),
    installs: installs.map((i) => ({ integrationId: i.id, teamId: i.slackTeamId, teamName: i.slackTeamName, isActive: i.isActive })),
    routes: routes.map((r) => ({
      environmentId: r.environmentId,
      integrationId: r.integrationId,
      channelId: r.channelId,
      channelName: r.channelName,
      updatedAt: r.updatedAt,
    })),
    links: links.map((l) => ({ slackTeamId: l.slackTeamId, slackUserId: l.slackUserId, createdAt: l.createdAt })),
  };
}

export async function setSlackApprovalRoute(input: {
  workspaceId: string;
  environmentId: string;
  integrationId: string;
  channelId: string;
  channelName: string;
  userId: string | null;
}): Promise<{
  route: SlackApprovalsSettings["routes"][number];
  autoJoined: boolean;
  isPrivate: boolean;
}> {
  await getEnvironment(input.workspaceId, input.environmentId);
  const [install] = await db.select().from(integrationConnections).where(and(
    eq(integrationConnections.id, input.integrationId),
    eq(integrationConnections.workspaceId, input.workspaceId),
    eq(integrationConnections.type, "slack"),
  ));
  if (!install) throw new NotFoundError("Slack connection not found");
  if (!install.isActive) throw new ValidationError("This Slack connection is turned off. Turn it on first.");
  if (!install.slackAccessTokenEncrypted || !env.INTEGRATION_ENCRYPTION_KEY) {
    throw new ApiError(500, "config_error", "Integration encryption is not configured");
  }

  const token = decryptIntegrationToken(install.slackAccessTokenEncrypted, env.INTEGRATION_ENCRYPTION_KEY, install.workspaceId);
  const join = await joinSlackChannel(token, input.channelId);

  const now = new Date();
  const [route] = await db.insert(slackApprovalRoutes).values({
    workspaceId: input.workspaceId,
    environmentId: input.environmentId,
    integrationId: install.id,
    channelId: input.channelId,
    channelName: input.channelName,
    createdBy: input.userId,
  }).onConflictDoUpdate({
    target: slackApprovalRoutes.environmentId,
    set: { integrationId: install.id, channelId: input.channelId, channelName: input.channelName, updatedAt: now },
  }).returning();

  return {
    route: {
      environmentId: route.environmentId,
      integrationId: route.integrationId,
      channelId: route.channelId,
      channelName: route.channelName,
      updatedAt: route.updatedAt,
    },
    autoJoined: join.success,
    isPrivate: Boolean(join.isPrivate),
  };
}

export async function removeSlackApprovalRoute(workspaceId: string, environmentId: string): Promise<number> {
  await getEnvironment(workspaceId, environmentId);
  const removed = await db.delete(slackApprovalRoutes).where(and(
    eq(slackApprovalRoutes.workspaceId, workspaceId),
    eq(slackApprovalRoutes.environmentId, environmentId),
  )).returning({ id: slackApprovalRoutes.id });
  return removed.length;
}

export function identityRedirectUri(): string {
  return `${env.API_BASE_URL}/api/slack/identity/callback`;
}

export async function startSlackIdentityLink(workspaceId: string, userId: string): Promise<{ authUrl: string }> {
  if (!instanceSetting("slack.client_id") || !instanceSetting("slack.client_secret") || !env.API_BASE_URL) {
    throw new ApiError(500, "config_error", "Slack sign-in is not configured on this deployment");
  }
  const [install] = await db.select({ id: integrationConnections.id }).from(integrationConnections).where(and(
    eq(integrationConnections.workspaceId, workspaceId),
    eq(integrationConnections.type, "slack"),
    eq(integrationConnections.isActive, true),
  ));
  if (!install) throw new ValidationError("Connect Slack to this workspace before linking your Slack account.");

  const state = generateOAuthState();
  await db.insert(oauthStates).values({
    workspaceId,
    userId,
    provider: IDENTITY_STATE_PROVIDER,
    state,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  const params = new URLSearchParams({
    response_type: "code",
    scope: "openid",
    client_id: instanceSetting("slack.client_id")!,
    state,
    redirect_uri: identityRedirectUri(),
    nonce: generateOAuthState(),
  });
  return { authUrl: `${SLACK_OIDC_AUTHORIZE_URL}?${params.toString()}` };
}

export type LinkResult =
  | { ok: true; workspaceId: string }
  | { ok: false; error: string };

export async function finishSlackIdentityLink(input: {
  state: string;
  code: string;
  sessionUserId: string | null;
  hasAccess: (workspaceId: string, userId: string) => Promise<boolean>;
}): Promise<LinkResult> {
  const [claimed] = await db.update(oauthStates).set({ usedAt: new Date() }).where(and(
    eq(oauthStates.state, input.state),
    eq(oauthStates.provider, IDENTITY_STATE_PROVIDER),
    isNull(oauthStates.usedAt),
  )).returning();
  if (!claimed) return { ok: false, error: "This link request is invalid or was already used." };
  if (claimed.expiresAt.getTime() <= Date.now()) return { ok: false, error: "This link request expired. Start again." };
  if (!input.sessionUserId || input.sessionUserId !== claimed.userId || !(await input.hasAccess(claimed.workspaceId, claimed.userId))) {
    return { ok: false, error: "Finish linking Slack while signed in as the person who started it." };
  }
  if (!instanceSetting("slack.client_id") || !instanceSetting("slack.client_secret")) return { ok: false, error: "Slack sign-in is not configured." };

  let identity: { slackUserId: string; slackTeamId: string };
  try {
    identity = await exchangeOpenIdCode({
      clientId: instanceSetting("slack.client_id")!,
      clientSecret: instanceSetting("slack.client_secret")!,
      code: input.code,
      redirectUri: identityRedirectUri(),
    });
  } catch {
    return { ok: false, error: "Slack did not confirm your account. Try again." };
  }

  const [install] = await db.select({ id: integrationConnections.id }).from(integrationConnections).where(and(
    eq(integrationConnections.workspaceId, claimed.workspaceId),
    eq(integrationConnections.type, "slack"),
    eq(integrationConnections.slackTeamId, identity.slackTeamId),
  ));
  if (!install) return { ok: false, error: "That Slack account belongs to a Slack workspace that is not connected to this Anlyon workspace." };

  await db.transaction(async (tx) => {
    await tx.delete(slackUserLinks).where(and(
      eq(slackUserLinks.workspaceId, claimed.workspaceId),
      eq(slackUserLinks.slackTeamId, identity.slackTeamId),
      or(eq(slackUserLinks.slackUserId, identity.slackUserId), eq(slackUserLinks.userId, claimed.userId)),
    ));
    await tx.insert(slackUserLinks).values({
      workspaceId: claimed.workspaceId,
      slackTeamId: identity.slackTeamId,
      slackUserId: identity.slackUserId,
      userId: claimed.userId,
    });
  });
  return { ok: true, workspaceId: claimed.workspaceId };
}

export async function unlinkSlackIdentity(workspaceId: string, userId: string): Promise<number> {
  const removed = await db.delete(slackUserLinks)
    .where(and(eq(slackUserLinks.workspaceId, workspaceId), eq(slackUserLinks.userId, userId)))
    .returning({ id: slackUserLinks.id });
  return removed.length;
}
