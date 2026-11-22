/**
 * Library entry point.
 *
 * Separate from index.ts, which is the `anlyon-mcp` bin and starts a transport
 * as a side effect of being imported. Anything that wants to host these tools
 * in-process  notably the scheduler, which serves the OAuth-authenticated MCP
 * endpoint at /mcp  imports from here instead.
 */
export {
  createServer,
  listTools,
  callTool,
  ALL_TOOLS,
  DEFAULT_TOOLS,
  LEGACY_TOOL_NAMES,
  isLegacyTool,
  legacyToolsEnabled,
  hiddenOutsideGrant,
  scopesOfTool,
  connectRequiredResult,
} from './server.ts';
export type { Presentation, ServerOptions, ToolDescriptor, SecurityScheme, ConnectRequiredResult } from './server.ts';
export type { ConsentScope, ToolAnnotations } from './tools/types.ts';
export {
  requestContext,
  resolveApiBaseUrl,
  resolveApiKey,
  resolveEndUserId,
  extractBearerKey,
  resolveCacheScope,
} from './auth.ts';
export { SERVER_NAME, SERVER_VERSION } from './pkg.ts';
