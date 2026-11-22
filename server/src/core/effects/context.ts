import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { actionVersions, type ActionAdapterConfig, type ActionMcpBinding } from "../../db/schema/actions.ts";
import { environments } from "../../db/schema/environments.ts";
import { mcpUpstreams } from "../../db/schema/mcp-upstreams.ts";
import { ValidationError } from "../../utils/errors.ts";
import { assertSecretsMayReachHost, loadSecretPolicies, resolveAccountHost, resolveSecrets } from "../actions/secrets.ts";
import type { EndUserContext } from "../end-users/identity.ts";
import { assertSecretDestinationsAllowed } from "../actions/secret-destinations.ts";
import { applyAccountHost, extractSecretNames } from "../actions/template.ts";
import { ACCOUNT_HOST_PLACEHOLDER } from "../connections/catalogue.ts";
import type { AdapterContext, AnyEffectAdapter } from "./adapter.ts";
import { buildDeclaredAdapter, HTTP_DECLARED_TYPE, type DeclaredDefinition } from "./adapters/http-declared.ts";
import { buildMcpToolAdapter, type McpToolDefinition } from "./adapters/mcp-tool.ts";
import type { ActionDeclarations } from "./declarations.ts";
import { getAdapter } from "./registry.ts";
import { adapterTransport, type ProviderTransport } from "./transport.ts";
import { declaredHost } from "./declarations.ts";
import { MCP_MAX_RESPONSE_BYTES } from "../mcp-upstreams/client.ts";

export interface CredentialScope {
  workspaceId: string;
  environmentId: string;
  endUserId?: string | null;
}

const endUserOf = (scope: CredentialScope): EndUserContext => ({ endUserId: scope.endUserId ?? null, required: false });

export interface EnvironmentIdentity {
  id: string;
  name: string;
  kind: string;
}

export async function environmentIdentity(environmentId: string): Promise<EnvironmentIdentity> {
  const [row] = await db.select({ id: environments.id, name: environments.name, kind: environments.kind })
    .from(environments).where(eq(environments.id, environmentId));
  if (!row) throw new ValidationError("Environment not found");
  return { id: row.id, name: row.name, kind: String(row.kind) };
}

export type GovernedSpec =
  | { kind: "adapter"; adapter: ActionAdapterConfig }
  | { kind: "declared"; definition: DeclaredDefinition }
  | { kind: "mcp"; definition: McpToolDefinition };

export interface GovernableDefinition {
  method: string;
  urlTemplate: string;
  headers: unknown;
  bodyTemplate: unknown;
  inputSchema: unknown;
  adapter?: ActionAdapterConfig | null;
  declarations?: ActionDeclarations | null;
  mcp?: ActionMcpBinding | null;
}

export function governedSpecOf(definition: GovernableDefinition): GovernedSpec | null {
  if (definition.adapter) return { kind: "adapter", adapter: definition.adapter };
  if (definition.mcp) {
    return {
      kind: "mcp",
      definition: {
        urlTemplate: definition.urlTemplate,
        headers: (definition.headers as Record<string, unknown> | null) ?? {},
        inputSchema: (definition.inputSchema as Record<string, unknown> | null) ?? {},
        mcp: definition.mcp,
        declarations: definition.declarations ?? null,
      },
    };
  }
  if (!definition.declarations) return null;
  return {
    kind: "declared",
    definition: {
      method: definition.method,
      urlTemplate: definition.urlTemplate,
      headers: (definition.headers as Record<string, unknown> | null) ?? {},
      bodyTemplate: (definition.bodyTemplate as Record<string, unknown> | null) ?? null,
      inputSchema: (definition.inputSchema as Record<string, unknown> | null) ?? {},
      declarations: definition.declarations,
    },
  };
}

export interface VersionAdapter {
  adapter: AnyEffectAdapter;
  config: unknown;
  spec: GovernedSpec;
  requiresApproval: boolean;
}

export function adapterFromSpec(spec: GovernedSpec): { adapter: AnyEffectAdapter; config: unknown } {
  if (spec.kind === "declared") {
    const adapter = buildDeclaredAdapter(spec.definition);
    return { adapter, config: adapter.parseConfig(spec.definition) };
  }
  if (spec.kind === "mcp") {
    const adapter = buildMcpToolAdapter(spec.definition);
    return { adapter, config: adapter.parseConfig(spec.definition) };
  }
  const adapter = getAdapter(spec.adapter.type);
  return { adapter, config: adapter.parseConfig(spec.adapter.config) };
}

export async function loadVersionAdapter(actionRowId: string, actionVersionId: string): Promise<VersionAdapter> {
  const [version] = await db.select().from(actionVersions).where(and(
    eq(actionVersions.actionId, actionRowId), eq(actionVersions.actionVersionId, actionVersionId),
  ));
  const spec = version ? governedSpecOf(version) : null;
  if (!version || !spec) throw new ValidationError(`Action version ${actionVersionId} has no adapter and no declaration.`);
  return { ...adapterFromSpec(spec), spec, requiresApproval: version.requiresApproval };
}

async function declaredSecrets(
  scope: CredentialScope, adapter: AnyEffectAdapter, definition: DeclaredDefinition,
): Promise<{ secrets: Map<string, string>; hosts: string[]; accountHost: string | null }> {
  const verifyUrl = definition.declarations.verify?.url ?? null;
  const names = extractSecretNames(definition.urlTemplate, definition.headers, definition.bodyTemplate, verifyUrl);
  const accountHost = await resolveAccountHost(scope.workspaceId, names, scope.environmentId, endUserOf(scope));
  const hosts = adapter.hosts.map((host) => {
    if (host !== ACCOUNT_HOST_PLACEHOLDER) return host;
    if (!accountHost) throw new ValidationError(`${ACCOUNT_HOST_PLACEHOLDER} needs a connected account with its own host in the same action. Nothing was sent.`);
    return accountHost;
  });
  if (names.length === 0) return { secrets: new Map(), hosts, accountHost };
  for (const host of hosts) {
    await assertSecretsMayReachHost(scope.workspaceId, names, `https://${host}/`, scope.environmentId, accountHost);
  }
  const policies = await loadSecretPolicies(scope.workspaceId, names, scope.environmentId, accountHost);
  assertSecretDestinationsAllowed(applyAccountHost(definition.urlTemplate, accountHost), definition.headers, definition.bodyTemplate, policies);
  if (verifyUrl) assertSecretDestinationsAllowed(applyAccountHost(verifyUrl, accountHost), null, null, policies);
  const secrets = await resolveSecrets(scope.workspaceId, names, scope.environmentId, endUserOf(scope), accountHost);
  return { secrets, hosts, accountHost };
}

export async function configForCall(scope: CredentialScope, adapter: AnyEffectAdapter, config: unknown): Promise<unknown> {
  if (adapter.type !== HTTP_DECLARED_TYPE || !adapter.hosts.includes(ACCOUNT_HOST_PLACEHOLDER)) return config;
  const definition = config as DeclaredDefinition;
  const verify = definition.declarations.verify;
  const names = extractSecretNames(definition.urlTemplate, definition.headers, definition.bodyTemplate, verify?.url ?? null);
  const accountHost = await resolveAccountHost(scope.workspaceId, names, scope.environmentId, endUserOf(scope));
  if (!accountHost) throw new ValidationError(`${ACCOUNT_HOST_PLACEHOLDER} needs a connected account with its own host in the same action. Nothing was sent.`);
  return {
    ...definition,
    urlTemplate: applyAccountHost(definition.urlTemplate, accountHost),
    declarations: { ...definition.declarations, verify: verify ? { ...verify, url: applyAccountHost(verify.url, accountHost) } : verify },
  } satisfies DeclaredDefinition;
}

export async function buildAdapterContext(
  scope: CredentialScope,
  adapter: AnyEffectAdapter,
  config: unknown,
  spec: GovernedSpec,
  purpose: "preview" | "dispatch" = "dispatch",
): Promise<AdapterContext<unknown>> {
  if (spec.kind === "declared" || spec.kind === "mcp") {
    const definition: DeclaredDefinition = spec.kind === "declared" ? spec.definition : {
      method: "POST",
      urlTemplate: spec.definition.urlTemplate,
      headers: spec.definition.headers,
      bodyTemplate: null,
      inputSchema: spec.definition.inputSchema,
      declarations: { impact: spec.definition.declarations?.impact ?? null, verify: null },
    };
    const { secrets, hosts, accountHost } = await declaredSecrets(scope, adapter, definition);
    const oauthConnection = spec.kind === "mcp" ? spec.definition.mcp.oauthConnection : undefined;
    const endUserKey = spec.kind === "mcp" ? spec.definition.mcp.endUserKey : undefined;
    const upstream = purpose !== "dispatch" ? null
      : oauthConnection ? await withUpstreamToken(scope, secrets, oauthConnection)
      : endUserKey ? await withUpstreamKey(scope, secrets, endUserKey, spec.definition.headers as Record<string, string>)
      : null;
    const mcpTransport = spec.kind === "mcp" && purpose === "dispatch" ? await upstreamTransportKind(scope, spec.definition.mcp.upstreamId) : null;
    return {
      config,
      environment: { ...(await environmentIdentity(scope.environmentId)), workspaceId: scope.workspaceId },
      transport: adapterTransport({ ...adapter, hosts }, upstream?.secrets ?? secrets, { accountHost }),
      endUserId: scope.endUserId ?? null,
      ...(upstream?.refreshCredential ? { refreshCredential: upstream.refreshCredential } : {}),
      ...(mcpTransport ? { mcpTransport } : {}),
    };
  }
  const names = [spec.adapter.credentialSecret];
  for (const host of adapter.hosts) {
    await assertSecretsMayReachHost(scope.workspaceId, names, `https://${host}/`, scope.environmentId);
  }
  const secrets = await resolveSecrets(scope.workspaceId, names, scope.environmentId, endUserOf(scope));
  const credential = secrets.get(spec.adapter.credentialSecret);
  if (!credential) throw new ValidationError(`Secret ${spec.adapter.credentialSecret} could not be resolved.`);
  adapter.checkCredential(credential, config);
  return {
    config,
    environment: { ...(await environmentIdentity(scope.environmentId)), workspaceId: scope.workspaceId },
    transport: adapterTransport(adapter, credential),
  };
}

async function upstreamTransportKind(scope: CredentialScope, upstreamId: string): Promise<"streamable-http" | "sse" | null> {
  const [row] = await db.select({ transport: mcpUpstreams.transport }).from(mcpUpstreams).where(and(
    eq(mcpUpstreams.upstreamId, upstreamId),
    eq(mcpUpstreams.workspaceId, scope.workspaceId),
    eq(mcpUpstreams.environmentId, scope.environmentId),
  ));
  return row?.transport === "sse" || row?.transport === "streamable-http" ? row.transport : null;
}

async function withUpstreamToken(
  scope: CredentialScope, secrets: Map<string, string>, integrationKey: string,
): Promise<{ secrets: Map<string, string>; refreshCredential: () => Promise<boolean> }> {
  const { upstreamRowIdOf, upstreamCredential, UpstreamCredentialError } = await import("../mcp-upstreams/oauth.ts");
  const rowId = upstreamRowIdOf(integrationKey);
  const [upstream] = rowId
    ? await db.select({ id: mcpUpstreams.id, name: mcpUpstreams.name, operatorConnectionId: mcpUpstreams.operatorConnectionId })
      .from(mcpUpstreams).where(and(
        eq(mcpUpstreams.id, rowId),
        eq(mcpUpstreams.workspaceId, scope.workspaceId),
        eq(mcpUpstreams.environmentId, scope.environmentId),
        isNull(mcpUpstreams.archivedAt),
      ))
    : [];
  if (!upstream) throw new UpstreamCredentialError("no_connection", "The upstream this tool was adopted from is archived or gone. Nothing was sent.");
  const credential = await upstreamCredential(scope, upstream);
  const name = `connection:${integrationKey}`;
  const withToken = new Map([...secrets, [name, credential.token]]);
  const refreshCredential = async () => {
    const fresh = await credential.refresh();
    if (!fresh) return false;
    withToken.set(name, fresh);
    return true;
  };
  return { secrets: withToken, refreshCredential };
}

async function withUpstreamKey(
  scope: CredentialScope, secrets: Map<string, string>, endUserKey: { connection: string; header: string }, headers: Record<string, string>,
): Promise<{ secrets: Map<string, string>; refreshCredential?: () => Promise<boolean> }> {
  const { UpstreamCredentialError } = await import("../mcp-upstreams/oauth.ts");
  const { endUserKeyHeader, endUserKeySecretName, liveEndUserUpstream } = await import("../mcp-upstreams/end-user-key.ts");
  const upstream = await liveEndUserUpstream(scope, endUserKey.connection);
  if (!upstream || upstream.connect !== "key") {
    throw new UpstreamCredentialError("no_connection", "The upstream this tool was adopted from is archived or gone. Nothing was sent.");
  }
  const { header, secret } = endUserKeyHeader(headers, endUserKey.header);
  const name = endUserKeySecretName(endUserKey.connection);
  const withKey = new Map(secrets);
  if (!scope.endUserId) {
    const operator = secrets.get(secret);
    if (operator === undefined) throw new ValidationError(`Secret ${secret} could not be resolved.`);
    withKey.set(name, operator);
    return { secrets: withKey };
  }
  const endUserId = scope.endUserId;
  const { endUserUpstreamKey, markEndUserConnectionRejected } = await import("../end-users/connections.ts");
  const found = await endUserUpstreamKey(scope, endUserKey.connection, endUserId);
  if (found.status !== "active") {
    throw new UpstreamCredentialError("no_connection", found.status === "missing"
      ? `This end user has not connected ${upstream.name}. Send them a connect link. Nothing was sent.`
      : `This end user's ${upstream.name} key needs to be connected again. Send them a connect link. Nothing was sent.`);
  }
  withKey.set(name, found.key);
  const elsewhere = extractSecretNames(Object.fromEntries(Object.entries(headers).filter(([other]) => other !== header)));
  if (!elsewhere.includes(secret)) withKey.delete(secret);
  const refreshCredential = async () => {
    await markEndUserConnectionRejected(scope, endUserKey.connection, endUserId);
    return false;
  };
  return { secrets: withKey, refreshCredential };
}

export async function upstreamTransport(
  scope: CredentialScope, url: string, headers: Record<string, string>, extra: ReadonlyMap<string, string> = new Map(),
): Promise<ProviderTransport> {
  const { hostname } = declaredHost(url);
  const pinned = { hosts: [hostname], authHeaders: () => ({}), maxResponseBytes: MCP_MAX_RESPONSE_BYTES };
  const definition: DeclaredDefinition = {
    method: "POST", urlTemplate: url, headers, bodyTemplate: null, inputSchema: {}, declarations: { impact: null, verify: null },
  };
  const { secrets, hosts } = await declaredSecrets(scope, pinned as unknown as AnyEffectAdapter, definition);
  return adapterTransport({ ...pinned, hosts }, new Map([...secrets, ...extra]));
}
