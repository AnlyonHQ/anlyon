import type { McpUpstream } from "../../db/schema/mcp-upstreams.ts";
import { ConnectionsUnavailableError } from "../../utils/errors.ts";
import { upstreamTransport, type CredentialScope } from "../effects/context.ts";
import { McpReadError, McpSession, type McpTransportKind } from "./client.ts";
import { discoverUpstreamOAuth, mayLendSharedClient, resourceMetadataUrl, upstreamRedirectUri, UpstreamOAuthRefused, type DiscoveredOAuth } from "./oauth.ts";
import { checkEndpoint, parseListedTools } from "./service.ts";

export interface UpstreamSignIn {
  issuer: string;
  authorizationHost: string;
  tokenHost: string;
  scopesSupported: string[];
  advertised: DiscoveredOAuth["advertised"];
  redirectUri: string | null;
}

export type UpstreamInspection =
  | { kind: "open"; host: string; toolCount: number; serverInfo: McpUpstream["serverInfo"]; transport: McpTransportKind; signIn: UpstreamSignIn | null }
  | { kind: "oauth"; host: string; signIn: UpstreamSignIn }
  | { kind: "credential"; host: string; status: number }
  | { kind: "refused"; host: string; reason: string; message: string }
  | { kind: "unreachable"; host: string; message: string };

const MAX_SCOPES = 200;
const MAX_SCOPE_LENGTH = 200;

const NO_METADATA = new Set(["no_resource_metadata", "metadata_invalid", "metadata_unreachable"]);

function redirectUriOrNull(): string | null {
  try {
    return upstreamRedirectUri();
  } catch (error) {
    if (error instanceof ConnectionsUnavailableError) return null;
    throw error;
  }
}

function signInOf(discovered: DiscoveredOAuth): UpstreamSignIn {
  return {
    issuer: discovered.issuer,
    authorizationHost: new URL(discovered.authorizationEndpoint).hostname,
    tokenHost: new URL(discovered.tokenEndpoint).hostname,
    scopesSupported: discovered.scopesSupported.filter((scope) => scope.length <= MAX_SCOPE_LENGTH).slice(0, MAX_SCOPES),
    advertised: { ...discovered.advertised, clientIdMetadataDocuments: mayLendSharedClient(discovered) },
    redirectUri: redirectUriOrNull(),
  };
}

const withoutNotSent = (message: string) => message.replace(/ The tool was not called; nothing was sent\.$/, "");

async function answerToRefusal(url: string, host: string, error: McpReadError): Promise<UpstreamInspection> {
  try {
    return { kind: "oauth", host, signIn: signInOf(await discoverUpstreamOAuth(url, error.wwwAuthenticate)) };
  } catch (refusal) {
    if (!(refusal instanceof UpstreamOAuthRefused)) throw refusal;
    if (!resourceMetadataUrl(error.wwwAuthenticate) && NO_METADATA.has(refusal.reason)) {
      return { kind: "credential", host, status: error.status! };
    }
    return { kind: "refused", host, reason: refusal.reason, message: refusal.message };
  }
}

export async function inspectUpstream(scope: CredentialScope, input: string): Promise<UpstreamInspection> {
  const url = checkEndpoint(input);
  const host = new URL(url).hostname;
  const session = new McpSession(await upstreamTransport(scope, url, {}), url, {}, { transport: "auto" });
  let serverInfo: McpUpstream["serverInfo"];
  let raw: unknown[];
  try {
    ({ serverInfo } = await session.initialize());
    raw = await session.listTools();
  } catch (error) {
    if (error instanceof McpReadError && (error.status === 401 || error.status === 403)) return answerToRefusal(url, host, error);
    return { kind: "unreachable", host, message: withoutNotSent(error instanceof Error ? error.message : String(error)) };
  } finally {
    session.close();
  }
  const transport = session.transportKind;
  let toolCount: number;
  try {
    toolCount = parseListedTools(raw).length;
  } catch (error) {
    return { kind: "refused", host, reason: "tools_invalid", message: error instanceof Error ? error.message : String(error) };
  }
  const discovered = await discoverUpstreamOAuth(url, null).catch(() => null);
  return { kind: "open", host, toolCount, serverInfo, transport, signIn: discovered ? signInOf(discovered) : null };
}
