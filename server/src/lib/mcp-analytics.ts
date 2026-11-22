import { captureMcpToolCall, productEventsEnabled, type McpCaller } from "./product-events.ts";

export { captureMcpToolCall };
export type { McpCaller, McpCallKind, McpToolCallRecord } from "./product-events.ts";

export function callerHeaders(headers: Headers): Pick<McpCaller, "userAgent" | "vendorClient" | "protocolVersion"> {
  return {
    userAgent: headers.get("user-agent"),
    vendorClient: headers.get("x-anthropic-client"),
    protocolVersion: headers.get("mcp-protocol-version"),
  };
}

export function clientInfoFromMeta(meta: unknown): Pick<McpCaller, "clientName" | "clientVersion"> {
  if (!meta || typeof meta !== "object") return {};
  const info = (meta as Record<string, unknown>)["io.modelcontextprotocol/clientInfo"];
  if (!info || typeof info !== "object") return {};
  const { name, version } = info as Record<string, unknown>;
  return {
    ...(typeof name === "string" ? { clientName: name } : {}),
    ...(typeof version === "string" ? { clientVersion: version } : {}),
  };
}

interface ToolResultLike {
  isError?: boolean;
  content?: unknown;
}

function firstText(result: ToolResultLike): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const block = content.find((item) => item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string");
  return block ? (block as { text: string }).text : "";
}

export function isUnknownToolResult(result: ToolResultLike): boolean {
  return result.isError === true && /^Unknown (action |function )?tool\b/.test(firstText(result));
}

export function errorTypeOfResult(result: ToolResultLike): string {
  const text = firstText(result);
  if (/^Invalid arguments\b/.test(text)) return "validation";
  return "Error";
}

export function errorTypeOfThrown(error: unknown): { errorType: string; errorStatus?: number } {
  const status = (error as { statusCode?: unknown; status?: unknown } | null)?.statusCode ?? (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 600) {
    return { errorType: status === 429 ? "rate_limited" : status >= 500 ? "api_5xx" : status === 401 || status === 403 ? "permission" : "api_4xx", errorStatus: status };
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return { errorType: "timeout" };
    return { errorType: error.name || "Error" };
  }
  return { errorType: "internal" };
}

export async function recordHostedToolCall<T extends ToolResultLike>(
  info: { serverName: string; serverVersion?: string | null; toolName: string; caller: McpCaller },
  call: () => Promise<T>,
): Promise<T> {
  if (!productEventsEnabled()) return call();
  const startedAt = new Date();
  const started = performance.now();
  try {
    const result = await call();
    try {
      if (!isUnknownToolResult(result)) {
        captureMcpToolCall({
          kind: "hosted",
          ...info,
          startedAt,
          durationMs: performance.now() - started,
          isError: result?.isError === true,
          errorType: result?.isError === true ? errorTypeOfResult(result) : null,
        });
      }
    } catch {
    }
    return result;
  } catch (error) {
    try {
      captureMcpToolCall({
        kind: "hosted",
        ...info,
        startedAt,
        durationMs: performance.now() - started,
        isError: true,
        ...errorTypeOfThrown(error),
      });
    } catch {
    }
    throw error;
  }
}

const UPSTREAM_REFUSALS: Record<string, string> = {
  tool_missing: "tool_missing",
  tool_changed: "tool_changed",
  unauthorized: "permission",
  token_refresh_failed: "permission",
  insufficient_scope: "permission",
};

export function upstreamThrownOutcome(error: unknown): { errorType: string; errorStatus?: number } {
  const message = error instanceof Error ? error.message : "";
  const code = /^([a-z_]+):/.exec(message)?.[1];
  if (code && UPSTREAM_REFUSALS[code]) return { errorType: UPSTREAM_REFUSALS[code] };
  return errorTypeOfThrown(error);
}

export function upstreamAnswerOutcome(
  status: number,
  message: { error?: { code?: unknown } | null; result?: unknown } | null,
): { isError: boolean; errorType?: string; errorStatus?: number } {
  if (status === 429) return { isError: true, errorType: "rate_limited", errorStatus: status };
  if (status === 401 || status === 403) return { isError: true, errorType: "permission", errorStatus: status };
  if (status >= 500) return { isError: true, errorType: "api_5xx", errorStatus: status };
  if (status < 200 || status >= 300) return { isError: true, errorType: "api_4xx", errorStatus: status };
  if (!message) return { isError: true, errorType: "internal" };
  if (message.error) return { isError: true, errorType: message.error.code === -32602 ? "validation" : "Error" };
  const result = message.result as { isError?: unknown } | null | undefined;
  if (result?.isError === true) return { isError: true, errorType: "Error" };
  return { isError: false };
}
