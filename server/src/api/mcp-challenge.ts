import { env } from "../config/env.ts";

export const MCP_RESOURCE_URL = `${env.BETTER_AUTH_URL}/mcp`;

export const MCP_RESOURCE_METADATA_URL = (() => {
  const resource = new URL(MCP_RESOURCE_URL);
  return `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`;
})();

export function mcpUnauthorized(description: string): Response {
  return new Response(JSON.stringify({ error: "invalid_token", error_description: description }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${MCP_RESOURCE_METADATA_URL}"`,
    },
  });
}
