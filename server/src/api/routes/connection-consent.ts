import { Hono, type Context, type MiddlewareHandler } from "hono";
import { requireFeature } from "../middleware/feature-gate.ts";
import { rateLimitByIp } from "../middleware/rateLimit.ts";
import { createLogger } from "../../lib/logger.ts";
import { connectionProvider } from "../../core/connections/provider.ts";
import { recordConsent, recordConsentFailure } from "../../core/connections/service.ts";
import { findIntegration, integrationView } from "../../core/connections/catalogue.ts";
import { isUpstreamKey } from "../../core/connections/native.ts";
import { CONNECT_PAGE_PATHS, CONSENT_BASE_PATH } from "../../core/connections/consent-urls.ts";
import { connectSettings, KEY_LINK_PATH, peekKeyLink, recordEndUserConsent, submitKeyLink } from "../../core/end-users/connect.ts";
import { redirectWithResult } from "../../core/end-users/redirects.ts";
import type { ConnectPageField } from "../connect-pages/render.ts";
import { connectPageHeaders, sendConnectPage } from "../connect-pages/send.ts";
import * as views from "../connect-pages/views.ts";
import { onConnectPagesHost } from "../connect-host.ts";

const logger = createLogger({ module: "connection-consent" });

function redirect(c: Context, to: string) {
  connectPageHeaders(c);
  return c.redirect(to, 302);
}

const integrationOf = (key: string) => ({ id: key, name: findIntegration(key)?.displayName ?? key });

const cancelHref = (redirectUrl: string | null | undefined, integration: string, status: "declined" | "error" = "declined") =>
  redirectUrl ? redirectWithResult(redirectUrl, { integration, anlyon_status: status }) : null;

const originOf = (url: string | null | undefined) => {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

async function start(c: Context) {
  const provider = connectionProvider();
  if (!provider) return sendConnectPage(c, views.unavailableView());
  let url: string | null;
  try {
    url = await provider.beginConsent(c.req.query("token") ?? "");
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, "Starting a consent failed");
    return sendConnectPage(c, views.signInCouldNotStartView());
  }
  if (!url) return sendConnectPage(c, views.expiredSignInLinkView());
  return redirect(c, url);
}

async function link(c: Context) {
  const provider = connectionProvider();
  if (!provider) return sendConnectPage(c, views.unavailableView());
  const token = c.req.query("token") ?? "";
  const consent = await provider.peekConsent(token).catch(() => null);
  if (!consent || !consent.subject) return sendConnectPage(c, views.expiredLinkView());

  if (consent.ownApp) return start(c);

  const settings = await connectSettings({ workspaceId: consent.workspaceId, environmentId: consent.environmentId }).catch(() => null);
  if (!settings) return sendConnectPage(c, views.expiredLinkView());
  return sendConnectPage(c, views.linkView({
    integration: isUpstreamKey(consent.integrationKey)
      ? { id: consent.integrationKey, name: await (await import("../../core/mcp-upstreams/service.ts")).upstreamDisplayName(consent.integrationKey) }
      : integrationOf(consent.integrationKey),
    app: settings.workspaceName,
    continueHref: provider.connectUrl(token),
    cancelHref: cancelHref(consent.subject.redirectUrl, consent.integrationKey),
  }));
}

function keyFields(integrationKey: string): { fields: ConnectPageField[]; help?: { text: string; href?: string } } {
  const entry = findIntegration(integrationKey);
  const auth = entry ? integrationView(entry, { signIn: false }).auth : null;
  const apiKey = auth?.kind === "api_key" ? auth : null;
  const fields = apiKey?.fields?.map((field) => ({ name: field.name, label: field.label, secret: field.secret, ...(field.hint ? { hint: field.hint } : {}) }))
    ?? [{ name: "apiKey", label: "API key", secret: true }];
  return { fields, ...(apiKey ? { help: { text: apiKey.instructions, href: apiKey.instructionsUrl } } : {}) };
}

const keyAction = (c: Context) => (c.req.path.startsWith(CONSENT_BASE_PATH) ? KEY_LINK_PATH : "/key");

type KeyLink = NonNullable<Awaited<ReturnType<typeof peekKeyLink>>>;

async function keyLinkIntegration(keyLink: KeyLink): Promise<{ id: string; name: string; destination?: { host: string | null } }> {
  if (!isUpstreamKey(keyLink.integration)) return integrationOf(keyLink.integration);
  const upstream = await (await import("../../core/mcp-upstreams/service.ts")).upstreamKeyDestination(keyLink.integration, keyLink);
  return { id: keyLink.integration, name: upstream.name, destination: { host: upstream.host } };
}

const keyForm = async (c: Context, token: string, keyLink: KeyLink, refused?: { message: string; attemptsLeft: number }) => {
  const { destination, ...integration } = await keyLinkIntegration(keyLink);
  return views.keyFormView({
    integration,
    app: keyLink.workspaceName,
    token,
    action: keyAction(c),
    ...keyFields(keyLink.integration),
    cancelHref: cancelHref(keyLink.redirectUrl, keyLink.integration),
    redirectOrigin: originOf(keyLink.redirectUrl),
    ...(refused ? { refused } : {}),
    ...(destination ? { destination } : {}),
  });
};

async function keyPage(c: Context) {
  const token = c.req.query("token") ?? "";
  const keyLink = await peekKeyLink(token).catch(() => null);
  if (!keyLink) return sendConnectPage(c, views.expiredLinkView());
  return sendConnectPage(c, await keyForm(c, token, keyLink));
}

async function keySubmit(c: Context) {
  const body = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
  const token = typeof body.token === "string" ? body.token : "";
  const keyLink = await peekKeyLink(token).catch(() => null);
  if (!keyLink) return sendConnectPage(c, views.expiredLinkView());
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(body)) {
    if (name.startsWith("f_") && typeof value === "string") values[name.slice(2)] = value.trim();
  }
  const entry = findIntegration(keyLink.integration);
  const auth = entry ? integrationView(entry, { signIn: false }).auth : null;
  const given = auth?.kind === "api_key" && auth.fields ? { fields: values } : { apiKey: values.apiKey ?? "" };

  const result = await submitKeyLink(token, given);
  if (result.status === "expired") return sendConnectPage(c, views.expiredLinkView());
  if (result.status === "refused") {
    if (result.attemptsLeft > 0) return sendConnectPage(c, await keyForm(c, token, keyLink, { message: result.message, attemptsLeft: result.attemptsLeft }));
    return sendConnectPage(c, views.keyUsedUpView({
      integration: await keyLinkIntegration(keyLink),
      app: keyLink.workspaceName,
      message: result.message,
      backHref: cancelHref(keyLink.redirectUrl, keyLink.integration, "error"),
    }));
  }
  logger.info({ integrationKey: keyLink.integration }, "End user's key link handled");
  if (result.redirectTo) return redirect(c, result.redirectTo);
  return sendConnectPage(c, views.connectedView({ integration: await keyLinkIntegration(keyLink), app: keyLink.workspaceName }));
}

async function callback(c: Context) {
  const provider = connectionProvider();
  if (!provider) return sendConnectPage(c, views.unavailableView());
  const result = await provider.finishConsent({
    state: c.req.query("state") ?? null,
    code: c.req.query("code") ?? null,
    error: c.req.query("error") ?? null,
    iss: c.req.query("iss") ?? null,
  }).catch((error: unknown) => {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, "Finishing a consent failed");
    return null;
  });

  if (!result) return sendConnectPage(c, views.notConnectedView(502, "Something went wrong on Anlyon's side. Go back to the app you came from and start again."));
  if (!result.ok) {
    if (result.reason === "expired") return sendConnectPage(c, views.expiredSignInView());
    if (result.subject) {
      const to = await recordEndUserConsent(result.subject, { status: result.reason === "declined" ? "declined" : "error" });
      if (to) return redirect(c, to);
      return sendConnectPage(c, views.nothingConnectedView(result.reason === "declined" ? 200 : 502));
    }
    await recordConsentFailure(result.endUserId, result.reason);
    return result.reason === "declined"
      ? sendConnectPage(c, views.accessNotApprovedView())
      : sendConnectPage(c, views.notConnectedView(502, "The provider did not complete the sign-in. Go back to Anlyon and start again."));
  }

  const integration = isUpstreamKey(result.outcome.integrationKey)
    ? { id: result.outcome.integrationKey, name: await (await import("../../core/mcp-upstreams/service.ts")).upstreamDisplayName(result.outcome.integrationKey) }
    : integrationOf(result.outcome.integrationKey);
  const subject = result.outcome.subject;
  if (subject) {
    const to = await recordEndUserConsent(subject, { status: "connected", connectionId: result.outcome.connectionId });
    logger.info({ integrationKey: result.outcome.integrationKey, pending: Boolean(subject.pendingUntil) }, "End user's consent handled");
    if (to) return redirect(c, to);
    const settings = await connectSettings({ workspaceId: subject.workspaceId, environmentId: subject.environmentId }).catch(() => null);
    return sendConnectPage(c, views.connectedView({ integration, app: settings?.workspaceName }));
  }

  if (isUpstreamKey(result.outcome.integrationKey)) {
    const { recordOperatorConsent } = await import("../../core/mcp-upstreams/service.ts");
    const recorded = await recordOperatorConsent(result.outcome);
    logger.info({ outcome: recorded }, "Upstream consent callback handled");
    return recorded === "connected"
      ? sendConnectPage(c, views.connectedView({ integration, app: null }))
      : sendConnectPage(c, views.notConnectedView(400, "Go back to Anlyon and start again."));
  }

  const outcome = await recordConsent(result.outcome);
  logger.info({ outcome, integrationKey: result.outcome.integrationKey }, "Consent callback handled");
  if (/^(completed|reconnected|duplicate)/.test(outcome)) return sendConnectPage(c, views.connectedView({ integration, app: null }));
  return sendConnectPage(c, views.notConnectedView(400, "Go back to Anlyon to see why, then start again."));
}

async function clientMetadata(c: Context) {
  if (!connectionProvider()) return c.notFound();
  const { clientMetadataDocument } = await import("../../core/mcp-upstreams/oauth.ts");
  c.header("Cache-Control", "public, max-age=3600");
  return c.json(clientMetadataDocument());
}

const feature = requireFeature("connected-accounts");

const connectionConsentRouter = new Hono({ strict: false });
connectionConsentRouter.use("*", feature);
connectionConsentRouter.get("/start", start);
connectionConsentRouter.get("/link", link);
connectionConsentRouter.get("/key", keyPage);
connectionConsentRouter.post("/key", keySubmit);
connectionConsentRouter.get("/callback", callback);
connectionConsentRouter.get("/mcp-client.json", requireFeature("mcp-upstreams"), clientMetadata);

const onlyOnPagesHost: MiddlewareHandler = async (c, next) => {
  if (!onConnectPagesHost(c)) return c.notFound();
  await next();
};
export const connectPagesRouter = new Hono({ strict: false });
for (const path of CONNECT_PAGE_PATHS) connectPagesRouter.use(path, onlyOnPagesHost, rateLimitByIp, feature);
connectPagesRouter.get("/start", start);
connectPagesRouter.get("/link", link);
connectPagesRouter.get("/key", keyPage);
connectPagesRouter.post("/key", keySubmit);
connectPagesRouter.get("/callback", callback);

export default connectionConsentRouter;
