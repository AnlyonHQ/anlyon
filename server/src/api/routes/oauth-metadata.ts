import { Hono, type Context } from "hono";
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { auth, AUTH_BASE_PATH, MCP_RESOURCE_URL, OAUTH_ISSUER } from "../../utils/auth.ts";
import { ADVERTISED_OAUTH_SCOPES } from "../../core/auth/oauth-scopes.ts";

const oauthMetadataRouter = new Hono();

const ISSUER_PATH = AUTH_BASE_PATH;

const authServerMetadata = oauthProviderAuthServerMetadata(auth);

const serveAuthServerMetadata = async (c: Context) => {
  const response = await authServerMetadata(c.req.raw);
  if (!response.ok) return response;

  const metadata = (await response.json()) as Record<string, unknown>;
  const headers = new Headers(response.headers);
  headers.delete("content-length");

  return new Response(
    JSON.stringify({
      ...metadata,
      authorization_response_iss_parameter_supported: false,
      scopes_supported: ADVERTISED_OAUTH_SCOPES,
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );
};

oauthMetadataRouter.get(`/.well-known/oauth-authorization-server${ISSUER_PATH}`, serveAuthServerMetadata);
oauthMetadataRouter.get(`/.well-known/openid-configuration${ISSUER_PATH}`, serveAuthServerMetadata);
oauthMetadataRouter.get("/.well-known/oauth-authorization-server", serveAuthServerMetadata);
oauthMetadataRouter.get("/.well-known/openid-configuration", serveAuthServerMetadata);

const protectedResourceMetadata = (c: Context) =>
  c.json({
    resource: MCP_RESOURCE_URL,
    authorization_servers: [OAUTH_ISSUER],
    scopes_supported: ADVERTISED_OAUTH_SCOPES,
    bearer_methods_supported: ["header"],
    resource_documentation: "https://docs.anlyon.com/mcp",
  });

oauthMetadataRouter.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);
oauthMetadataRouter.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);

export default oauthMetadataRouter;
