import { and, eq, isNull, sql } from "drizzle-orm";
import { hashTools, parseToolsList, scanTools, type McpTool } from "@anlyon-dev/risk";
import { db } from "../../db/index.ts";
import { actions, type ActionMcpBinding } from "../../db/schema/actions.ts";
import { environments } from "../../db/schema/environments.ts";
import { mcpUpstreams, type McpToolChange, type McpToolSnapshot, type McpUpstream } from "../../db/schema/mcp-upstreams.ts";
import { createLogger } from "../../lib/logger.ts";
import { generateMcpUpstreamId } from "../../utils/crypto.ts";
import {
  ApiError, AuthorizationError, ConflictError, ConnectionKeyCheckFailedError, ConnectionKeyRejectedError, NotFoundError, ValidationError,
} from "../../utils/errors.ts";
import { hasUnstorableText } from "../../utils/storable-text.ts";
import { assessMcpSchema, type LooseReason, type SchemaCheck } from "../../utils/mcp-json-schema.ts";
import { assertMayReferenceSecrets, createAction, readoptMcpTool, type ActionView, type CallerAuthority } from "../actions/service.ts";
import { assertSecretsMayReachHost, deleteSecret, loadSecretPolicies } from "../actions/secrets.ts";
import { extractSecretNames, hasInputRef, usesAccountHost } from "../actions/template.ts";
import { writeAuditEvents } from "../audit/outbox.ts";
import { MCP_TOOL_CHECK_INTERVAL_DEFAULT_HOURS, MCP_TOOL_CHECK_INTERVAL_MAX_HOURS } from "../instance/registry.ts";
import { instanceSetting } from "../instance/settings.ts";
import { createAndSendNotification } from "../notifications/notification-service.ts";
import { declaredHost, type ImpactDeclarationInput } from "../effects/declarations.ts";
import { upstreamTransport, type CredentialScope } from "../effects/context.ts";
import { McpReadError, McpSession, type McpTransportKind } from "./client.ts";
import { randomUUID, randomBytes } from "node:crypto";
import { redis } from "../../lib/redis.ts";
import { endUserIdFor, parseEndUserId, requireConnectionProvider, type ConsentOutcome } from "../connections/provider.ts";
import { createUpstreamConnectLink } from "../end-users/connect.ts";
import {
  resolveClient,
  discoverUpstreamOAuth,
  oauthHeaderFor,
  oauthSecretName,
  oauthRequired,
  upstreamIntegrationKey,
  upstreamRedirectUri,
  upstreamRowIdOf,
  upstreamToken,
  type PreRegisteredClient,
} from "./oauth.ts";
import { assertNoHeaderTwice,
  endUserKeyHeader, endUserKeySecretName, liveEndUserUpstream, readUpstreamKey, withEndUserKeyRef, withoutEndUserKeyHeader,
} from "./end-user-key.ts";
import {
  CHECK_LEASE_MS,
  changeAlert,
  diffListing,
  listingCredential,
  markAlerted,
  nextCheckDelayMs,
  openChanges,
  type AdoptedPin,
} from "./tool-changes.ts";

const logger = createLogger({ module: "mcp-upstreams" });

export const UPSTREAM_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_HEADERS = 20;

const CREDENTIAL_HEADER_NAMES = /^(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-access-token|x-token|cookie)$/i;
const CREDENTIAL_HEADER_WORDS = /token|secret|password|passwd|credential|api-?key/i;

export function isCredentialHeaderName(name: string): boolean {
  return CREDENTIAL_HEADER_NAMES.test(name) || CREDENTIAL_HEADER_WORDS.test(name);
}

export interface RegisterUpstreamInput {
  name: string;
  url: string;
  headers?: Record<string, string>;
  registryName?: string | null;
  oauth?: PreRegisteredClient | null;
  endUserKey?: { header: string } | null;
}

export interface AdoptChoice {
  requiresApproval?: boolean;
  impact?: ImpactDeclarationInput | null;
  description?: string;
  toolHash?: string;
}

export type AdoptedState = "current" | "changed" | "missing";

export interface SchemaCheckView {
  schemaCheck: SchemaCheck;
  schemaCheckReason: LooseReason | null;
}

export type UpstreamToolView = McpToolSnapshot & SchemaCheckView;

export interface AdoptedTool extends SchemaCheckView {
  tool: string;
  action: string;
  actionId: string;
  enabled: boolean;
  state: AdoptedState;
  toolHash: string;
  requiresApproval: boolean;
}

export interface UpstreamView {
  id: string;
  name: string;
  url: string;
  headers: Record<string, string>;
  registryName: string | null;
  protocolVersion: string | null;
  transport: McpUpstream["transport"];
  serverInfo: McpUpstream["serverInfo"];
  tools: UpstreamToolView[];
  toolsHash: string | null;
  listedAt: Date | null;
  lastError: McpUpstream["lastError"];
  listedWith: McpUpstream["listedWith"];
  check: UpstreamCheckView;
  changes: McpToolChange[];
  oauth: (Omit<NonNullable<McpUpstream["oauth"]>, "clientSecretName" | "clientRegistration"> & {
    clientRegistration: "pre_registered" | "client_metadata_document" | "dynamic";
    publicClient: boolean;
    redirectUri: string;
    operatorConnected: boolean;
  }) | null;
  endUserKey: { header: string; integration: string } | null;
  adopted: AdoptedTool[];
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpstreamCheckView {
  status: "ok" | "failed" | "needs_sign_in" | "pending";
  checkedAt: Date | null;
  nextCheckAt: Date | null;
  failures: number;
}

export interface AdoptResult {
  adopted: Array<{ tool: string; action: ActionView; readopted: boolean }>;
  skipped: Array<{ tool: string; reason: string }>;
}

interface Listing {
  protocolVersion: string;
  transport: McpTransportKind;
  serverInfo: McpUpstream["serverInfo"];
  tools: McpToolSnapshot[];
  toolsHash: string;
}

class UpstreamAsksSignIn extends ValidationError {
  constructor(readonly challenge: string, message: string) {
    super(message);
    this.name = "UpstreamAsksSignIn";
  }
}

function listingError(error: unknown): ValidationError {
  if (error instanceof McpReadError && error.status === 401) {
    return new UpstreamAsksSignIn(
      error.wwwAuthenticate ?? "",
      "The server asks for a sign-in (HTTP 401). If it signs people in with OAuth, register it with the OAuth client you registered with the vendor; otherwise put its credential in a header as a {{secret:NAME}} reference.",
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ValidationError(`The server's tools could not be listed: ${message.replace(/ The tool was not called; nothing was sent\.$/, "")}`);
}

export function parseListedTools(raw: unknown[]): McpTool[] {
  const tools = parseToolsList({ tools: raw });
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new ValidationError(`The server lists two tools named ${tool.name}. Anlyon cannot tell which one an agent would call.`);
    names.add(tool.name);
  }
  if (hasUnstorableText(tools)) {
    throw new ValidationError("A tool this server lists holds a NUL character or a broken Unicode sequence, which Anlyon cannot store. Nothing was changed.");
  }
  return tools;
}

async function listUpstream(
  scope: CredentialScope, url: string, headers: Record<string, string>,
  oauth?: { headers: Record<string, string>; secrets: ReadonlyMap<string, string> },
  known: McpTransportKind | null = null,
): Promise<Listing> {
  let session: McpSession | null = null;
  try {
    const transport = await upstreamTransport(scope, url, headers, oauth?.secrets);
    session = new McpSession(transport, url, { ...headers, ...oauth?.headers }, { transport: known ?? "auto" });
    const info = await session.initialize();
    const raw = await session.listTools();
    const tools = parseListedTools(raw);
    const scan = await scanTools(tools);
    const snapshot: McpToolSnapshot[] = await Promise.all(tools.map(async (tool, i) => ({
      name: tool.name,
      hash: await hashTools([tool]),
      definition: tool as unknown as Record<string, unknown>,
      suggestedClass: scan.tools[i]!.class,
      reasons: scan.tools[i]!.reasons,
    })));
    return { protocolVersion: info.protocolVersion, transport: session.transportKind, serverInfo: info.serverInfo, tools: snapshot, toolsHash: scan.hash };
  } catch (error) {
    if (error instanceof ValidationError && !(error instanceof McpReadError)) throw error;
    throw listingError(error);
  } finally {
    session?.close();
  }
}

async function adoptedFrom(upstream: McpUpstream): Promise<AdoptedTool[]> {
  const rows = await db.select().from(actions).where(and(
    eq(actions.workspaceId, upstream.workspaceId),
    eq(actions.environmentId, upstream.environmentId),
    isNull(actions.archivedAt),
    sql`${actions.mcp} ->> 'upstreamId' = ${upstream.upstreamId}`,
  ));
  const listed = new Map(upstream.tools.map((tool) => [tool.name, tool.hash]));
  return rows.map((row) => {
    const binding = row.mcp!;
    const now = listed.get(binding.toolName);
    return {
      tool: binding.toolName,
      action: row.name,
      actionId: row.actionId,
      enabled: row.enabled,
      state: now === undefined ? "missing" : now === binding.toolHash ? "current" : "changed",
      toolHash: binding.toolHash,
      requiresApproval: row.requiresApproval,
      schemaCheck: binding.schemaCheck === "loose" ? "loose" : "full",
      schemaCheckReason: binding.schemaCheck === "loose" ? ((binding.schemaCheckReason ?? "invalid_schema") as LooseReason) : null,
    };
  });
}

export function schemaCheckOfTool(tool: Pick<McpToolSnapshot, "definition">): SchemaCheckView {
  const schema = ((tool.definition as unknown as McpTool).inputSchema ?? {}) as Record<string, unknown>;
  const assessed = assessMcpSchema(schema);
  return { schemaCheck: assessed.check, schemaCheckReason: assessed.reason };
}

function checkViewOf(upstream: McpUpstream): UpstreamCheckView {
  const cannot = listingCredential(upstream) === "none";
  return {
    status: cannot ? "needs_sign_in" : upstream.lastError ? "failed" : upstream.checkedAt ? "ok" : "pending",
    checkedAt: upstream.checkedAt,
    nextCheckAt: cannot ? null : upstream.nextCheckAt,
    failures: upstream.checkFailures,
  };
}

async function toView(upstream: McpUpstream): Promise<UpstreamView> {
  const adopted = await adoptedFrom(upstream);
  return {
    id: upstream.upstreamId,
    name: upstream.name,
    url: upstream.url,
    headers: upstream.headers,
    registryName: upstream.registryName,
    protocolVersion: upstream.protocolVersion,
    transport: upstream.transport,
    serverInfo: upstream.serverInfo,
    tools: upstream.tools.map((tool) => ({ ...tool, ...schemaCheckOfTool(tool) })),
    toolsHash: upstream.toolsHash,
    listedAt: upstream.listedAt,
    lastError: upstream.lastError,
    listedWith: upstream.listedWith,
    check: checkViewOf(upstream),
    changes: openChanges(upstream.toolChanges ?? null, adopted),
    oauth: upstream.oauth ? {
      resource: upstream.oauth.resource,
      issuer: upstream.oauth.issuer,
      authorizationServers: upstream.oauth.authorizationServers ?? [upstream.oauth.issuer],
      authorizationEndpoint: upstream.oauth.authorizationEndpoint,
      tokenEndpoint: upstream.oauth.tokenEndpoint,
      scopesSupported: upstream.oauth.scopesSupported,
      scopes: upstream.oauth.scopes,
      clientId: upstream.oauth.clientId,
      clientRegistration: upstream.oauth.clientRegistration ?? "pre_registered",
      advertised: upstream.oauth.advertised,
      publicClient: upstream.oauth.clientSecretName === null,
      redirectUri: upstreamRedirectUri(),
      operatorConnected: upstream.operatorConnectionId !== null,
    } : null,
    endUserKey: upstream.endUserKey ? { header: upstream.endUserKey.header, integration: upstreamIntegrationKey(upstream.id) } : null,
    adopted,
    archivedAt: upstream.archivedAt,
    createdAt: upstream.createdAt,
    updatedAt: upstream.updatedAt,
  };
}

async function findUpstream(workspaceId: string, environmentId: string, id: string): Promise<McpUpstream> {
  const [row] = await db.select().from(mcpUpstreams).where(and(
    eq(mcpUpstreams.workspaceId, workspaceId),
    eq(mcpUpstreams.environmentId, environmentId),
    eq(mcpUpstreams.upstreamId, id),
  ));
  if (!row) throw new NotFoundError("MCP upstream");
  return row;
}

export async function listUpstreams(workspaceId: string, environmentId: string): Promise<UpstreamView[]> {
  const rows = await db.select().from(mcpUpstreams).where(and(
    eq(mcpUpstreams.workspaceId, workspaceId),
    eq(mcpUpstreams.environmentId, environmentId),
    isNull(mcpUpstreams.archivedAt),
  )).orderBy(mcpUpstreams.name);
  return Promise.all(rows.map(toView));
}

export async function getUpstream(workspaceId: string, environmentId: string, id: string): Promise<UpstreamView> {
  return toView(await findUpstream(workspaceId, environmentId, id));
}

export function checkEndpoint(input: string): string {
  const url = input.trim();
  if (hasInputRef(url) || usesAccountHost(url) || url.includes("{{")) {
    throw new ValidationError("A server's endpoint is fixed: it takes no placeholder.");
  }
  declaredHost(url);
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.hash) {
    throw new ValidationError("A server's endpoint carries no credentials and no fragment. Put the credential in a header as a {{secret:NAME}} reference.");
  }
  return url;
}

function checkRegistration(input: RegisterUpstreamInput): { url: string; headers: Record<string, string>; endUserKey: { header: string } | null } {
  if (!UPSTREAM_NAME.test(input.name)) {
    throw new ValidationError("A server's name is 1 to 32 lowercase letters, digits and hyphens, starting with a letter.");
  }
  const url = checkEndpoint(input.url);
  const headers = input.headers ?? {};
  if (Object.keys(headers).length > MAX_HEADERS) throw new ValidationError(`An upstream takes at most ${MAX_HEADERS} headers.`);
  assertNoHeaderTwice(headers);
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new ValidationError(`Header ${name} is not a valid header name.`);
    if (typeof value !== "string") throw new ValidationError(`Header ${name} must be text.`);
    if (hasInputRef(value) || usesAccountHost(value)) throw new ValidationError(`Header ${name} is fixed: it takes no input.`);
    if (/\{\{\s*connection:/.test(value)) throw new ValidationError(`Header ${name} may not name a connection. For a server that signs people in, register it with OAuth.`);
    if (isCredentialHeaderName(name) && !/\{\{secret:[A-Za-z0-9_]+\}\}/.test(value)) {
      throw new ValidationError(`Header ${name} carries a credential: write it as a {{secret:NAME}} reference, never as a value.`);
    }
  }
  let endUserKey: { header: string } | null = null;
  if (input.endUserKey) {
    if (input.oauth) throw new ValidationError("A server either signs people in with OAuth or takes each end user's own key, not both. Leave out endUserKey or oauth.");
    endUserKey = { header: endUserKeyHeader(headers, input.endUserKey.header).header };
  }
  return { url, headers, endUserKey };
}

export function registrationSecrets(input: Pick<RegisterUpstreamInput, "headers" | "oauth">): string[] {
  return extractSecretNames(input.headers ?? {}, input.oauth?.clientSecret ?? null);
}

export async function planRegistration(
  workspaceId: string, environmentId: string, input: RegisterUpstreamInput,
): Promise<{ host: string; secrets: { name: string; allowedHosts: string[] | null }[] } | null> {
  let host: string;
  try {
    const { url } = checkRegistration(input);
    host = new URL(url).hostname.toLowerCase();
  } catch (error) {
    if (error instanceof ValidationError) return null;
    throw error;
  }
  const [taken] = await db.select({ id: mcpUpstreams.id }).from(mcpUpstreams).where(and(
    eq(mcpUpstreams.workspaceId, workspaceId),
    eq(mcpUpstreams.environmentId, environmentId),
    eq(mcpUpstreams.name, input.name),
    isNull(mcpUpstreams.archivedAt),
  ));
  if (taken) return null;
  const names = extractSecretNames(input.headers ?? {});
  try {
    await assertSecretsMayReachHost(workspaceId, names, `https://${host}/`, environmentId);
    const policies = await loadSecretPolicies(workspaceId, names, environmentId);
    return { host, secrets: names.map((name) => ({ name, allowedHosts: policies.get(name)?.allowedHosts ?? null })) };
  } catch (error) {
    if (error instanceof ApiError) return null;
    throw error;
  }
}

export async function registerUpstream(
  workspaceId: string, environmentId: string, input: RegisterUpstreamInput, authority: CallerAuthority,
  options: { signedOff?: boolean } = {},
): Promise<UpstreamView> {
  assertMayReferenceSecrets(authority, registrationSecrets(input));
  const { url, headers, endUserKey } = checkRegistration(input);
  const headerSecrets = extractSecretNames(headers);
  if (headerSecrets.length > 0) await assertSecretsMayReachHost(workspaceId, headerSecrets, url, environmentId);
  const [taken] = await db.select({ id: mcpUpstreams.id }).from(mcpUpstreams).where(and(
    eq(mcpUpstreams.workspaceId, workspaceId),
    eq(mcpUpstreams.environmentId, environmentId),
    eq(mcpUpstreams.name, input.name),
    isNull(mcpUpstreams.archivedAt),
  ));
  if (taken) throw new ConflictError(`An MCP upstream named "${input.name}" already exists in this environment.`);
  if ((input.oauth || headerSecrets.length > 0) && authority.scopes !== null && !options.signedOff) {
    throw new AuthorizationError("Registering this server sends a stored credential or signs people in with OAuth, so it needs a person's sign-off. Nothing was registered.");
  }
  const scope = { workspaceId, environmentId };
  if (input.oauth) return registerOAuthUpstream(scope, input, url, headers, input.oauth);

  let listing: Listing;
  try {
    listing = await listUpstream(scope, url, headers);
  } catch (error) {
    if (error instanceof UpstreamAsksSignIn) {
      const discovered = await discoverUpstreamOAuth(url, error.challenge).catch(() => null);
      if (discovered) oauthRequired(discovered);
    }
    throw error;
  }
  const [row] = await db.insert(mcpUpstreams).values({
    upstreamId: generateMcpUpstreamId(),
    workspaceId,
    environmentId,
    name: input.name,
    url,
    headers,
    registryName: input.registryName ?? null,
    protocolVersion: listing.protocolVersion,
    transport: listing.transport,
    serverInfo: listing.serverInfo,
    tools: listing.tools,
    toolsHash: listing.toolsHash,
    listedAt: new Date(),
    listedWith: Object.keys(headers).length > 0 ? "headers" : "anonymous",
    checkedAt: new Date(),
    nextCheckAt: nextCheckAt(new Date(), 0),
    endUserKey,
  }).returning();
  logger.info({ workspaceId, upstreamId: row!.upstreamId, tools: listing.tools.length, endUserKey: Boolean(endUserKey) }, "MCP upstream registered");
  return toView(row!);
}

async function oauthChallengeOf(scope: CredentialScope, url: string, headers: Record<string, string>): Promise<string | null> {
  const session = new McpSession(await upstreamTransport(scope, url, headers), url, headers, { transport: "auto" });
  try {
    await session.initialize();
    return null;
  } catch (error) {
    if (!(error instanceof McpReadError)) throw error;
    return error.status === 401 ? error.wwwAuthenticate ?? "" : null;
  } finally {
    session.close();
  }
}

async function registerOAuthUpstream(
  scope: { workspaceId: string; environmentId: string },
  input: RegisterUpstreamInput,
  url: string,
  headers: Record<string, string>,
  client: PreRegisteredClient,
): Promise<UpstreamView> {
  if (Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) {
    throw new ValidationError("An OAuth upstream's Authorization header is each caller's own token: leave it out of the headers.");
  }
  const challenge = await oauthChallengeOf(scope, url, headers);
  const discovered = await discoverUpstreamOAuth(url, challenge, client.authorizationServer ?? null);
  const listing = challenge === null ? await listUpstream(scope, url, headers).catch(() => null) : null;
  const resolved = await resolveClient(scope, client, discovered, input.name);
  const { clientId, clientSecretName, clientRegistration } = resolved;
  const { endpoint: _endpoint, ...metadata } = discovered;
  const scopes = client.scopes && client.scopes.length > 0 ? client.scopes : discovered.scopesSupported;
  const id = randomUUID();
  let row: McpUpstream | undefined;
  try {
    [row] = await db.insert(mcpUpstreams).values({
      id,
      upstreamId: generateMcpUpstreamId(),
      workspaceId: scope.workspaceId,
      environmentId: scope.environmentId,
      name: input.name,
      url,
      headers,
      registryName: input.registryName ?? null,
      protocolVersion: listing?.protocolVersion ?? null,
      transport: listing?.transport ?? null,
      serverInfo: listing?.serverInfo ?? null,
      tools: listing?.tools ?? [],
      toolsHash: listing?.toolsHash ?? null,
      listedAt: listing ? new Date() : null,
      listedWith: listing ? "anonymous" : null,
      checkedAt: listing ? new Date() : null,
      nextCheckAt: nextCheckAt(new Date(), 0),
      oauth: {
        ...metadata,
        scopes,
        clientId,
        clientSecretName,
        clientRegistration,
        ...(resolved.tokenEndpointAuthMethod ? { tokenEndpointAuthMethod: resolved.tokenEndpointAuthMethod } : {}),
        ...(resolved.clientSecretExpiresAt ? { clientSecretExpiresAt: resolved.clientSecretExpiresAt } : {}),
      },
    }).returning();
  } catch (error) {
    if (resolved.createdSecret) {
      await deleteSecret(scope.workspaceId, resolved.createdSecret, scope.environmentId, { confirmProtected: true }).catch((cleanup: unknown) => {
        logger.error({ secret: resolved.createdSecret, error: cleanup instanceof Error ? cleanup.message : String(cleanup) }, "Removing an unused dynamic client secret failed");
      });
    }
    throw error;
  }
  logger.info({ workspaceId: scope.workspaceId, upstreamId: row!.upstreamId, issuer: discovered.issuer, clientRegistration, listed: Boolean(listing) }, "MCP upstream registered (OAuth)");
  return toView(row!);
}

class OperatorSignInError extends ValidationError {}

async function listWithCredential(upstream: McpUpstream): Promise<{ listing: Listing; listedWith: NonNullable<McpUpstream["listedWith"]> }> {
  const scope = { workspaceId: upstream.workspaceId, environmentId: upstream.environmentId };
  if (upstream.oauth && upstream.operatorConnectionId) {
    let token: string;
    try {
      token = await upstreamToken({ ...scope, endUserId: null }, upstream);
    } catch (error) {
      throw new OperatorSignInError(error instanceof Error ? error.message.replace(/ Nothing was sent\.$/, "") : "The operator's sign-in could not be used.");
    }
    const listing = await listUpstream(scope, upstream.url, upstream.headers, {
      headers: oauthHeaderFor(upstream.id), secrets: new Map([[oauthSecretName(upstream.id), token]]),
    }, upstream.transport);
    return { listing, listedWith: "operator" };
  }
  const listing = await listUpstream(scope, upstream.url, upstream.headers, undefined, upstream.transport);
  return { listing, listedWith: upstream.oauth || Object.keys(upstream.headers).length === 0 ? "anonymous" : "headers" };
}

export function toolCheckIntervalMs(): number {
  const hours = Number(instanceSetting("mcp.tool_check_interval_hours"));
  const valid = Number.isInteger(hours) && hours >= 1 && hours <= MCP_TOOL_CHECK_INTERVAL_MAX_HOURS;
  return (valid ? hours : MCP_TOOL_CHECK_INTERVAL_DEFAULT_HOURS) * 60 * 60_000;
}

const nextCheckAt = (now: Date, failures: number) => new Date(now.getTime() + nextCheckDelayMs(toolCheckIntervalMs(), failures));

type DbReader = Pick<typeof db, "select">;

async function adoptedPins(reader: DbReader, upstream: McpUpstream): Promise<AdoptedPin[]> {
  const rows = await reader.select({ name: actions.name, actionId: actions.actionId, mcp: actions.mcp }).from(actions).where(and(
    eq(actions.workspaceId, upstream.workspaceId),
    eq(actions.environmentId, upstream.environmentId),
    isNull(actions.archivedAt),
    sql`${actions.mcp} ->> 'upstreamId' = ${upstream.upstreamId}`,
  ));
  return rows.map((row) => ({ tool: row.mcp!.toolName, action: row.name, actionId: row.actionId, toolHash: row.mcp!.toolHash }));
}

async function recordListing(
  upstream: McpUpstream, listing: Listing, listedWith: NonNullable<McpUpstream["listedWith"]>, source: "scheduled" | "refresh",
): Promise<McpUpstream> {
  const now = new Date();
  const recorded = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(mcpUpstreams).where(eq(mcpUpstreams.id, upstream.id)).for("update");
    if (!current || current.archivedAt) return null;
    const diff = diffListing({
      pins: await adoptedPins(tx, current),
      previousTools: current.tools,
      compareAdded: current.listedAt !== null && current.listedWith === listedWith,
      listed: listing.tools,
      stored: current.toolChanges ?? null,
      now,
    });
    const rewrite = source === "refresh" || current.toolsHash !== listing.toolsHash;
    const [row] = await tx.update(mcpUpstreams).set({
      listedWith,
      transport: listing.transport,
      listedAt: now,
      checkedAt: now,
      checkFailures: 0,
      lastError: null,
      toolChanges: diff.changes,
      nextCheckAt: diff.alert.length > 0 ? new Date(now.getTime() + CHECK_LEASE_MS) : nextCheckAt(now, 0),
      ...(rewrite ? {
        protocolVersion: listing.protocolVersion,
        serverInfo: listing.serverInfo,
        tools: listing.tools,
        toolsHash: listing.toolsHash,
        updatedAt: now,
      } : {}),
    }).where(eq(mcpUpstreams.id, current.id)).returning();
    if (diff.fresh.length > 0) {
      const of = (kind: McpToolChange["kind"]) => diff.fresh.filter((item) => item.kind === kind).map((item) => ({
        tool: item.tool.slice(0, 200), action: item.action, pinnedHash: item.pinnedHash, currentHash: item.currentHash,
      }));
      await writeAuditEvents(tx, [{
        workspaceId: current.workspaceId,
        environmentId: current.environmentId,
        type: "mcp_upstream.tools_changed",
        resource: { type: "mcp_upstream", id: current.upstreamId },
        data: { name: current.name, source, toolsHash: listing.toolsHash, changed: of("changed"), removed: of("removed"), added: of("added") },
      }]);
    }
    return { row: row!, alert: diff.alert };
  });
  if (!recorded) return findUpstreamById(upstream.id);
  return recorded.alert.length > 0 ? deliverChangeAlert(recorded.row, recorded.alert) : recorded.row;
}

async function findUpstreamById(id: string): Promise<McpUpstream> {
  const [row] = await db.select().from(mcpUpstreams).where(eq(mcpUpstreams.id, id));
  if (!row) throw new NotFoundError("MCP upstream");
  return row;
}

async function deliverChangeAlert(row: McpUpstream, items: McpToolChange[]): Promise<McpUpstream> {
  try {
    const [environment] = await db.select({ slug: environments.slug }).from(environments).where(eq(environments.id, row.environmentId));
    await createAndSendNotification({ workspaceId: row.workspaceId, type: "security_alert", ...changeAlert(row, environment?.slug ?? "unknown", items) });
  } catch (error) {
    logger.warn({ upstreamId: row.upstreamId, error: error instanceof Error ? error.message : String(error) }, "An MCP tool change alert could not be sent; the next check tries again");
    return row;
  }
  const now = new Date();
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(mcpUpstreams).where(eq(mcpUpstreams.id, row.id)).for("update");
    if (!current) return row;
    const [updated] = await tx.update(mcpUpstreams).set({
      toolChanges: markAlerted(current.toolChanges ?? null, items),
      nextCheckAt: nextCheckAt(now, 0),
    }).where(eq(mcpUpstreams.id, row.id)).returning();
    return updated!;
  });
}

async function recordFailedCheck(upstream: McpUpstream, error: ValidationError): Promise<McpUpstream> {
  const now = new Date();
  const failures = upstream.checkFailures + 1;
  const [row] = await db.update(mcpUpstreams).set({
    lastError: {
      code: error instanceof OperatorSignInError ? "sign_in_failed" : "listing_failed",
      message: error.message.slice(0, 500),
      at: now.toISOString(),
    },
    checkedAt: now,
    checkFailures: failures,
    nextCheckAt: nextCheckAt(now, failures),
    updatedAt: now,
  }).where(eq(mcpUpstreams.id, upstream.id)).returning();
  return row ?? upstream;
}

export async function checkUpstream(upstream: McpUpstream, source: "scheduled" | "refresh"): Promise<McpUpstream> {
  let listed: Awaited<ReturnType<typeof listWithCredential>>;
  try {
    listed = await listWithCredential(upstream);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return recordFailedCheck(upstream, error);
  }
  return recordListing(upstream, listed.listing, listed.listedWith, source);
}

export async function refreshUpstream(workspaceId: string, environmentId: string, id: string): Promise<UpstreamView> {
  const upstream = await findUpstream(workspaceId, environmentId, id);
  if (upstream.archivedAt) throw new ValidationError("This upstream is archived.");
  return toView(await checkUpstream(upstream, "refresh"));
}

export function adoptedActionName(upstream: string, tool: string): string {
  return `${upstream}-${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 100);
}

export interface PlannedAdoption {
  tool: string;
  action: string;
  readopted: boolean;
  hash: string;
  fromHash: string | null;
  suggestedClass: string;
  reasons: readonly unknown[];
  schemaCheck: SchemaCheck;
  schemaCheckReason: LooseReason | null;
  requiresApproval: boolean;
  impact: AdoptChoice["impact"] | null;
  description: string | null;
  requestedDescription: string | null;
  parameters: string[];
}

export async function planAdoption(
  workspaceId: string, environmentId: string, id: string, choices: Record<string, AdoptChoice>,
): Promise<{ upstream: { id: string; name: string }; tools: PlannedAdoption[] } | null> {
  const [upstream] = await db.select().from(mcpUpstreams).where(and(
    eq(mcpUpstreams.workspaceId, workspaceId),
    eq(mcpUpstreams.environmentId, environmentId),
    eq(mcpUpstreams.upstreamId, id),
  ));
  if (!upstream || upstream.archivedAt) return null;
  const listed = new Map(upstream.tools.map((tool) => [tool.name, tool]));
  const names = Object.keys(choices);
  if (names.length === 0 || names.some((name) => !listed.has(name))) return null;
  const existing = new Map((await adoptedFrom(upstream)).map((adopted) => [adopted.tool, adopted]));
  const tools: PlannedAdoption[] = [];
  for (const name of names.sort()) {
    const tool = listed.get(name)!;
    const before = existing.get(name);
    if (before?.state === "current") continue;
    const choice = choices[name] ?? {};
    const definition = tool.definition as unknown as McpTool;
    const properties = (definition.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    const serverDescription = (definition.description ?? "").slice(0, 1000) || null;
    const requestedDescription = before ? null : ((choice.description ?? "").slice(0, 1000) || null);
    tools.push({
      tool: name,
      action: before?.action ?? adoptedActionName(upstream.name, name),
      readopted: Boolean(before),
      hash: tool.hash,
      fromHash: before?.toolHash ?? null,
      suggestedClass: tool.suggestedClass,
      reasons: tool.reasons,
      ...schemaCheckOfTool(tool),
      requiresApproval: before ? before.requiresApproval : (choice.requiresApproval ?? false),
      impact: before ? null : (choice.impact ?? null),
      description: serverDescription,
      requestedDescription: requestedDescription !== serverDescription ? requestedDescription : null,
      parameters: properties ? Object.keys(properties).slice(0, 50) : [],
    });
  }
  return { upstream: { id: upstream.upstreamId, name: upstream.name }, tools };
}

export async function assertMayAdopt(workspaceId: string, environmentId: string, id: string, authority: CallerAuthority): Promise<void> {
  const upstream = await findUpstream(workspaceId, environmentId, id);
  assertMayReferenceSecrets(authority, extractSecretNames(upstream.headers));
}

export async function adoptTools(
  workspaceId: string,
  environmentId: string,
  id: string,
  choices: Record<string, AdoptChoice>,
  authority: CallerAuthority,
  options: { signedOff?: boolean } = {},
): Promise<AdoptResult> {
  const upstream = await findUpstream(workspaceId, environmentId, id);
  if (upstream.archivedAt) throw new ValidationError("This upstream is archived.");
  const names = Object.keys(choices);
  if (names.length === 0) throw new ValidationError("Name at least one tool to adopt.");
  const listed = new Map(upstream.tools.map((tool) => [tool.name, tool]));
  const unknown = names.filter((name) => !listed.has(name));
  if (unknown.length > 0) {
    throw new ValidationError(`Not in the last listing of ${upstream.name}: ${unknown.join(", ")}. Refresh the upstream if the server added them.`);
  }
  const existing = new Map((await adoptedFrom(upstream)).map((adopted) => [adopted.tool, adopted]));

  const result: AdoptResult = { adopted: [], skipped: [] };
  for (const name of names) {
    const tool = listed.get(name)!;
    const choice = choices[name] ?? {};
    if (choice.toolHash !== undefined && choice.toolHash !== tool.hash) {
      result.skipped.push({ tool: name, reason: "The server's definition of this tool changed since you read it. Read it again, then adopt it." });
      continue;
    }
    const definition = tool.definition as unknown as McpTool;
    const inputSchema = (definition.inputSchema ?? {}) as Record<string, unknown>;
    const assessed = assessMcpSchema(inputSchema);
    const binding: ActionMcpBinding = {
      upstreamId: upstream.upstreamId, toolName: name, toolHash: tool.hash, suggestedClass: tool.suggestedClass,
      ...(upstream.oauth ? { oauthConnection: upstreamIntegrationKey(upstream.id) } : {}),
      ...(upstream.endUserKey ? { endUserKey: { connection: upstreamIntegrationKey(upstream.id), header: upstream.endUserKey.header } } : {}),
      schemaCheck: assessed.check,
      ...(assessed.check === "loose" ? { schemaCheckReason: assessed.reason } : {}),
    };
    try {
      const before = existing.get(name);
      if (before?.state === "current") {
        result.skipped.push({ tool: name, reason: `Already adopted as ${before.action}, and unchanged.` });
        continue;
      }
      if (authority.scopes !== null && !options.signedOff) {
        throw new AuthorizationError("Adopting a tool needs a person's sign-off. Nothing was adopted.");
      }
      if (before) {
        const action = await readoptMcpTool(workspaceId, before.actionId, { inputSchema, mcp: binding }, authority, environmentId, options);
        result.adopted.push({ tool: name, action, readopted: true });
        continue;
      }
      const action = await createAction(workspaceId, {
        name: adoptedActionName(upstream.name, name),
        description: (choice.description ?? definition.description ?? "").slice(0, 1000) || undefined,
        method: "POST",
        urlTemplate: upstream.url,
        headers: upstream.headers,
        inputSchema,
        requiresApproval: choice.requiresApproval ?? false,
        impact: choice.impact ?? null,
        mcp: binding,
      }, authority, environmentId);
      result.adopted.push({ tool: name, action, readopted: false });
    } catch (error) {
      if (!(error instanceof ValidationError) && !(error instanceof ConflictError)) throw error;
      result.skipped.push({ tool: name, reason: error.message });
    }
  }
  logger.info({ workspaceId, upstreamId: upstream.upstreamId, adopted: result.adopted.length, skipped: result.skipped.length }, "MCP tools adopted");
  return result;
}

const OPERATOR_CONSENT_TTL_MS = 10 * 60_000;
const operatorConsentKey = (tag: string) => `mcp-upstreams:operator-consent:${tag}`;
const alnum = (n: number) => randomBytes(n * 2).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, n);

async function findOAuthUpstream(workspaceId: string, environmentId: string, id: string): Promise<McpUpstream> {
  const upstream = await findUpstream(workspaceId, environmentId, id);
  if (upstream.archivedAt) throw new ValidationError("This upstream is archived.");
  if (!upstream.oauth) throw new ValidationError("This upstream does not sign people in with OAuth.");
  return upstream;
}

export async function connectUpstream(workspaceId: string, environmentId: string, id: string): Promise<{ url: string; expiresAt: Date; redirectUri: string }> {
  const upstream = await findOAuthUpstream(workspaceId, environmentId, id);
  const provider = requireConnectionProvider();
  const tag = endUserIdFor(workspaceId, environmentId, `mco_${alnum(24)}`);
  const minted = await provider.createConnectSession({ endUserId: tag, integrationKey: upstreamIntegrationKey(upstream.id), ttlMs: OPERATOR_CONSENT_TTL_MS });
  await redis.set(operatorConsentKey(tag), upstream.id, "PX", OPERATOR_CONSENT_TTL_MS);
  return { url: provider.connectUrl(minted.sessionToken), expiresAt: minted.expiresAt, redirectUri: upstreamRedirectUri() };
}

export async function recordOperatorConsent(outcome: ConsentOutcome): Promise<"connected" | "stray"> {
  const rowId = upstreamRowIdOf(outcome.integrationKey);
  const scope = parseEndUserId(outcome.endUserId);
  const claimed = scope ? await redis.getdel(operatorConsentKey(outcome.endUserId)) : null;
  const [upstream] = rowId && scope && claimed === rowId
    ? await db.select().from(mcpUpstreams).where(and(
      eq(mcpUpstreams.id, rowId), eq(mcpUpstreams.workspaceId, scope.workspaceId), eq(mcpUpstreams.environmentId, scope.environmentId), isNull(mcpUpstreams.archivedAt),
    ))
    : [];
  const provider = requireConnectionProvider();
  if (!upstream) {
    await provider.deleteConnection({ integrationKey: outcome.integrationKey, connectionId: outcome.connectionId }).catch(() => undefined);
    logger.warn({ integrationKey: outcome.integrationKey }, "An upstream consent no operator started was revoked");
    return "stray";
  }
  const previous = upstream.operatorConnectionId;
  try {
    await db.update(mcpUpstreams).set({ operatorConnectionId: outcome.connectionId, updatedAt: new Date() }).where(eq(mcpUpstreams.id, upstream.id));
  } catch (error) {
    await provider.deleteConnection({ integrationKey: outcome.integrationKey, connectionId: outcome.connectionId }).catch(() => undefined);
    logger.error({ upstreamId: upstream.upstreamId, error: error instanceof Error ? error.message : String(error) }, "Binding an operator's upstream grant failed; the grant was revoked");
    throw error;
  }
  if (previous && previous !== outcome.connectionId) {
    await provider.deleteConnection({ integrationKey: outcome.integrationKey, connectionId: previous }).catch(() => undefined);
  }
  logger.info({ workspaceId: upstream.workspaceId, upstreamId: upstream.upstreamId }, "MCP upstream connected by an operator");
  await refreshUpstream(upstream.workspaceId, upstream.environmentId, upstream.upstreamId);
  return "connected";
}

export async function upstreamDisplayName(integrationKey: string): Promise<string> {
  const rowId = upstreamRowIdOf(integrationKey);
  const [row] = rowId ? await db.select({ name: mcpUpstreams.name, serverInfo: mcpUpstreams.serverInfo }).from(mcpUpstreams).where(eq(mcpUpstreams.id, rowId)) : [];
  return row?.serverInfo?.title ?? row?.serverInfo?.name ?? row?.name ?? "the MCP server";
}

export async function upstreamKeyDestination(
  integrationKey: string,
  scope: { workspaceId: string; environmentId: string },
): Promise<{ name: string; host: string | null }> {
  const rowId = upstreamRowIdOf(integrationKey);
  const [row] = rowId
    ? await db.select({ name: mcpUpstreams.name, serverInfo: mcpUpstreams.serverInfo, url: mcpUpstreams.url }).from(mcpUpstreams)
      .where(and(eq(mcpUpstreams.id, rowId), eq(mcpUpstreams.workspaceId, scope.workspaceId), eq(mcpUpstreams.environmentId, scope.environmentId)))
    : [];
  let host: string | null = null;
  try { host = row ? new URL(row.url).hostname : null; } catch { host = null; }
  return { name: row?.serverInfo?.title ?? row?.serverInfo?.name ?? row?.name ?? "the MCP server", host };
}

export async function createEndUserConnectLink(
  workspaceId: string, environmentId: string, id: string, input: { endUserId: string; redirectUrl?: string | null },
): Promise<{ url: string; expiresAt: Date }> {
  const upstream = await findUpstream(workspaceId, environmentId, id);
  if (upstream.archivedAt) throw new ValidationError("This upstream is archived.");
  if (!upstream.oauth && !upstream.endUserKey) {
    throw new ValidationError("This upstream's end users do not connect to it: it neither signs people in with OAuth nor takes each end user's own key. Calls to it use the credential in its headers.");
  }
  return createUpstreamConnectLink({ workspaceId, environmentId }, input.endUserId, upstreamIntegrationKey(upstream.id), { redirectUrl: input.redirectUrl ?? null });
}

export async function checkEndUserKey(scope: { workspaceId: string; environmentId: string }, integrationKey: string, given: unknown): Promise<{ key: string; name: string }> {
  const upstream = await liveEndUserUpstream(scope, integrationKey);
  if (!upstream || upstream.connect !== "key" || !upstream.endUserKey) {
    throw new ValidationError("This MCP server does not take an end user's own key.");
  }
  const key = readUpstreamKey(given);
  const name = upstream.name;
  let session: McpSession | null = null;
  try {
    const transport = await upstreamTransport(
      scope, upstream.url, withoutEndUserKeyHeader(upstream.headers, upstream.endUserKey.header),
      new Map([[endUserKeySecretName(integrationKey), key]]),
    );
    session = new McpSession(
      transport, upstream.url, withEndUserKeyRef(upstream.headers, { connection: integrationKey, header: upstream.endUserKey.header }),
      { transport: upstream.transport ?? "auto" },
    );
    await session.initialize();
    await session.listTools();
  } catch (error) {
    if (error instanceof McpReadError && (error.status === 401 || error.status === 403)) throw new ConnectionKeyRejectedError(name);
    logger.warn({ upstreamId: upstream.upstreamId, error: error instanceof Error ? error.message : String(error) }, "An end user's key could not be checked with the MCP server");
    throw new ConnectionKeyCheckFailedError(name);
  } finally {
    session?.close();
  }
  return { key, name };
}

export async function archiveUpstream(
  workspaceId: string, environmentId: string, id: string,
): Promise<UpstreamView & { archivedActions: number }> {
  const upstream = await findUpstream(workspaceId, environmentId, id);
  if (upstream.archivedAt) return { ...(await toView(upstream)), archivedActions: 0 };
  const now = new Date();
  const { row, archivedActions } = await db.transaction(async (tx) => {
    const gone = await tx.update(actions).set({ enabled: false, archivedAt: now, updatedAt: now }).where(and(
      eq(actions.workspaceId, workspaceId),
      eq(actions.environmentId, environmentId),
      isNull(actions.archivedAt),
      sql`${actions.mcp} ->> 'upstreamId' = ${upstream.upstreamId}`,
    )).returning({ id: actions.id });
    const [archived] = await tx.update(mcpUpstreams).set({ archivedAt: now, updatedAt: now }).where(eq(mcpUpstreams.id, upstream.id)).returning();
    return { row: archived!, archivedActions: gone.length };
  });
  logger.info({ workspaceId, upstreamId: upstream.upstreamId, archivedActions }, "MCP upstream archived");
  return { ...(await toView(row)), archivedActions };
}
