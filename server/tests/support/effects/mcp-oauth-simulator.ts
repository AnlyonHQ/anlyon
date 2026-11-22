import { createHash, randomBytes } from "node:crypto";

export const MCP_OAUTH_HOST = "mcp.oauth.example";
export const MCP_OAUTH_URL = `https://${MCP_OAUTH_HOST}/mcp`;
export const AS_HOST = "auth.oauth.example";
export const AS_ISSUER = `https://${AS_HOST}`;
export const PRM_URL = `https://${MCP_OAUTH_HOST}/.well-known/oauth-protected-resource/mcp`;

type Tool = { name: string; description?: string; inputSchema?: Record<string, unknown> };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const random = (n: number) => randomBytes(n).toString("hex");

export class McpOAuthSimulator {
  tools: Tool[] = [
    {
      name: "create_issue",
      description: "Creates an issue in the user's tracker.",
      inputSchema: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
    },
    { name: "list_issues", description: "Lists the user's issues.", inputSchema: { type: "object", properties: {} } },
  ];
  calls: Array<{ method: string; user: string | null }> = [];
  tokenRequests: Array<Record<string, string>> = [];
  metadataReads: string[] = [];
  listsAnonymously = false;
  readonly rejectUsers = new Set<string>();
  insufficientScope: { method: string; scope: string } | null = null;

  prm: Record<string, unknown> = {
    resource: MCP_OAUTH_URL,
    authorization_servers: [AS_ISSUER],
    scopes_supported: ["issues:read", "issues:write"],
  };
  asMetadata: Record<string, unknown> = {
    issuer: AS_ISSUER,
    authorization_endpoint: `${AS_ISSUER}/authorize`,
    token_endpoint: `${AS_ISSUER}/token`,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    registration_endpoint: `${AS_ISSUER}/register`,
  };

  private readonly codes = new Map<string, { user: string; redirectUri: string; challenge: string; resource: string }>();
  private readonly access = new Map<string, string>();
  private readonly refresh = new Map<string, string>();
  private readonly redirectUris = new Set<string>();
  readonly registered = new Map<string, { secret: string | null; method: string; redirectUris: string[] }>();
  dcr: { mode: "public" | "confidential" | "fail"; method?: "client_secret_post" | "client_secret_basic"; dropRedirect?: boolean } = { mode: "public" };
  registrations: Array<Record<string, unknown>> = [];
  readonly clientDocuments = new Map<string, Record<string, unknown>>();

  constructor(readonly client: { clientId: string; clientSecret?: string; redirectUri: string }) {
    this.redirectUris.add(client.redirectUri);
  }

  approve(authorizeUrl: string, user: string): string {
    const url = new URL(authorizeUrl);
    if (`${url.origin}${url.pathname}` !== this.asMetadata.authorization_endpoint) throw new Error(`not the authorize URL: ${authorizeUrl}`);
    const p = url.searchParams;
    const doc = this.documentFor(p.get("client_id") ?? "");
    const dynamic = this.registered.get(p.get("client_id") ?? "");
    if (dynamic) {
      if (!dynamic.redirectUris.includes(p.get("redirect_uri") ?? "")) throw new Error("redirect_uri not registered for this client");
    } else if (doc) {
      if (!(doc.redirect_uris as string[] | undefined)?.includes(p.get("redirect_uri") ?? "")) throw new Error("redirect_uri not in the client metadata document");
    } else {
      if (p.get("client_id") !== this.client.clientId) throw new Error("wrong client_id");
      if (!this.redirectUris.has(p.get("redirect_uri") ?? "")) throw new Error("redirect_uri not registered");
    }
    if (p.get("response_type") !== "code") throw new Error("not a code flow");
    if (p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) throw new Error("no S256 PKCE challenge");
    if (p.get("resource") !== MCP_OAUTH_URL) throw new Error(`wrong resource: ${p.get("resource")}`);
    const code = random(16);
    this.codes.set(code, { user, redirectUri: p.get("redirect_uri")!, challenge: p.get("code_challenge")!, resource: p.get("resource")! });
    const back = new URL(p.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", p.get("state") ?? "");
    return back.toString();
  }

  private documentFor(clientId: string): Record<string, unknown> | null {
    if (!clientId.startsWith("https://")) return null;
    if (this.asMetadata.client_id_metadata_document_supported !== true) throw new Error("client metadata documents are not accepted here");
    const doc = this.clientDocuments.get(clientId);
    if (!doc) throw new Error(`could not fetch the client metadata document at ${clientId}`);
    if (doc.client_id !== clientId) throw new Error("the document names another client_id");
    if (doc.token_endpoint_auth_method !== "none") throw new Error("only public clients are accepted by document");
    return doc;
  }

  expire(user: string) {
    for (const [token, owner] of this.access) if (owner === user) this.access.delete(token);
  }

  revoke(user: string) {
    this.expire(user);
    for (const [token, owner] of this.refresh) if (owner === user) this.refresh.delete(token);
  }

  private issue(user: string) {
    const accessToken = `at_${random(16)}`;
    const refreshToken = `rt_${random(16)}`;
    this.access.set(accessToken, user);
    this.refresh.set(refreshToken, user);
    return { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 3600, scope: "issues:read issues:write" };
  }

  private register(body: Record<string, unknown>): Response {
    this.registrations.push(body);
    if (this.dcr.mode === "fail") return json(400, { error: "invalid_client_metadata" });
    const clientId = `dcr-${random(8)}`;
    const redirectUris = (body.redirect_uris as string[] | undefined) ?? [];
    const confidential = this.dcr.mode === "confidential";
    const method = confidential ? this.dcr.method ?? "client_secret_post" : "none";
    const secret = confidential ? `dcr_secret_${random(12)}` : null;
    this.registered.set(clientId, { secret, method, redirectUris });
    return json(201, {
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      redirect_uris: this.dcr.dropRedirect ? ["https://elsewhere.example/cb"] : redirectUris,
      token_endpoint_auth_method: method,
      registration_access_token: "rat_not_kept",
    });
  }

  private token(form: URLSearchParams, headers: Record<string, string> = {}): Response {
    const params: Record<string, string> = Object.fromEntries(form);
    const basic = /^Basic (.+)$/.exec(headers.Authorization ?? headers.authorization ?? "");
    if (basic) {
      const [id, secret] = Buffer.from(basic[1]!, "base64").toString().split(":").map(decodeURIComponent);
      params.client_id ??= id!;
      params.basic_client_secret = secret!;
    }
    this.tokenRequests.push(params);
    const dynamic = this.registered.get(params.client_id ?? "");
    if (dynamic) {
      const presented = dynamic.method === "client_secret_basic" ? params.basic_client_secret : params.client_secret;
      if (dynamic.secret ? presented !== dynamic.secret : (params.client_secret !== undefined || params.basic_client_secret !== undefined)) {
        return json(401, { error: "invalid_client" });
      }
      if (dynamic.method === "client_secret_basic" && params.client_secret !== undefined) return json(401, { error: "invalid_client" });
      return this.grant(params);
    }
    let cimd = false;
    try {
      cimd = this.documentFor(params.client_id ?? "") !== null;
    } catch {
      return json(401, { error: "invalid_client" });
    }
    if (cimd) {
      if (params.client_secret !== undefined) return json(401, { error: "invalid_client" });
    } else {
      if (params.client_id !== this.client.clientId) return json(401, { error: "invalid_client" });
      if (this.client.clientSecret ? params.client_secret !== this.client.clientSecret : params.client_secret !== undefined) {
        return json(401, { error: "invalid_client" });
      }
    }
    return this.grant(params);
  }

  private grant(params: Record<string, string>): Response {
    if (params.resource !== MCP_OAUTH_URL) return json(400, { error: "invalid_target" });
    if (params.grant_type === "authorization_code") {
      const grant = this.codes.get(params.code ?? "");
      this.codes.delete(params.code ?? "");
      if (!grant || grant.redirectUri !== params.redirect_uri) return json(400, { error: "invalid_grant" });
      const challenge = createHash("sha256").update(params.code_verifier ?? "").digest("base64url");
      if (challenge !== grant.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      return json(200, this.issue(grant.user));
    }
    if (params.grant_type === "refresh_token") {
      const user = this.refresh.get(params.refresh_token ?? "");
      if (!user) return json(400, { error: "invalid_grant" });
      this.refresh.delete(params.refresh_token!);
      return json(200, this.issue(user));
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  private mcp(init: { headers?: Record<string, string>; body?: string }): Response {
    const body = JSON.parse(init.body ?? "{}") as { id?: number; method: string; params?: Record<string, unknown> };
    const header = init.headers?.Authorization ?? init.headers?.authorization ?? "";
    const found = header.startsWith("Bearer ") ? this.access.get(header.slice(7)) ?? null : null;
    const user = found && this.rejectUsers.has(found) ? null : found;
    this.calls.push({ method: body.method, user });
    const anonymousOk = this.listsAnonymously && body.method !== "tools/call";
    if (!user && !anonymousOk) {
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": `Bearer resource_metadata="${PRM_URL}", scope="issues:read issues:write"` },
      });
    }
    if (user && this.insufficientScope?.method === body.method) {
      return new Response(JSON.stringify({ error: "insufficient_scope" }), {
        status: 403,
        headers: { "Content-Type": "application/json", "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${this.insufficientScope.scope}", resource_metadata="${PRM_URL}"` },
      });
    }
    const reply = (result: unknown, headers: Record<string, string> = {}) =>
      json(200, { jsonrpc: "2.0", id: body.id, result }, headers);
    switch (body.method) {
      case "initialize":
        return reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "sim-tracker", version: "1.0.0" } }, { "Mcp-Session-Id": `s-${random(4)}` });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return reply({ tools: this.tools });
      case "tools/call":
        return reply({ content: [{ type: "text", text: `${String(body.params?.name)} for ${user}` }] });
      default:
        return json(200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
    }
  }

  fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response> => {
    const target = new URL(url);
    const method = init?.method ?? "GET";
    if (target.host === MCP_OAUTH_HOST && method === "GET" && target.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      this.metadataReads.push(url);
      return url === PRM_URL ? json(200, this.prm) : json(404, {});
    }
    if (target.host === MCP_OAUTH_HOST && target.pathname === "/mcp" && method === "POST") return this.mcp(init ?? {});
    if (target.host === AS_HOST && method === "GET" && target.pathname === "/.well-known/oauth-authorization-server") {
      this.metadataReads.push(url);
      return json(200, this.asMetadata);
    }
    if (target.host === AS_HOST && method === "POST" && target.pathname === "/token") {
      const form = new URLSearchParams(init?.body ?? "");
      return this.token(form, init?.headers ?? {});
    }
    if (target.host === AS_HOST && method === "POST" && target.pathname === "/register") {
      return this.register(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    }
    return json(404, { error: "not_found" });
  };
}
