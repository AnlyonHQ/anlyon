import { Hono, type Context } from "hono";
import { mcpHandler } from "../mcp-bearer.ts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  callTool,
  createServer,
  hiddenOutsideGrant,
  requestContext,
  SERVER_NAME,
  SERVER_VERSION,
  type Presentation,
  type ServerOptions,
} from "@anlyonhq/mcp-server";
import { isModernRequest, serveModernMcp } from "./mcp-modern.ts";
import { openAiPresentation } from "@anlyonhq/mcp-server/profiles/openai";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { oauthClient } from "../../db/schema/oauth.ts";
import { isFeatureEnabled } from "@anlyon/feature-flags";
import { clientIdOf, hasActiveConsent } from "../../core/auth/oauth-tokens.ts";
import { parseScopeClaim } from "../../core/auth/oauth-scopes.ts";
import { MCP_RESOURCE_URL, OAUTH_ISSUER } from "../../utils/auth.ts";
import { MCP_RESOURCE_METADATA_URL, mcpUnauthorized } from "../mcp-challenge.ts";
import { markCredentialRejected } from "../credential-rejection.ts";
import { endUserHeaderNotAllowed } from "../end-user-context.ts";
import { verifyApiKeyAndGetWorkspace } from "../../core/auth/api-keys.ts";
import { END_USER_HEADER, parseEndUserId } from "../../core/end-users/identity.ts";
import { EndUserRequiredError } from "../../core/end-users/errors.ts";
import { ApiError, AuthenticationError, ServiceUnavailableError } from "../../utils/errors.ts";
import { packServer, packServerOptions, type PackServer } from "./mcp-packs.ts";
import { env } from "../../config/env.ts";
import { createLogger } from "../../lib/logger.ts";
import { productEventsEnabled } from "../../lib/product-events.ts";
import { callerHeaders, clientInfoFromMeta, recordHostedToolCall, type McpCaller as AnalyticsCaller } from "../../lib/mcp-analytics.ts";

const logger = createLogger({ module: "mcp" });

const mcpRouter = new Hono();

const verifyOptions = {
  jwksUrl: `${OAUTH_ISSUER}/jwks`,
  verifyOptions: {
    audience: MCP_RESOURCE_URL,
    issuer: OAUTH_ISSUER,
  },
} as const;

const OPENAI_PRESENTATION = openAiPresentation({
  resourceMetadataUrl: MCP_RESOURCE_METADATA_URL,
});

export function isChatGptRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === "https:" && url.hostname === "chatgpt.com";
  } catch {
    return false;
  }
}

async function clientProfile(clientId: string): Promise<{ presentation: Presentation | undefined; name: string | null }> {
  const [row] = await db
    .select({ redirectUris: oauthClient.redirectUris, name: oauthClient.name })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  return {
    presentation: row?.redirectUris?.some(isChatGptRedirect) ? OPENAI_PRESENTATION : undefined,
    name: row?.name ?? null,
  };
}

interface McpCaller {
  credential: string;
  cacheScope: string;
  grantedGroups: readonly string[] | null;
  presentation: Presentation | undefined;
  endUserId: string | null;
  analytics: AnalyticsCaller;
}

async function serveMcp(request: Request, caller: McpCaller, pack: PackServer | null): Promise<Response> {
  const outsideGrant = caller.grantedGroups ? hiddenOutsideGrant(caller.grantedGroups) : () => false;
  const options: ServerOptions = {
    hiddenTools: (name) => outsideGrant(name),
    ...(caller.presentation ? { presentation: caller.presentation } : {}),
  };
  const serverOptions = pack ? packServerOptions(pack, options) : options;
  const endUser = caller.endUserId ? { endUserId: caller.endUserId } : {};

  const analytics: AnalyticsCaller = { ...caller.analytics, ...callerHeaders(request.headers) };
  if (isFeatureEnabled("mcp-events") && isModernRequest(request)) {
    return serveModernMcp(request, {
      token: caller.credential,
      cacheScope: caller.cacheScope,
      apiBaseUrl: env.BETTER_AUTH_URL,
      serverOptions,
      analytics: { serverName: mcpServerName(pack), caller: analytics },
      ...endUser,
    });
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = createServer(serverOptions);
  if (productEventsEnabled()) {
    const serverName = mcpServerName(pack);
    server.setRequestHandler(CallToolRequestSchema, async (call) =>
      recordHostedToolCall(
        {
          serverName,
          serverVersion: SERVER_VERSION,
          toolName: call.params.name,
          caller: { ...analytics, ...clientInfoFromMeta(call.params._meta) },
        },
        () => callTool(call.params.name, call.params.arguments ?? {}, serverOptions),
      ),
    );
  }
  await server.connect(transport);

  return requestContext.run(
    { apiKey: caller.credential, cacheScope: caller.cacheScope, apiBaseUrl: env.BETTER_AUTH_URL, ...endUser },
    () => transport.handleRequest(request),
  );
}

function mcpServerName(pack: PackServer | null): string {
  return pack ? `anlyon-${pack.name}` : SERVER_NAME;
}

function apiErrorResponse(error: ApiError): Response {
  return new Response(JSON.stringify(error.toJSON()), {
    status: error.statusCode,
    headers: { "Content-Type": "application/json" },
  });
}

export function isApiKeyCredential(bearer: string): boolean {
  return bearer.startsWith("anlyon_");
}

async function serveApiKey(request: Request, key: string, pack: PackServer | null): Promise<Response> {
  let verified: Awaited<ReturnType<typeof verifyApiKeyAndGetWorkspace>>;
  try {
    verified = await verifyApiKeyAndGetWorkspace(key);
  } catch (error) {
    if (error instanceof AuthenticationError) return mcpUnauthorized("Authentication failed");
    logger.warn({ error: error instanceof Error ? error.message : "Unknown" }, "API key could not be checked at /mcp");
    return apiErrorResponse(new ServiceUnavailableError("Authentication is temporarily unavailable. Retry shortly."));
  }

  const raw = request.headers.get(END_USER_HEADER);
  let endUserId: string | null = null;
  if (raw !== null) {
    try {
      endUserId = parseEndUserId(raw);
    } catch (error) {
      if (error instanceof ApiError) return apiErrorResponse(error);
      throw error;
    }
  }
  if (verified.endUserRequired && !endUserId) return apiErrorResponse(new EndUserRequiredError());

  return serveMcp(
    request,
    {
      credential: key,
      cacheScope: `apikey:${verified.keyId}`,
      grantedGroups: null,
      presentation: undefined,
      endUserId,
      analytics: { distinctId: verified.workspaceId, isPerson: false, workspaceId: verified.workspaceId },
    },
    pack,
  );
}

const oauthHandler = (pack: PackServer | null) => mcpHandler(verifyOptions, async (request, jwt) => {
  logger.debug({ sub: jwt.sub, clientId: clientIdOf(jwt), scope: jwt.scope }, "MCP request authenticated");

  const subject = jwt.sub;
  const client = clientIdOf(jwt);
  if (!subject || !client || !(await hasActiveConsent(subject, client))) {
    logger.warn({ sub: subject, clientId: client }, "MCP request from an app with no active consent; refusing");
    return mcpUnauthorized("This app is no longer connected to your Anlyon account. Re-authorize to continue.");
  }

  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) {
    return new Response(JSON.stringify({ error: "invalid_token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (request.headers.has(END_USER_HEADER)) return apiErrorResponse(endUserHeaderNotAllowed());

  const cacheScope = `${subject}:${client}`;

  const profile = await clientProfile(client);
  return serveMcp(
    request,
    {
      credential: token,
      cacheScope,
      grantedGroups: parseScopeClaim(jwt.scope),
      presentation: profile.presentation,
      endUserId: null,
      analytics: { distinctId: subject, isPerson: true, clientName: profile.name },
    },
    pack,
  );
});

const rootOAuthHandler = oauthHandler(null);

async function handleMcp(c: Context, pack: PackServer | null): Promise<Response> {
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const response = bearer && isApiKeyCredential(bearer)
    ? await serveApiKey(c.req.raw, bearer, pack)
    : await (pack ? oauthHandler(pack) : rootOAuthHandler)(c.req.raw);

  if (response.status === 401) markCredentialRejected(c);

  if (response.status === 401 && bearer && !bearer.includes(".") && !isApiKeyCredential(bearer)) {
    logger.warn(
      { resource: MCP_RESOURCE_URL },
      "Rejected an opaque bearer at /mcp. The client omitted the `resource` parameter, so it was issued " +
        "an opaque token rather than a JWT for this resource, and will retry forever. It must send " +
        "resource=<this MCP URL> on /oauth2/authorize and /oauth2/token.",
    );
  }

  return response;
}

mcpRouter.post("/", (c: Context) => handleMcp(c, null));

mcpRouter.post("/:pack", (c: Context) => {
  const name = c.req.param("pack") ?? "";
  const pack = packServer(name);
  if (!pack) return apiErrorResponse(unknownPack(name));
  return handleMcp(c, pack);
});

function unknownPack(name: string): ApiError {
  return new ApiError(404, "NOT_FOUND", `There is no MCP server named "${name}". Each integration's MCP server is at /mcp/<integration>, for example /mcp/github.`);
}

mcpRouter.get("/", (c: Context) =>
  c.json({ name: "anlyon", transport: "streamable-http", resource: MCP_RESOURCE_URL, authorization_servers: [OAUTH_ISSUER] }),
);

mcpRouter.get("/:pack", (c: Context) => {
  const name = c.req.param("pack") ?? "";
  const pack = packServer(name);
  if (!pack) return apiErrorResponse(unknownPack(name));
  return c.json({
    name: `anlyon-${pack.name}`,
    integration: pack.displayName,
    pack: pack.pack,
    transport: "streamable-http",
    resource: MCP_RESOURCE_URL,
    authorization_servers: [OAUTH_ISSUER],
  });
});

export default mcpRouter;
