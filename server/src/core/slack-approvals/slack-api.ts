const SLACK_API = "https://slack.com/api";
const TIMEOUT_MS = 10_000;

export class SlackApiError extends Error {
  constructor(readonly method: string, readonly code: string) {
    super(`Slack ${method} failed: ${code}`);
    this.name = "SlackApiError";
  }
}

type SlackResponse = { ok: boolean; error?: string } & Record<string, unknown>;

async function call(method: string, token: string, init: { json?: unknown; form?: Record<string, string> }): Promise<SlackResponse> {
  const response = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": init.form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
    },
    body: init.form ? new URLSearchParams(init.form).toString() : JSON.stringify(init.json ?? {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let data: SlackResponse;
  try {
    data = (await response.json()) as SlackResponse;
  } catch {
    throw new SlackApiError(method, `http_${response.status}`);
  }
  if (!data.ok) throw new SlackApiError(method, data.error ?? "unknown_error");
  return data;
}

export interface SlackMessage {
  text: string;
  blocks: unknown[];
}

export async function postMessage(token: string, channel: string, message: SlackMessage): Promise<{ ts: string; channel: string }> {
  const data = await call("chat.postMessage", token, { json: { channel, ...message, unfurl_links: false, unfurl_media: false } });
  return { ts: String(data.ts), channel: String(data.channel ?? channel) };
}

export async function updateMessage(token: string, channel: string, ts: string, message: SlackMessage): Promise<void> {
  await call("chat.update", token, { json: { channel, ts, ...message } });
}

export async function postEphemeral(token: string, channel: string, user: string, text: string): Promise<void> {
  await call("chat.postEphemeral", token, { json: { channel, user, text } });
}

export async function openView(token: string, triggerId: string, view: unknown): Promise<void> {
  await call("views.open", token, { json: { trigger_id: triggerId, view } });
}

export interface SlackUserProfile {
  id: string;
  teamId: string | null;
  email: string | null;
  emailConfirmed: boolean;
  deleted: boolean;
  isBot: boolean;
  isGuest: boolean;
  displayName: string | null;
}

export async function usersInfo(token: string, user: string): Promise<SlackUserProfile> {
  const data = await call("users.info", token, { form: { user } });
  const u = (data.user ?? {}) as Record<string, unknown>;
  const profile = (u.profile ?? {}) as Record<string, unknown>;
  return {
    id: String(u.id ?? user),
    teamId: typeof u.team_id === "string" ? u.team_id : null,
    email: typeof profile.email === "string" && profile.email ? profile.email : null,
    emailConfirmed: u.is_email_confirmed === true,
    deleted: u.deleted === true,
    isBot: u.is_bot === true || u.id === "USLACKBOT",
    isGuest: u.is_restricted === true || u.is_ultra_restricted === true,
    displayName: typeof profile.real_name === "string" && profile.real_name
      ? profile.real_name
      : typeof u.name === "string" ? u.name : null,
  };
}

export const SLACK_OIDC_AUTHORIZE_URL = "https://slack.com/openid/connect/authorize";

export async function exchangeOpenIdCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ slackUserId: string; slackTeamId: string }> {
  const tokenResponse = await fetch(`${SLACK_API}/openid.connect.token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const token = (await tokenResponse.json()) as SlackResponse;
  if (!token.ok || typeof token.access_token !== "string") {
    throw new SlackApiError("openid.connect.token", token.error ?? "no_access_token");
  }
  const info = await call("openid.connect.userInfo", token.access_token, { json: {} });
  const slackUserId = info["https://slack.com/user_id"];
  const slackTeamId = info["https://slack.com/team_id"];
  if (typeof slackUserId !== "string" || typeof slackTeamId !== "string") {
    throw new SlackApiError("openid.connect.userInfo", "no_identity");
  }
  return { slackUserId, slackTeamId };
}
