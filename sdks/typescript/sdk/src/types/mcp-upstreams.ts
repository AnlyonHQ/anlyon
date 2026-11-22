/** Remote MCP servers registered with Anlyon, and the tools adopted from them as governed actions. */

/** What the risk engine suggests, from what the server says. A suggestion, and server text is untrusted. */
export type McpToolClass = 'read' | 'write' | 'irreversible' | 'destructive' | (string & {});

export interface McpToolSnapshot {
  name: string;
  /** The hash of this tool's definition. An adopted action is pinned to it. */
  hash: string;
  /** The tool as the server listed it. Its text is the server's: untrusted. */
  definition: Record<string, unknown>;
  suggestedClass: McpToolClass;
  reasons: unknown[];
}

export interface AdoptedMcpTool {
  tool: string;
  action: string;
  actionId: string;
  enabled: boolean;
  /** The adopted definition against the last listing. `changed` and `missing` tools are not called. */
  state: 'current' | 'changed' | 'missing';
  /** The definition this action is pinned to. */
  toolHash: string;
  requiresApproval: boolean;
}

export interface McpUpstreamOAuth {
  resource: string;
  issuer: string;
  authorizationServers: string[];
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopesSupported: string[];
  scopes: string[];
  clientId: string;
  clientRegistration: 'pre_registered' | 'client_metadata_document' | 'dynamic';
  advertised: { dynamicRegistration: boolean; clientIdMetadataDocuments: boolean; pkceS256: boolean };
  publicClient: boolean;
  redirectUri: string;
  operatorConnected: boolean;
}

export interface McpUpstream {
  id: string;
  name: string;
  url: string;
  /** Sent on every request. Credentials appear only as `{{secret:NAME}}` references. */
  headers: Record<string, string>;
  registryName: string | null;
  protocolVersion: string | null;
  serverInfo: { name?: string; title?: string; version?: string } | null;
  tools: McpToolSnapshot[];
  /** The hash of the whole listing. */
  toolsHash: string | null;
  listedAt: string | null;
  lastError: { code: string; message: string; at: string } | null;
  listedWith: 'anonymous' | 'headers' | 'operator' | null;
  oauth: McpUpstreamOAuth | null;
  /** Set when each end user brings their own key: the header it is sent in. Never a key. */
  /** `integration` is what an end user's key is stored under (`endUsers` connections). */
  endUserKey: { header: string; integration?: string } | null;
  adopted: AdoptedMcpTool[];
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterMcpUpstreamRequest {
  /** 1 to 32 lowercase letters, digits and hyphens, starting with a letter. */
  name: string;
  /** The server's Streamable HTTP endpoint, https. Fixed for the life of the upstream. */
  url: string;
  /** Sent on every request. A credential is a `{{secret:NAME}}` reference, and naming one needs `secrets:read`. */
  headers?: Record<string, string>;
  registryName?: string | null;
  /** For a server that signs people in with OAuth. Always waits for a person's sign-off from a credential. */
  oauth?: {
    clientId?: string | null;
    clientSecret?: string | null;
    scopes?: string[];
    redirectUri?: string | null;
    authorizationServer?: string | null;
  } | null;
  /**
   * For a server that takes an API key in a header, when each end user brings their own. `header`
   * must be one of `headers`, holding your own key as one `{{secret:NAME}}` reference: it lists the
   * tools and is used for calls made for no end user. A call made for an end user sends their key
   * in its place. Not with `oauth`.
   */
  endUserKey?: { header: string } | null;
}

/** What a server is, before it is registered. `kind` says which of the other fields are present. */
export interface McpUpstreamInspection {
  kind: 'open' | 'oauth' | 'credential' | 'refused' | 'unreachable';
  host: string;
  toolCount?: number;
  serverInfo?: { name?: string; title?: string; version?: string } | null;
  signIn?: {
    issuer: string;
    authorizationHost: string;
    tokenHost: string;
    scopesSupported: string[];
    advertised: { dynamicRegistration: boolean; clientIdMetadataDocuments: boolean; pkceS256: boolean };
    redirectUri: string | null;
  } | null;
  status?: number;
  reason?: string;
  message?: string;
}

/** What to run an adopted tool with. A re-adoption keeps the action's own. */
export interface McpToolChoice {
  requiresApproval?: boolean;
  impact?: { dimension: string; unit?: string; amount: string; bound: 'exact' | 'upper_bound' } | null;
  /** What agents read. Defaults to the tool's own text, which is the server's. */
  description?: string;
}

export interface McpAdoptResult {
  /** `action` is the action as stored: an `Action`. */
  adopted: { tool: string; action: Record<string, unknown> & { id: string; name: string }; readopted: boolean }[];
  skipped: { tool: string; reason: string }[];
}

export interface McpUpstreamConnectLink {
  url: string;
  expiresAt: string;
}
