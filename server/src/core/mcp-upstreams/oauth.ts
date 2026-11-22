import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { mcpUpstreams, type McpUpstream, type McpUpstreamOAuth } from "../../db/schema/mcp-upstreams.ts";
import { oauthConnections } from "../../db/schema/oauth-connections.ts";
import { ValidationError } from "../../utils/errors.ts";
import { randomBytes } from "node:crypto";
import { assertSecretsMayReachHost, loadSecretPolicies, putSecret, resolveSecrets } from "../actions/secrets.ts";
import { isVerifiedVendorEndpoint } from "../connections/integration-route.ts";
import { requireConnectionProvider } from "../connections/provider.ts";
import { isDeploymentClientId, type OAuthAppSpec, type OAuthClient } from "../connections/oauth-apps.ts";
import { createProviderTransport, type ProviderTransport } from "../effects/transport.ts";
import { MCP_MAX_RESPONSE_BYTES } from "./client.ts";

const KEY = /^mcp-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SECRET_NAME = /^\{\{secret:([A-Z0-9_]+)\}\}$/;

export const upstreamIntegrationKey = (rowId: string) => `mcp-${rowId}`;

export function upstreamRowIdOf(integrationKey: string): string | null {
  return KEY.exec(integrationKey)?.[1] ?? null;
}

export class UpstreamCredentialError extends ValidationError {
  constructor(readonly code: "no_connection" | "token_refresh_failed", message: string) {
    super(message);
    this.name = "UpstreamCredentialError";
  }
}

export class UpstreamOAuthRefused extends ValidationError {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = "UpstreamOAuthRefused";
  }
}

export function resourceMetadataUrl(challenge: string | null | undefined): string | null {
  if (!challenge) return null;
  const match = /resource_metadata\s*=\s*(?:"([^"]+)"|([^\s,]+))/i.exec(challenge);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

const clip = (value: unknown) => {
  const text = String(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

export function resourceCovers(resource: URL, endpoint: URL): boolean {
  if (resource.origin !== endpoint.origin || resource.hash) return false;
  const path = (url: URL) => url.pathname.replace(/\/+$/, "");
  const owned = path(resource);
  const served = path(endpoint);
  if (resource.search) return served === owned && resource.search === endpoint.search;
  return served === owned || served.startsWith(`${owned}/`);
}

function httpsUrl(value: unknown, what: string): URL {
  if (typeof value !== "string" || !value) throw new UpstreamOAuthRefused("metadata_invalid", `The ${what} is missing.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UpstreamOAuthRefused("metadata_invalid", `The ${what} is not a URL.`);
  }
  if (url.protocol !== "https:") throw new UpstreamOAuthRefused("not_https", `The ${what} is not https (${clip(`${url.protocol}//${url.host}`)}). Anlyon only signs in over https.`);
  if (url.username || url.password) throw new UpstreamOAuthRefused("metadata_invalid", `The ${what} carries credentials.`);
  return url;
}

async function readMetadata(url: URL, what: string): Promise<Record<string, unknown> | null> {
  const transport: ProviderTransport = createProviderTransport({ hosts: [url.hostname], maxResponseBytes: MCP_MAX_RESPONSE_BYTES });
  let response;
  try {
    response = await transport.request({ method: "GET", url: url.toString(), headers: { Accept: "application/json" } });
  } catch (error) {
    throw new UpstreamOAuthRefused("metadata_unreachable", `The ${what} could not be read: ${clip(error instanceof Error ? error.message : error)}`);
  }
  if (response.status === 404) return null;
  if (response.status < 200 || response.status >= 300 || !response.json || typeof response.json !== "object") {
    throw new UpstreamOAuthRefused("metadata_invalid", `The ${what} answered HTTP ${response.status} without a JSON document.`);
  }
  return response.json as Record<string, unknown>;
}

function wellKnown(base: URL, suffix: string): URL {
  const path = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "");
  return new URL(`${base.origin}/.well-known/${suffix}${path}`);
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

export interface DiscoveredOAuth {
  endpoint: string;
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopesSupported: string[];
  registrationEndpoint: string | null;
  authorizationServers: string[];
  tokenEndpointAuthMethods: string[];
  authorizationResponseIss: boolean;
  advertised: McpUpstreamOAuth["advertised"];
}

export async function discoverUpstreamOAuth(endpoint: string, challenge: string | null, preferredIssuer?: string | null): Promise<DiscoveredOAuth> {
  const server = new URL(endpoint);
  const named = resourceMetadataUrl(challenge);
  let prm: Record<string, unknown> | null = null;
  if (named) {
    prm = await readMetadata(httpsUrl(named, "protected resource metadata URL"), "protected resource metadata");
  } else {
    prm = await readMetadata(wellKnown(server, "oauth-protected-resource"), "protected resource metadata");
    if (!prm && server.pathname !== "/") prm = await readMetadata(new URL(`${server.origin}/.well-known/oauth-protected-resource`), "protected resource metadata");
  }
  if (!prm) throw new UpstreamOAuthRefused("no_resource_metadata", "The server publishes no protected resource metadata (RFC 9728), so Anlyon cannot tell which authorization server issues its tokens.");

  const resource = httpsUrl(prm.resource, "protected resource");
  if (!resourceCovers(resource, server)) {
    throw new UpstreamOAuthRefused("resource_mismatch", `The metadata names the resource ${clip(resource.toString())}, which is not this endpoint (${server.toString()}). Anlyon refuses a token meant for another resource.`);
  }
  const servers = strings(prm.authorization_servers);
  if (servers.length === 0) throw new UpstreamOAuthRefused("no_authorization_server", "The protected resource metadata names no authorization server.");
  const norm = (value: string) => value.replace(/\/+$/, "");
  const chosen = preferredIssuer ? servers.find((server) => norm(server) === norm(preferredIssuer)) : servers[0];
  if (!chosen) {
    throw new UpstreamOAuthRefused("authorization_server_not_listed", `The resource does not name ${clip(preferredIssuer)} as an authorization server. It names: ${clip(servers.join(", "))}.`);
  }
  const issuer = httpsUrl(chosen, "authorization server");

  let as = await readMetadata(wellKnown(issuer, "oauth-authorization-server"), "authorization server metadata");
  if (!as) as = await readMetadata(wellKnown(issuer, "openid-configuration"), "authorization server metadata");
  if (!as && issuer.pathname !== "/") as = await readMetadata(new URL(`${issuer.origin}${issuer.pathname.replace(/\/+$/, "")}/.well-known/openid-configuration`), "authorization server metadata");
  if (!as) throw new UpstreamOAuthRefused("no_authorization_server_metadata", `The authorization server ${issuer.origin} publishes no metadata (RFC 8414).`);
  if (typeof as.issuer !== "string" || as.issuer.replace(/\/+$/, "") !== chosen.replace(/\/+$/, "")) {
    throw new UpstreamOAuthRefused("issuer_mismatch", `The authorization server's metadata names another issuer (${clip(as.issuer)}).`);
  }
  const authorizationEndpoint = httpsUrl(as.authorization_endpoint, "authorization endpoint");
  const tokenEndpoint = httpsUrl(as.token_endpoint, "token endpoint");
  const grants = strings(as.grant_types_supported);
  if (grants.length > 0 && !grants.includes("authorization_code")) {
    throw new UpstreamOAuthRefused(
      "authorization_code_unsupported",
      `The authorization server does not offer the authorization code grant (it offers ${clip(grants.join(", "))}). Anlyon signs people in with the authorization code grant only; token exchange is not supported.`,
    );
  }
  const pkceS256 = strings(as.code_challenge_methods_supported).includes("S256");
  if (!pkceS256) {
    throw new UpstreamOAuthRefused("pkce_unsupported", "The authorization server does not advertise PKCE with S256, which MCP requires. Anlyon will not sign in without it.");
  }
  return {
    endpoint,
    resource: String(prm.resource).trim(),
    issuer: chosen,
    authorizationServers: servers.slice(0, 10).map((server) => clip(server)),
    authorizationEndpoint: authorizationEndpoint.toString(),
    tokenEndpoint: tokenEndpoint.toString(),
    scopesSupported: strings(prm.scopes_supported),
    tokenEndpointAuthMethods: strings(as.token_endpoint_auth_methods_supported).slice(0, 10).map((method) => clip(method)),
    registrationEndpoint: (() => {
      try {
        return typeof as.registration_endpoint === "string" ? httpsUrl(as.registration_endpoint, "registration endpoint").toString() : null;
      } catch {
        return null;
      }
    })(),
    authorizationResponseIss: as.authorization_response_iss_parameter_supported === true,
    advertised: {
      dynamicRegistration: typeof as.registration_endpoint === "string",
      clientIdMetadataDocuments: as.client_id_metadata_document_supported === true,
      pkceS256,
    },
  };
}

export interface PreRegisteredClient {
  clientId?: string | null;
  clientSecret?: string | null;
  scopes?: string[];
  redirectUri?: string | null;
  authorizationServer?: string | null;
}

export function upstreamRedirectUri(): string {
  return requireConnectionProvider().redirectUri();
}

export function clientMetadataUrl(): string {
  return requireConnectionProvider().clientMetadataUrl();
}

export function clientMetadataDocument(): Record<string, unknown> {
  return {
    client_id: clientMetadataUrl(),
    client_name: "Anlyon",
    redirect_uris: [upstreamRedirectUri()],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export type ClientRegistration = NonNullable<McpUpstreamOAuth["clientRegistration"]>;

export interface ResolvedClient {
  clientId: string;
  clientSecretName: string | null;
  clientRegistration: ClientRegistration;
  tokenEndpointAuthMethod?: McpUpstreamOAuth["tokenEndpointAuthMethod"];
  clientSecretExpiresAt?: number;
  createdSecret?: string;
}

export function mayLendSharedClient(discovered: Pick<DiscoveredOAuth, "endpoint" | "advertised">): boolean {
  return discovered.advertised.clientIdMetadataDocuments && isVerifiedVendorEndpoint(discovered.endpoint);
}

export async function resolveClient(
  scope: { workspaceId: string; environmentId: string }, client: PreRegisteredClient, discovered: DiscoveredOAuth, name: string,
): Promise<ResolvedClient> {
  if (client.clientId?.trim()) return { ...(await checkClient(scope, client, discovered)), clientRegistration: "pre_registered" };
  if (!mayLendSharedClient(discovered)) {
    if (!discovered.registrationEndpoint) requirePreRegisteredClient(discovered);
    if (client.clientSecret) throw new UpstreamOAuthRefused("dcr_secret", "A dynamically registered client gets its credentials from the server: give no client secret.");
    return registerDynamicClient(scope, discovered, name, client.scopes ?? discovered.scopesSupported);
  }
  if (client.clientSecret) {
    throw new UpstreamOAuthRefused("cimd_secret", "A client metadata document is a public client: it takes no client secret.");
  }
  if (client.redirectUri && client.redirectUri !== upstreamRedirectUri()) {
    throw new UpstreamOAuthRefused("redirect_uri_not_owned", `This deployment's client redirects only to ${upstreamRedirectUri()}.`);
  }
  const url = new URL(clientMetadataUrl());
  if (url.protocol !== "https:") {
    throw new UpstreamOAuthRefused("cimd_unavailable", `This deployment's public URL (${url.origin}) is not https, so authorization servers cannot fetch its client metadata document.`);
  }
  return { clientId: url.toString(), clientSecretName: null, clientRegistration: "client_metadata_document" };
}

const AUTH_METHODS = new Set(["none", "client_secret_post", "client_secret_basic"]);

function requestedAuthMethod(advertised: readonly string[]): string {
  if (advertised.length === 0 || advertised.includes("none")) return "none";
  return advertised.find((method) => AUTH_METHODS.has(method)) ?? "none";
}

async function registerDynamicClient(
  scope: { workspaceId: string; environmentId: string }, discovered: DiscoveredOAuth, name: string, scopes: string[],
): Promise<ResolvedClient> {
  const endpoint = new URL(discovered.registrationEndpoint!);
  const redirectUri = upstreamRedirectUri();
  const requested = requestedAuthMethod(discovered.tokenEndpointAuthMethods);
  const transport = createProviderTransport({ hosts: [endpoint.hostname], maxResponseBytes: MCP_MAX_RESPONSE_BYTES });
  let response;
  try {
    response = await transport.request({
      method: "POST",
      url: endpoint.toString(),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Anlyon",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: requested,
        ...(scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
      }),
    });
  } catch (error) {
    throw new UpstreamOAuthRefused("dcr_failed", `Registering a client with ${clip(endpoint.host)} failed: ${clip(error instanceof Error ? error.message : error)}`);
  }
  const body = (response.json ?? null) as Record<string, unknown> | null;
  if (response.status < 200 || response.status >= 300 || !body || typeof body.client_id !== "string" || !body.client_id || body.client_id.length > 512) {
    const reason = body && typeof body.error === "string" ? ` (${clip(body.error)})` : "";
    throw new UpstreamOAuthRefused("dcr_failed", `${clip(endpoint.host)} did not register a client: HTTP ${response.status}${reason}.`);
  }
  if (/^https:\/\//i.test(body.client_id)) {
    throw new UpstreamOAuthRefused("dcr_failed", `${clip(endpoint.host)} issued a client id that is a URL, which Anlyon does not accept from a registration.`);
  }
  const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris : null;
  if (redirects && !redirects.includes(redirectUri)) {
    throw new UpstreamOAuthRefused("dcr_redirect_mismatch", `${clip(endpoint.host)} registered the client without this deployment's redirect URI.`);
  }
  const method = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : requested;
  if (!AUTH_METHODS.has(method)) {
    throw new UpstreamOAuthRefused("dcr_auth_method_unsupported", `${clip(endpoint.host)} assigned the token endpoint auth method ${clip(method)}, which Anlyon does not use.`);
  }
  const secret = typeof body.client_secret === "string" && body.client_secret ? body.client_secret : null;
  const expiresAt = Number(body.client_secret_expires_at ?? 0);
  if (!secret) {
    if (method !== "none") throw new UpstreamOAuthRefused("dcr_failed", `${clip(endpoint.host)} assigned ${clip(method)} but issued no client secret.`);
    return { clientId: body.client_id, clientSecretName: null, clientRegistration: "dynamic", tokenEndpointAuthMethod: "none" };
  }
  const secretName = `MCP_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CLIENT_SECRET_${randomBytes(3).toString("hex").toUpperCase()}`;
  await putSecret(scope.workspaceId, secretName, {
    value: secret,
    description: `Client secret ${clip(endpoint.host)} issued to Anlyon when the MCP upstream ${name} was registered.`,
    allowedHosts: [new URL(discovered.tokenEndpoint).hostname],
  }, scope.environmentId);
  return {
    clientId: body.client_id,
    clientSecretName: secretName,
    clientRegistration: "dynamic",
    tokenEndpointAuthMethod: method === "client_secret_basic" ? "client_secret_basic" : "client_secret_post",
    clientSecretExpiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : 0,
    createdSecret: secretName,
  };
}

async function assertClientSecretBound(workspaceId: string, name: string, environmentId: string, tokenEndpoint: string): Promise<void> {
  const policies = await loadSecretPolicies(workspaceId, [name], environmentId);
  const hosts = policies.get(name)?.allowedHosts;
  if (hosts && hosts.length > 0) return;
  const host = clip(new URL(tokenEndpoint).hostname);
  throw new UpstreamOAuthRefused(
    "client_secret_unbound",
    `Secret ${name} may go to any host, so it cannot be an OAuth client's secret. Set its allowed hosts to ${host}: in the console, Actions > Secrets; or PUT /secrets/${name} with "allowedHosts": ["${host}"].`,
  );
}

async function checkClient(
  scope: { workspaceId: string; environmentId: string }, client: PreRegisteredClient, discovered: DiscoveredOAuth,
): Promise<{ clientId: string; clientSecretName: string | null }> {
  const clientId = (client.clientId ?? "").trim();
  if (/^https:\/\//i.test(clientId)) {
    throw new UpstreamOAuthRefused("cimd_unsupported", "A client id that is a URL is a Client ID Metadata Document. Anlyon uses only its own: leave the client id out to use it.");
  }
  if (isDeploymentClientId(clientId)) {
    throw new UpstreamOAuthRefused("client_not_yours", "That client id is this deployment's own app for an integration. Use a client id you registered with the vendor.");
  }
  if (client.redirectUri && client.redirectUri !== upstreamRedirectUri()) {
    throw new UpstreamOAuthRefused(
      "redirect_uri_not_owned",
      `The client is registered with the redirect URI ${client.redirectUri}, which this deployment does not own. Register ${upstreamRedirectUri()} with the vendor instead.`,
    );
  }
  if (!client.clientSecret) return { clientId, clientSecretName: null };
  const name = SECRET_NAME.exec(client.clientSecret.trim())?.[1];
  if (!name) throw new ValidationError("A client secret is written as a {{secret:NAME}} reference, never as a value.");
  await assertSecretsMayReachHost(scope.workspaceId, [name], discovered.tokenEndpoint, scope.environmentId);
  await assertClientSecretBound(scope.workspaceId, name, scope.environmentId, discovered.tokenEndpoint);
  return { clientId, clientSecretName: name };
}

export function oauthRequired(discovered: DiscoveredOAuth): never {
  const host = clip(new URL(discovered.issuer).host);
  throw new UpstreamOAuthRefused(
    "oauth_required",
    mayLendSharedClient(discovered) || discovered.registrationEndpoint
      ? `This server signs people in with OAuth through ${host}, which accepts a client Anlyon brings itself. Register it as an OAuth upstream; no client id is needed.`
      : `This server signs people in with OAuth through ${host}. Register it as an OAuth upstream with the client id you registered with the vendor (redirect URI ${upstreamRedirectUri()}).`,
  );
}

export function requirePreRegisteredClient(discovered: DiscoveredOAuth): never {
  const host = clip(new URL(discovered.issuer).host);
  if (discovered.advertised.dynamicRegistration) {
    throw new UpstreamOAuthRefused(
      "registration_mode_unsupported",
      `This server signs people in with OAuth through ${host}. Its dynamic client registration endpoint is not https, so Anlyon will not register there. Register an OAuth client with the vendor, with the redirect URI ${upstreamRedirectUri()}, and give its client id.`,
    );
  }
  throw new UpstreamOAuthRefused(
    "client_required",
    `This server signs people in with OAuth through ${host}, which accepts no client Anlyon can bring. Register an OAuth client with the vendor, with the redirect URI ${upstreamRedirectUri()}, and give its client id.`,
  );
}

async function rowOf(integrationKey: string, environmentId: string): Promise<McpUpstream | null> {
  const id = upstreamRowIdOf(integrationKey);
  if (!id) return null;
  const [row] = await db.select().from(mcpUpstreams).where(and(
    eq(mcpUpstreams.id, id), eq(mcpUpstreams.environmentId, environmentId), isNull(mcpUpstreams.archivedAt),
  ));
  return row?.oauth ? row : null;
}

export async function liveOAuthUpstream(
  scope: { workspaceId: string; environmentId: string }, integrationKey: string,
): Promise<Pick<McpUpstream, "id" | "name"> | null> {
  const row = await rowOf(integrationKey, scope.environmentId);
  return row && row.workspaceId === scope.workspaceId ? { id: row.id, name: row.name } : null;
}

export async function upstreamApp(integrationKey: string, environmentId: string): Promise<{ spec: OAuthAppSpec; scopes: string[]; client: OAuthClient; namesDeveloper: boolean } | null> {
  const row = await rowOf(integrationKey, environmentId);
  if (!row?.oauth) return null;
  const oauth = row.oauth;
  const registration = oauth.clientRegistration ?? "pre_registered";
  if (registration === "client_metadata_document" && !isVerifiedVendorEndpoint(row.url)) return null;
  if (oauth.clientSecretExpiresAt && oauth.clientSecretExpiresAt * 1000 <= Date.now()) return null;
  let clientSecret = "";
  if (oauth.clientSecretName) {
    await assertSecretsMayReachHost(row.workspaceId, [oauth.clientSecretName], oauth.tokenEndpoint, row.environmentId);
    await assertClientSecretBound(row.workspaceId, oauth.clientSecretName, row.environmentId, oauth.tokenEndpoint);
    const resolved = await resolveSecrets(row.workspaceId, [oauth.clientSecretName], row.environmentId, { endUserId: null, required: false });
    clientSecret = resolved.get(oauth.clientSecretName) ?? "";
    if (!clientSecret) return null;
  }
  const spec: OAuthAppSpec = {
    credentials: "MCP_UPSTREAM",
    authorizeUrl: oauth.authorizationEndpoint,
    tokenUrl: oauth.tokenEndpoint,
    scopeSeparator: " ",
    pkce: true,
    clientAuth: !oauth.clientSecretName ? "none" : oauth.tokenEndpointAuthMethod === "client_secret_basic" ? "basic" : "body",
    response: "standard",
    authorizeParams: { resource: oauth.resource },
    tokenParams: { resource: oauth.resource },
    issuer: oauth.issuer,
    requireIssuerInResponse: registration === "dynamic" && oauth.authorizationResponseIss === true,
  } as OAuthAppSpec;
  return { spec, scopes: oauth.scopes, client: { clientId: oauth.clientId, clientSecret }, namesDeveloper: registration === "pre_registered" };
}

export async function upstreamToken(
  scope: { workspaceId: string; environmentId: string; endUserId?: string | null }, upstream: Pick<McpUpstream, "id" | "name" | "operatorConnectionId">,
): Promise<string> {
  return (await upstreamCredential(scope, upstream)).token;
}

export async function upstreamCredential(
  scope: { workspaceId: string; environmentId: string; endUserId?: string | null }, upstream: Pick<McpUpstream, "id" | "name" | "operatorConnectionId">,
): Promise<{ token: string; refresh: () => Promise<string | null> }> {
  const integrationKey = upstreamIntegrationKey(upstream.id);
  let connectionId: string | null = null;
  if (scope.endUserId) {
    const [row] = await db.select({ id: oauthConnections.id }).from(oauthConnections).where(and(
      eq(oauthConnections.workspaceId, scope.workspaceId),
      eq(oauthConnections.environmentId, scope.environmentId),
      eq(oauthConnections.integrationKey, integrationKey),
      eq(oauthConnections.subjectEndUserId, scope.endUserId),
      isNull(oauthConnections.revokedAt),
      isNull(oauthConnections.pendingConfirmationUntil),
    ));
    connectionId = row?.id ?? null;
    if (!connectionId) throw new UpstreamCredentialError("no_connection", `This end user has not connected ${upstream.name}. Send them a connect link. Nothing was sent.`);
  } else {
    connectionId = upstream.operatorConnectionId;
    if (!connectionId) throw new UpstreamCredentialError("no_connection", `No one has connected ${upstream.name} for calls made without an end user. Connect it from the console. Nothing was sent.`);
  }
  const ref = { integrationKey, connectionId };
  let token: string;
  try {
    token = await requireConnectionProvider().getAccessToken(ref);
  } catch {
    throw new UpstreamCredentialError("token_refresh_failed", `The ${upstream.name} sign-in could not be refreshed. Connect it again. Nothing was sent.`);
  }
  const refresh = async () => {
    try {
      return await requireConnectionProvider().getAccessToken(ref, { forceRefresh: true });
    } catch {
      return null;
    }
  };
  return { token, refresh };
}

export const oauthHeaderFor = (rowId: string) => ({ Authorization: `Bearer {{connection:${upstreamIntegrationKey(rowId)}}}` });

export const oauthSecretName = (rowId: string) => `connection:${upstreamIntegrationKey(rowId)}`;
