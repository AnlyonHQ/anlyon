import { callTool, listTools, requestContext, SERVER_NAME, SERVER_VERSION, type ServerOptions } from "@anlyonhq/mcp-server";
import { verifyOAuthAccessToken } from "../../core/auth/oauth-tokens.ts";
import { listEvents, McpEventsError, subscribe, unsubscribe } from "../../core/mcp-events/service.ts";
import { createLogger } from "../../lib/logger.ts";
import { clientInfoFromMeta, recordHostedToolCall, type McpCaller as AnalyticsCaller } from "../../lib/mcp-analytics.ts";
import { ApiError } from "../../utils/errors.ts";

const logger = createLogger({ module: "mcp-modern" });

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const SUPPORTED_VERSIONS = [MODERN_PROTOCOL_VERSION, ...LEGACY_VERSIONS];

const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

const META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  serverInfo: "io.modelcontextprotocol/serverInfo",
} as const;

export function isModernRequest(request: Request): boolean {
  const version = request.headers.get("mcp-protocol-version");
  return version !== null && !LEGACY_VERSIONS.includes(version);
}

export interface ModernContext {
  token: string;
  cacheScope: string;
  apiBaseUrl: string;
  serverOptions: ServerOptions;
  endUserId?: string;
  analytics?: { serverName: string; caller: AnalyticsCaller };
}

type JsonRpcId = string | number | null;

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

const failure = (status: number, id: JsonRpcId, code: number, message: string, data?: unknown) =>
  json(status, { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

const success = (id: JsonRpcId, result: Record<string, unknown>) =>
  json(200, {
    jsonrpc: "2.0",
    id,
    result: {
      resultType: "complete",
      ...result,
      _meta: { ...(result._meta as Record<string, unknown> | undefined), [META.serverInfo]: { name: SERVER_NAME, version: SERVER_VERSION } },
    },
  });

function decodeHeader(value: string | null): string | null {
  const match = value?.match(/^=\?base64\?(.*)\?=$/);
  return match ? Buffer.from(match[1], "base64").toString("utf8") : value;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function serveModernMcp(request: Request, context: ModernContext): Promise<Response> {
  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return failure(400, null, -32700, "Parse error");
  }
  if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return failure(400, null, INVALID_REQUEST, "Invalid request");
  }
  const id = (typeof message.id === "string" || typeof message.id === "number" ? message.id : null) as JsonRpcId;
  if (message.id === undefined) return new Response(null, { status: 202 });

  const method = message.method;
  const params = isObject(message.params) ? message.params : {};
  const meta = isObject(params._meta) ? params._meta : {};

  const headerVersion = request.headers.get("mcp-protocol-version");
  if (meta[META.protocolVersion] === undefined || !isObject(meta[META.clientCapabilities])) {
    return failure(400, id, INVALID_PARAMS, `_meta must carry ${META.protocolVersion} and ${META.clientCapabilities}`);
  }
  if (meta[META.protocolVersion] !== headerVersion) {
    return failure(400, id, HEADER_MISMATCH, "Header mismatch: MCP-Protocol-Version does not match _meta");
  }
  if (headerVersion !== MODERN_PROTOCOL_VERSION) {
    return failure(400, id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
      supported: SUPPORTED_VERSIONS,
      requested: headerVersion,
    });
  }
  if (request.headers.get("mcp-method") !== method) {
    return failure(400, id, HEADER_MISMATCH, "Header mismatch: Mcp-Method does not match the request method");
  }
  if (method === "tools/call" && decodeHeader(request.headers.get("mcp-name")) !== params.name) {
    return failure(400, id, HEADER_MISMATCH, "Header mismatch: Mcp-Name does not match params.name");
  }

  const withCredential = <T>(fn: () => Promise<T>) =>
    requestContext.run(
      {
        apiKey: context.token,
        cacheScope: context.cacheScope,
        apiBaseUrl: context.apiBaseUrl,
        ...(context.endUserId ? { endUserId: context.endUserId } : {}),
      },
      fn,
    );

  try {
    switch (method) {
      case "server/discover":
        return success(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {}, events: {} },
        });
      case "tools/list":
        return success(id, { ...(await withCredential(() => listTools(context.serverOptions))) });
      case "tools/call": {
        if (typeof params.name !== "string") return failure(400, id, INVALID_PARAMS, "params.name is required");
        const args = isObject(params.arguments) ? params.arguments : {};
        const name = params.name;
        const run = () => withCredential(() => callTool(name, args, context.serverOptions));
        const analytics = context.analytics;
        const result = analytics
          ? await recordHostedToolCall(
              {
                serverName: analytics.serverName,
                serverVersion: SERVER_VERSION,
                toolName: name,
                caller: { ...analytics.caller, ...clientInfoFromMeta(meta) },
              },
              run,
            )
          : await run();
        return success(id, { ...result });
      }
      case "events/list":
        return success(id, listEvents());
      case "events/subscribe":
      case "events/unsubscribe": {
        const identity = await verifyOAuthAccessToken(context.token);
        const principal = {
          userId: identity.userId,
          clientId: identity.clientId,
          workspaceId: identity.workspaceId,
          environmentId: identity.environmentId,
          scopes: identity.scopes,
        };
        const result = method === "events/subscribe" ? await subscribe(principal, params) : await unsubscribe(principal, params);
        return success(id, result);
      }
      default:
        return failure(404, id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (error) {
    if (error instanceof McpEventsError) return failure(200, id, error.code, error.message, error.data);
    if (error instanceof ApiError) return failure(200, id, -31000 - error.statusCode, error.message);
    logger.error({ method, error: error instanceof Error ? error.message : error }, "Modern MCP request failed");
    return failure(500, id, INTERNAL_ERROR, "Internal error");
  }
}
