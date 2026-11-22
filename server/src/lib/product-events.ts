import { createLogger } from "./logger.ts";

const logger = createLogger({ module: "product-events" });

export interface CaptureOptions {
  workspaceId?: string | null;
  timestamp?: Date;
}

export type McpCallKind = "hosted" | "upstream";

export interface McpCaller {
  distinctId: string;
  isPerson: boolean;
  workspaceId?: string | null;
  clientName?: string | null;
  clientVersion?: string | null;
  userAgent?: string | null;
  vendorClient?: string | null;
  protocolVersion?: string | null;
}

export interface McpToolCallRecord {
  kind: McpCallKind;
  serverName: string;
  serverVersion?: string | null;
  toolName: string;
  startedAt: Date;
  durationMs: number;
  isError: boolean;
  errorType?: string | null;
  errorStatus?: number | null;
  caller: McpCaller;
  sessionId?: string;
  upstreamId?: string | null;
}

export interface ProductEventSink {
  enabled(): boolean;
  capture(event: string, distinctId: string, properties: Record<string, unknown>, options: CaptureOptions): void;
  captureMilestoneOnce(workspaceId: string, event: string, properties: Record<string, unknown>): void;
  captureUserSignedUp(userId: string, properties: { method?: string; source?: string }): void;
  captureMcpToolCall(record: McpToolCallRecord): void;
}

let sink: ProductEventSink | null = null;

export function setProductEventSink(next: ProductEventSink): void {
  if (sink && sink !== next) throw new Error("A product event sink is already registered");
  sink = next;
}

export function resetProductEventSink(): void {
  sink = null;
}

function guarded(event: string, send: (target: ProductEventSink) => void): void {
  if (!sink) return;
  try {
    if (!sink.enabled()) return;
    send(sink);
  } catch (error) {
    logger.debug({ event, error: error instanceof Error ? error.message : error }, "product event failed");
  }
}

export function productEventsEnabled(): boolean {
  try {
    return sink?.enabled() ?? false;
  } catch {
    return false;
  }
}

export function capture(event: string, distinctId: string, properties: Record<string, unknown> = {}, options: CaptureOptions = {}): void {
  guarded(event, (target) => target.capture(event, distinctId, properties, options));
}

export function captureMilestoneOnce(workspaceId: string, event: string, properties: Record<string, unknown> = {}): void {
  guarded(event, (target) => target.captureMilestoneOnce(workspaceId, event, properties));
}

export function captureUserSignedUp(userId: string, properties: { method?: string; source?: string } = {}): void {
  guarded("user_signed_up", (target) => target.captureUserSignedUp(userId, properties));
}

export function captureMcpToolCall(record: McpToolCallRecord): void {
  guarded("mcp_tool_call", (target) => target.captureMcpToolCall(record));
}
