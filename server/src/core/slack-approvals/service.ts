import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { approvals, approvalDecisions } from "../../db/schema/approvals.ts";
import { integrationConnections, type IntegrationConnection } from "../../db/schema/integrations.ts";
import { apiKeys, workspaceMembers } from "../../db/schema/workspaces.ts";
import { user } from "../../db/schema/user.ts";
import {
  slackApprovalActions,
  slackApprovalMessages,
  slackApprovalRoutes,
  slackUserLinks,
  type SlackApprovalMessage,
} from "../../db/schema/slack-approvals.ts";
import { env } from "../../config/env.ts";
import { instanceSetting } from "../instance/settings.ts";
import { createLogger } from "../../lib/logger.ts";
import { decryptIntegrationToken } from "../../utils/crypto.ts";
import { ApprovalAlreadyDecidedError, ApiError, SelfApprovalError } from "../../utils/errors.ts";
import { environmentIdentity } from "../effects/context.ts";
import { getPreview } from "../effects/service.ts";
import { approveApproval, denyApproval } from "../approvals/service.ts";
import { canDecideApprovalsIn } from "../approvals/deciders.ts";
import { assertLiveSsoSessionForWorkspace, SsoRequiredError } from "../sso/sessions.ts";
import {
  ACTION_APPROVE,
  ACTION_DENY,
  ACTION_NOTE,
  DECISION_BLOCK,
  DECISION_INPUT,
  NOTE_BLOCK,
  NOTE_INPUT,
  NOTE_MAX_LENGTH,
  NOTE_VIEW_CALLBACK,
  approveGate,
  code,
  renderApprovalMessage,
  renderNoteModal,
  renderingDigest,
  SELF_APPROVED_NOTE,
  type ApprovalMessageModel,
  type VoteModel,
} from "./blocks.ts";
import { SlackApiError, openView, postEphemeral, postMessage, updateMessage, usersInfo } from "./slack-api.ts";

const logger = createLogger({ module: "slack-approvals" });

type ApprovalRow = typeof approvals.$inferSelect;

export function slackApprovalsReady(): boolean {
  return Boolean(instanceSetting("slack.signing_secret") && env.INTEGRATION_ENCRYPTION_KEY);
}

export function interactionsRequestUrl(): string | null {
  return env.API_BASE_URL ? `${env.API_BASE_URL}/api/slack/interactions` : null;
}

function botToken(integration: IntegrationConnection): string {
  if (!integration.slackAccessTokenEncrypted || !env.INTEGRATION_ENCRYPTION_KEY) {
    throw new Error("Slack install has no usable bot token");
  }
  return decryptIntegrationToken(integration.slackAccessTokenEncrypted, env.INTEGRATION_ENCRYPTION_KEY, integration.workspaceId);
}

async function activeSlackInstall(integrationId: string): Promise<IntegrationConnection | null> {
  const [row] = await db.select().from(integrationConnections).where(and(
    eq(integrationConnections.id, integrationId),
    eq(integrationConnections.type, "slack"),
    eq(integrationConnections.isActive, true),
  ));
  return row ?? null;
}

async function userLabels(approvalId: string, userIds: string[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (userIds.length === 0) return labels;
  const people = await db.select({ id: user.id, name: user.name }).from(user)
    .where(inArray(user.id, userIds));
  const fromSlack = await db.select({ userId: slackApprovalActions.userId, slackUserId: slackApprovalActions.slackUserId })
    .from(slackApprovalActions)
    .where(and(eq(slackApprovalActions.approvalId, approvalId), eq(slackApprovalActions.result, "recorded")));
  const slackOf = new Map(fromSlack.filter((r) => r.userId).map((r) => [r.userId as string, r.slackUserId]));
  for (const person of people) {
    const slackUser = slackOf.get(person.id);
    labels.set(person.id, slackUser ? `${escapeName(person.name)} (<@${slackUser}>)` : escapeName(person.name));
  }
  return labels;
}

function escapeName(name: string): string {
  return name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\*/g, "");
}

async function keyLabel(keyId: string): Promise<string> {
  const [key] = await db.select({ name: apiKeys.name }).from(apiKeys).where(eq(apiKeys.id, keyId));
  return key ? `API key ${code(key.name)}` : "an API key";
}

export async function buildMessageModel(row: ApprovalRow, now: Date = new Date()): Promise<ApprovalMessageModel> {
  const environment = await environmentIdentity(row.environmentId);

  let preview: ApprovalMessageModel["preview"] = null;
  let previewMissing = false;
  if (row.previewId) {
    try {
      const view = await getPreview(row.workspaceId, row.environmentId, row.previewId);
      preview = { id: view.id, blocks: view.blocks, allowances: view.allowances, bindingDigest: view.bindingDigest, expiresAt: view.expiresAt };
    } catch (error) {
      logger.warn({ approvalId: row.approvalId, error: error instanceof Error ? error.message : error }, "Bound preview could not be loaded for Slack");
      previewMissing = true;
    }
  }

  const voteRows = await db.select().from(approvalDecisions)
    .where(eq(approvalDecisions.approvalId, row.id)).orderBy(asc(approvalDecisions.decidedAt));
  const userIds = [...new Set([
    ...voteRows.map((v) => v.deciderUserId).filter((id): id is string => Boolean(id)),
    ...(row.decidedByUserId ? [row.decidedByUserId] : []),
  ])];
  const labels = await userLabels(row.id, userIds);
  const votes: VoteModel[] = [];
  for (const v of voteRows) {
    const by = v.deciderUserId
      ? labels.get(v.deciderUserId) ?? "a member"
      : v.deciderKeyId ? await keyLabel(v.deciderKeyId) : "the approval assistant";
    votes.push({ decision: v.decision, by, selfApproved: v.selfApproved, at: v.decidedAt });
  }

  let decidedBy: string | null = null;
  if (row.status === "approved" || row.status === "denied") {
    if (row.decisionOrigin === "policy") decidedBy = row.matchedPolicyId ? `policy ${code(row.matchedPolicyId)}` : "a policy";
    else if (row.decisionOrigin === "assistant") decidedBy = "the approval assistant";
    else if (row.decidedByUserId && !row.decidedByKeyId) {
      decidedBy = labels.get(row.decidedByUserId) ?? "a member";
      if (voteRows.some((v) => v.deciderUserId === row.decidedByUserId && v.selfApproved)) {
        decidedBy = `${decidedBy} (${SELF_APPROVED_NOTE})`;
      }
    }
    else if (row.decidedByKeyId && !row.decidedByUserId) decidedBy = await keyLabel(row.decidedByKeyId);
  }

  return {
    approval: {
      approvalId: row.approvalId,
      kind: row.kind,
      status: row.status,
      title: row.title,
      description: row.description,
      payload: (row.payload as Record<string, unknown>) ?? {},
      requiredApprovals: row.requiredApprovals,
      approvedCount: row.approvedCount,
      expiresAt: row.expiresAt,
      decidedAt: row.decidedAt,
      decisionNote: row.decisionNote,
      bindingDigest: row.bindingDigest,
    },
    environment: { name: environment.name, kind: environment.kind },
    preview,
    previewMissing,
    votes,
    decidedBy,
    consoleUrl: env.CONSOLE_URL,
    now,
  };
}

export async function slackApprovalChannelFor(
  workspaceId: string,
  approvalPublicId: string,
): Promise<{ integrationId: string; channelId: string } | null> {
  if (!slackApprovalsReady()) return null;
  const [row] = await db.select({ integrationId: slackApprovalRoutes.integrationId, channelId: slackApprovalRoutes.channelId })
    .from(approvals)
    .innerJoin(slackApprovalRoutes, eq(slackApprovalRoutes.environmentId, approvals.environmentId))
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.approvalId, approvalPublicId)));
  return row ?? null;
}

export async function postApprovalToSlack(approvalRowId: string): Promise<void> {
  try {
    if (!slackApprovalsReady()) return;
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalRowId));
    if (!row || row.status !== "pending") return;
    const [route] = await db.select().from(slackApprovalRoutes).where(eq(slackApprovalRoutes.environmentId, row.environmentId));
    if (!route) return;
    const install = await activeSlackInstall(route.integrationId);
    if (!install?.slackTeamId) return;

    const [claimed] = await db.insert(slackApprovalMessages).values({
      approvalId: row.id,
      workspaceId: row.workspaceId,
      integrationId: install.id,
      slackTeamId: install.slackTeamId,
      channelId: route.channelId,
    }).onConflictDoNothing().returning();
    if (!claimed) return;

    const message = renderApprovalMessage(await buildMessageModel(row));
    try {
      const posted = await postMessage(botToken(install), route.channelId, message);
      await db.update(slackApprovalMessages).set({
        messageTs: posted.ts,
        channelId: posted.channel,
        renderedDigest: renderingDigest(message),
        lastError: null,
        updatedAt: new Date(),
      }).where(eq(slackApprovalMessages.id, claimed.id));
    } catch (error) {
      const reason = error instanceof SlackApiError ? error.code : "post_failed";
      await db.update(slackApprovalMessages).set({ lastError: reason, updatedAt: new Date() })
        .where(eq(slackApprovalMessages.id, claimed.id));
      throw error;
    }
    await syncSlackApprovalMessage(row.id);
  } catch (error) {
    logger.warn({ approvalRowId, error: error instanceof Error ? error.message : error }, "Slack approval request not posted");
  }
}

export async function syncSlackApprovalMessage(approvalRowId: string): Promise<void> {
  try {
    const [message] = await db.select().from(slackApprovalMessages).where(eq(slackApprovalMessages.approvalId, approvalRowId));
    if (!message?.messageTs) return;
    const install = await activeSlackInstall(message.integrationId);
    if (!install) return;
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalRowId));
    if (!row) return;
    const rendered = renderApprovalMessage(await buildMessageModel(row));
    const digest = renderingDigest(rendered);
    if (digest === message.renderedDigest) return;
    await updateMessage(botToken(install), message.channelId, message.messageTs, rendered);
    await db.update(slackApprovalMessages).set({ renderedDigest: digest, lastError: null, updatedAt: new Date() })
      .where(eq(slackApprovalMessages.id, message.id));
  } catch (error) {
    logger.warn({ approvalRowId, error: error instanceof Error ? error.message : error }, "Slack approval message not updated");
  }
}

export type Identification =
  | { ok: true; userId: string; method: "link" | "email" }
  | { ok: false; reason: "unlinked" | "guest" | "missing_scope" | "inactive_account" };

export async function identifySlackUser(input: {
  workspaceId: string;
  slackTeamId: string;
  slackUserId: string;
  token: string;
}): Promise<Identification> {
  const [link] = await db.select({ userId: slackUserLinks.userId }).from(slackUserLinks).where(and(
    eq(slackUserLinks.workspaceId, input.workspaceId),
    eq(slackUserLinks.slackTeamId, input.slackTeamId),
    eq(slackUserLinks.slackUserId, input.slackUserId),
  ));
  if (link) return { ok: true, userId: link.userId, method: "link" };

  let profile;
  try {
    profile = await usersInfo(input.token, input.slackUserId);
  } catch (error) {
    if (error instanceof SlackApiError && error.code === "missing_scope") return { ok: false, reason: "missing_scope" };
    throw error;
  }
  if (profile.deleted || profile.isBot) return { ok: false, reason: "inactive_account" };
  if (profile.isGuest) return { ok: false, reason: "guest" };
  if (profile.teamId !== input.slackTeamId) return { ok: false, reason: "unlinked" };
  if (!profile.email || !profile.emailConfirmed) return { ok: false, reason: "unlinked" };

  const [member] = await db.select({ id: user.id }).from(user)
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.workspaceId, input.workspaceId)))
    .where(and(sql`lower(${user.email}) = ${profile.email.toLowerCase()}`, eq(user.emailVerified, true)));
  if (!member) return { ok: false, reason: "unlinked" };
  return { ok: true, userId: member.id, method: "email" };
}

export interface SlackInteractionPayload {
  type?: string;
  team?: { id?: string } | null;
  user?: { id?: string; team_id?: string } | null;
  trigger_id?: string;
  channel?: { id?: string } | null;
  container?: { channel_id?: string; message_ts?: string } | null;
  message?: { ts?: string } | null;
  actions?: Array<{ action_id?: string; value?: string }>;
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, { value?: string | null; selected_option?: { value?: string } | null }>> };
  } | null;
}

export interface InteractionOutcome {
  response: Record<string, unknown> | null;
  work: Promise<void> | null;
}

const NONE: InteractionOutcome = { response: null, work: null };

async function findMessage(where: { id?: string; teamId?: string; channelId?: string; ts?: string }): Promise<SlackApprovalMessage | null> {
  if (where.id) {
    if (!/^[0-9a-f-]{36}$/i.test(where.id)) return null;
    const [row] = await db.select().from(slackApprovalMessages).where(eq(slackApprovalMessages.id, where.id));
    return row ?? null;
  }
  if (!where.teamId || !where.channelId || !where.ts) return null;
  const [row] = await db.select().from(slackApprovalMessages).where(and(
    eq(slackApprovalMessages.slackTeamId, where.teamId),
    eq(slackApprovalMessages.channelId, where.channelId),
    eq(slackApprovalMessages.messageTs, where.ts),
  ));
  return row ?? null;
}

export async function routeInteraction(payload: SlackInteractionPayload): Promise<InteractionOutcome> {
  const teamId = payload.team?.id ?? payload.user?.team_id;
  const slackUserId = payload.user?.id;
  if (!teamId || !slackUserId) return NONE;

  if (payload.type === "block_actions") {
    const action = payload.actions?.[0];
    const actionId = action?.action_id;
    if (actionId !== ACTION_APPROVE && actionId !== ACTION_DENY && actionId !== ACTION_NOTE) return NONE;
    const message = await findMessage({
      teamId,
      channelId: payload.channel?.id ?? payload.container?.channel_id,
      ts: payload.message?.ts ?? payload.container?.message_ts,
    });
    if (!message) return NONE;
    const [approval] = await db.select({ approvalId: approvals.approvalId }).from(approvals).where(eq(approvals.id, message.approvalId));
    if (!approval || action?.value !== approval.approvalId) return NONE;

    if (actionId === ACTION_NOTE) {
      return { response: null, work: openNoteModal(message, payload.trigger_id) };
    }
    return {
      response: null,
      work: decideFromSlack({ message, slackTeamId: teamId, slackUserId, decision: actionId === ACTION_APPROVE ? "approve" : "deny" }),
    };
  }

  if (payload.type === "view_submission" && payload.view?.callback_id === NOTE_VIEW_CALLBACK) {
    const message = await findMessage({ id: payload.view.private_metadata });
    if (!message || message.slackTeamId !== teamId) return { response: { response_action: "clear" }, work: null };
    const values = payload.view.state?.values ?? {};
    const decision = values[DECISION_BLOCK]?.[DECISION_INPUT]?.selected_option?.value;
    const note = values[NOTE_BLOCK]?.[NOTE_INPUT]?.value?.trim() || undefined;
    if (decision !== "approve" && decision !== "deny") {
      return { response: { response_action: "errors", errors: { [DECISION_BLOCK]: "Choose Approve or Deny." } }, work: null };
    }
    if (note && note.length > NOTE_MAX_LENGTH) {
      return { response: { response_action: "errors", errors: { [NOTE_BLOCK]: `Keep the note under ${NOTE_MAX_LENGTH} characters.` } }, work: null };
    }
    return {
      response: { response_action: "clear" },
      work: decideFromSlack({ message, slackTeamId: teamId, slackUserId, decision, note }),
    };
  }

  return NONE;
}

async function openNoteModal(message: SlackApprovalMessage, triggerId: string | undefined): Promise<void> {
  try {
    if (!triggerId) return;
    const install = await activeSlackInstall(message.integrationId);
    if (!install) return;
    const [row] = await db.select().from(approvals).where(eq(approvals.id, message.approvalId));
    if (!row) return;
    const model = await buildMessageModel(row);
    await openView(botToken(install), triggerId, renderNoteModal({
      messageRowId: message.id,
      title: row.title,
      environment: model.environment,
      approveAllowed: approveGate(model).ok,
      initial: "approve",
    }));
  } catch (error) {
    logger.warn({ messageId: message.id, error: error instanceof Error ? error.message : error }, "Slack note dialog not opened");
  }
}

export type RefusalReason =
  | "unlinked"
  | "guest"
  | "missing_scope"
  | "inactive_account"
  | "not_allowed"
  | "requester"
  | "sso_required"
  | "preview"
  | "routing_removed"
  | "already_decided"
  | "already_voted"
  | "refused"
  | "error";

function consoleLinkUrl(): string {
  return `${env.CONSOLE_URL}/settings/integrations`;
}

function refusalText(reason: RefusalReason, detail?: string): string {
  switch (reason) {
    case "unlinked":
      return `Your Slack account is not linked to a member of this Anlyon workspace, and its email did not match a verified Anlyon account. Link it in Anlyon, then try again: <${consoleLinkUrl()}|Link your Slack account>.`;
    case "guest":
      return `Slack guests are not matched to Anlyon members by email. Link your Slack account in Anlyon, then try again: <${consoleLinkUrl()}|Link your Slack account>.`;
    case "missing_scope":
      return `Anlyon cannot read your Slack email because the Slack app was installed before Slack approvals. Link your account in Anlyon (<${consoleLinkUrl()}|Link your Slack account>), or ask an admin to reconnect Slack.`;
    case "inactive_account":
      return "This Slack account cannot decide approvals.";
    case "not_allowed":
      return "You are not allowed to decide approvals in this environment.";
    case "requester":
      return detail ?? "You requested this approval, so someone else must decide it.";
    case "sso_required":
      return "This workspace requires single sign-on. Sign in to Anlyon with SSO, then decide again.";
    case "preview":
      return detail ?? "This approval cannot be approved from Slack right now. Review it in Anlyon.";
    case "routing_removed":
      return "Slack approvals are turned off for this environment. Decide this approval in Anlyon.";
    case "already_decided":
    case "already_voted":
    case "refused":
      return detail ?? "Your decision was not recorded.";
    case "error":
      return "Your decision could not be recorded. Try again, or decide in Anlyon.";
  }
}

async function recordAttempt(input: {
  approvalRowId: string;
  workspaceId: string;
  slackTeamId: string;
  slackUserId: string;
  userId: string | null;
  identifiedBy: "link" | "email" | null;
  decision: "approve" | "deny";
  result: "recorded" | "refused";
  reason: RefusalReason | null;
}): Promise<void> {
  try {
    await db.insert(slackApprovalActions).values({
      approvalId: input.approvalRowId,
      workspaceId: input.workspaceId,
      slackTeamId: input.slackTeamId,
      slackUserId: input.slackUserId,
      userId: input.userId,
      identifiedBy: input.identifiedBy,
      decision: input.decision,
      result: input.result,
      reason: input.reason,
    });
  } catch (error) {
    logger.warn({ approvalRowId: input.approvalRowId, error: error instanceof Error ? error.message : error }, "Slack decision attempt not recorded");
  }
}

export async function decideFromSlack(input: {
  message: SlackApprovalMessage;
  slackTeamId: string;
  slackUserId: string;
  decision: "approve" | "deny";
  note?: string;
}): Promise<void> {
  const { message, slackTeamId, slackUserId, decision, note } = input;
  if (slackTeamId !== message.slackTeamId) return;
  const install = await activeSlackInstall(message.integrationId);
  if (!install) return;
  const [row] = await db.select().from(approvals).where(eq(approvals.id, message.approvalId));
  if (!row) return;

  let token: string;
  try {
    token = botToken(install);
  } catch (error) {
    logger.warn({ approvalId: row.approvalId, error: error instanceof Error ? error.message : error }, "Slack decision ignored: bot token unavailable");
    return;
  }
  const reply = async (text: string) => {
    try {
      await postEphemeral(token, message.channelId, slackUserId, text);
    } catch (error) {
      logger.warn({ approvalId: row.approvalId, error: error instanceof Error ? error.message : error }, "Slack reply not sent");
    }
  };
  const base = { approvalRowId: row.id, workspaceId: row.workspaceId, slackTeamId, slackUserId, decision };
  const refuse = async (
    reason: RefusalReason,
    who: { userId: string | null; identifiedBy: "link" | "email" | null },
    detail?: string,
  ) => {
    await recordAttempt({ ...base, ...who, result: "refused", reason });
    await reply(refusalText(reason, detail));
    await syncSlackApprovalMessage(row.id);
  };
  const nobody = { userId: null, identifiedBy: null };

  const [route] = await db.select().from(slackApprovalRoutes).where(and(
    eq(slackApprovalRoutes.environmentId, row.environmentId),
    eq(slackApprovalRoutes.integrationId, install.id),
  ));
  if (!route) return refuse("routing_removed", nobody);

  let identity: Identification;
  try {
    identity = await identifySlackUser({ workspaceId: row.workspaceId, slackTeamId, slackUserId, token });
  } catch (error) {
    logger.warn({ approvalId: row.approvalId, error: error instanceof Error ? error.message : error }, "Slack user not identified");
    return refuse("error", nobody);
  }
  if (!identity.ok) return refuse(identity.reason, nobody);
  const who = { userId: identity.userId, identifiedBy: identity.method };

  if (!(await canDecideApprovalsIn({ workspaceId: row.workspaceId, environmentId: row.environmentId, userId: identity.userId }))) {
    return refuse("not_allowed", who);
  }
  try {
    await assertLiveSsoSessionForWorkspace(row.workspaceId, identity.userId);
  } catch (error) {
    if (error instanceof SsoRequiredError) return refuse("sso_required", who);
    logger.warn({ approvalId: row.approvalId, error: error instanceof Error ? error.message : error }, "Slack decision SSO check failed");
    return refuse("error", who);
  }

  if (decision === "approve") {
    const gate = approveGate(await buildMessageModel(row));
    if (!gate.ok) return refuse("preview", who, gate.reason);
  }

  try {
    const ctx = { deciderUserId: identity.userId, note };
    const result = decision === "approve"
      ? await approveApproval(row.workspaceId, row.approvalId, ctx, row.environmentId)
      : await denyApproval(row.workspaceId, row.approvalId, ctx, row.environmentId);
    await recordAttempt({ ...base, ...who, result: "recorded", reason: null });
    if (result.approval.status === "pending") {
      await reply(`Your approval is recorded. ${result.approval.approvedCount} of ${result.approval.requiredApprovals} approvals so far.`);
    }
    await syncSlackApprovalMessage(row.id);
  } catch (error) {
    if (error instanceof ApprovalAlreadyDecidedError) {
      const voted = /already decided this approval/i.test(error.message);
      const [current] = await db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, row.id));
      const detail = voted
        ? "You have already voted on this approval."
        : `This approval is already ${current?.status ?? "decided"}. Your decision was not recorded.`;
      return refuse(voted ? "already_voted" : "already_decided", who, detail);
    }
    if (error instanceof SelfApprovalError) return refuse("requester", who, error.message);
    if (error instanceof ApiError && error.statusCode < 500) {
      return refuse("refused", who, `Your decision was not recorded: ${error.message}`);
    }
    logger.error({ approvalId: row.approvalId, error: error instanceof Error ? error.message : error }, "Slack decision failed");
    return refuse("error", who);
  }
}
