import { stripUnstorable } from "../../utils/storable-text.ts";
import { TransportError, type ProviderResponse, type ProviderStream, type ProviderTransport } from "../effects/transport.ts";

export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const ACCEPTED_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set(["2025-11-25", "2025-06-18", "2025-03-26"]);
export const SSE_PROTOCOL_VERSION = "2024-11-05";
export const MAX_LIST_PAGES = 20;
export const MCP_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_TOOLS = 500;
export const MAX_LISTING_BYTES = MCP_MAX_RESPONSE_BYTES;
const SESSION_ID = /^[\x21-\x7E]{1,500}$/;
const CLIENT_INFO = { name: "anlyon", version: "1" };

export type McpTransportKind = "streamable-http" | "sse";
export const MCP_TRANSPORT_KINDS: readonly McpTransportKind[] = ["streamable-http", "sse"];

export const SSE_FALLBACK_STATUSES: ReadonlySet<number> = new Set([400, 404, 405]);

export interface SseLimits {
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  sessionTimeoutMs: number;
  responseTimeoutMs: number;
  maxStreamBytes: number;
  maxEventBytes: number;
  maxEvents: number;
}

export const SSE_LIMITS: Readonly<SseLimits> = {
  connectTimeoutMs: 10_000,
  idleTimeoutMs: 30_000,
  sessionTimeoutMs: 120_000,
  responseTimeoutMs: 60_000,
  maxStreamBytes: 16 * 1024 * 1024,
  maxEventBytes: MCP_MAX_RESPONSE_BYTES,
  maxEvents: 1_000,
};

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

const isResponseTo = (message: unknown, id: number): message is JsonRpcMessage =>
  message !== null && typeof message === "object" && (message as JsonRpcMessage).id === id
  && !("method" in (message as object))
  && ("result" in (message as object) || "error" in (message as object));

export function responseFor(response: ProviderResponse, id: number): JsonRpcMessage | null {
  const type = response.headers?.["content-type"]?.toLowerCase() ?? "";
  const matches = (message: unknown): message is JsonRpcMessage =>
    message !== null && typeof message === "object" && (message as JsonRpcMessage).id === id
    && ("result" in (message as object) || "error" in (message as object));
  if (!type.includes("text/event-stream")) {
    const body = response.json;
    if (Array.isArray(body)) return body.find(matches) ?? null;
    return matches(body) ? body : null;
  }
  if (response.truncated) return null;
  for (const event of response.bodyText.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) continue;
    try {
      const message = JSON.parse(data) as unknown;
      if (matches(message)) return message;
    } catch {
    }
  }
  return null;
}

export class McpReadError extends TransportError {
  wwwAuthenticate: string | null = null;

  constructor(message: string, readonly status: number | null = null) {
    super(`${stripUnstorable(message)}. The tool was not called; nothing was sent.`, false);
    this.name = "McpReadError";
  }
}

export interface McpServerInfo {
  protocolVersion: string;
  serverInfo: { name?: string; title?: string; version?: string } | null;
}

export function sseEndpointOf(registered: string, data: string): string {
  const raw = data.trim();
  if (!raw) throw new McpReadError("the event stream's endpoint event named no URL");
  if (raw.includes("{{") || raw.includes("}}")) throw new McpReadError("the event stream's endpoint holds a template reference, which Anlyon refuses");
  let endpoint: URL;
  try {
    endpoint = new URL(raw, registered);
  } catch {
    throw new McpReadError("the event stream's endpoint is not a URL");
  }
  const base = new URL(registered);
  if (endpoint.protocol !== "https:") {
    throw new McpReadError(`the event stream named an endpoint over ${endpoint.protocol.replace(/:$/, "").slice(0, 20)}, and Anlyon sends messages only over https`);
  }
  if (endpoint.origin !== base.origin || endpoint.username || endpoint.password) {
    throw new McpReadError(`the event stream named an endpoint on another origin (${endpoint.origin.slice(0, 200)}), and Anlyon sends messages only to ${base.origin}`);
  }
  endpoint.hash = "";
  const href = endpoint.toString();
  if (href.includes("{{") || href.includes("}}")) throw new McpReadError("the event stream's endpoint holds a template reference, which Anlyon refuses");
  return href;
}

export function sessionIdOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  if (!SESSION_ID.test(header) || header.includes("{{") || header.includes("}}")) {
    throw new McpReadError("the server issued a session id that is not visible ASCII, or that holds a template reference, which Anlyon refuses");
  }
  return header;
}

type Answer = { message: JsonRpcMessage; text: string } | { lost: string };

class SseChannel {
  private readonly waiting = new Map<number, (answer: Answer) => void>();
  private events = 0;
  failure: string | null = null;

  private constructor(private readonly stream: ProviderStream, private readonly limits: SseLimits) {}

  static async open(transport: ProviderTransport, url: string, headers: Record<string, string>, limits: SseLimits): Promise<{ channel: SseChannel; endpoint: string }> {
    if (!transport.stream) throw new McpReadError("this connection cannot read an event stream");
    let stream: ProviderStream;
    try {
      stream = await transport.stream({ method: "GET", url, headers: { ...headers, Accept: "text/event-stream" } }, {
        connectTimeoutMs: limits.connectTimeoutMs,
        idleTimeoutMs: limits.idleTimeoutMs,
        totalTimeoutMs: limits.sessionTimeoutMs,
        maxBytes: limits.maxStreamBytes,
        maxLineBytes: limits.maxEventBytes,
      });
    } catch (error) {
      throw new McpReadError(`the event stream failed: ${error instanceof Error ? error.message : "no response"}`);
    }
    if (stream.status < 200 || stream.status >= 300) {
      stream.close();
      const failure = new McpReadError(`the event stream answered HTTP ${stream.status}`, stream.status);
      failure.wwwAuthenticate = stream.headers["www-authenticate"] ?? null;
      throw failure;
    }
    if (!(stream.headers["content-type"] ?? "").toLowerCase().includes("text/event-stream")) {
      stream.close();
      throw new McpReadError("the server answered the GET without an event stream", stream.status);
    }
    const channel = new SseChannel(stream, limits);
    let data: string;
    try {
      data = await channel.start();
    } catch (error) {
      channel.close();
      throw new McpReadError(`the event stream ended before its endpoint: ${error instanceof Error ? error.message : "no endpoint"}`);
    }
    try {
      return { channel, endpoint: sseEndpointOf(url, data) };
    } catch (error) {
      channel.close();
      throw error;
    }
  }

  private start(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(`no endpoint event within ${this.limits.connectTimeoutMs} ms`), this.limits.connectTimeoutMs);
      timer.unref?.();
      let settled = false;
      const onEndpoint = (data: string) => {
        settled = true;
        clearTimeout(timer);
        resolve(data);
      };
      const onFailure = (why: string) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error(why));
        }
      };
      void this.pump(onEndpoint, onFailure);
    });
  }

  private async pump(onEndpoint: (data: string) => void, onFailure: (why: string) => void): Promise<void> {
    let type = "";
    let data: string[] = [];
    let size = 0;
    let first = true;
    try {
      for await (const line of this.stream.lines()) {
        if (this.failure) break;
        if (line === "") {
          const event = type || "message";
          const payload = data.join("\n");
          const empty = data.length === 0;
          type = "";
          data = [];
          size = 0;
          if (empty) continue;
          if (++this.events > this.limits.maxEvents) throw new Error(`the server sent more than ${this.limits.maxEvents} events`);
          if (first) {
            first = false;
            if (event !== "endpoint") throw new Error("its first event was not an endpoint event");
            onEndpoint(payload);
            continue;
          }
          if (event === "message") this.deliver(payload);
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") type = value;
        else if (field === "data") {
          size += Buffer.byteLength(value) + 1;
          if (size > this.limits.maxEventBytes) throw new Error(`an event was larger than ${this.limits.maxEventBytes} bytes`);
          data.push(value);
        }
      }
      if (!this.failure) throw new Error("the server closed the event stream");
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "the event stream failed");
    }
    onFailure(this.failure ?? "the event stream ended");
  }

  private deliver(payload: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      const id = message !== null && typeof message === "object" ? (message as JsonRpcMessage).id : undefined;
      if (typeof id !== "number" || !isResponseTo(message, id)) continue;
      this.waiting.get(id)?.({ message, text: Array.isArray(parsed) ? JSON.stringify(message) : payload });
    }
  }

  expect(id: number): Promise<Answer> {
    if (this.failure) return Promise.resolve({ lost: this.failure });
    return new Promise<Answer>((resolve) => {
      const timer = setTimeout(() => done({ lost: `no response within ${this.limits.responseTimeoutMs} ms` }), this.limits.responseTimeoutMs);
      timer.unref?.();
      const done = (answer: Answer) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(answer);
      };
      this.waiting.set(id, done);
    });
  }

  forget(id: number): void {
    this.waiting.get(id)?.({ lost: "not awaited" });
  }

  private fail(why: string): void {
    if (this.failure) return;
    this.failure = why;
    this.stream.close();
    for (const done of [...this.waiting.values()]) done({ lost: why });
  }

  close(): void {
    this.fail("the session ended");
  }
}

export interface McpSessionOptions {
  transport?: McpTransportKind | "auto";
  limits?: Partial<SseLimits>;
}

export class McpSession {
  private nextId = 1;
  private sessionId: string | null = null;
  private protocolVersion = MCP_PROTOCOL_VERSION;
  private readonly mode: McpTransportKind | "auto";
  private kind: McpTransportKind;
  private readonly limits: SseLimits;
  private sse: { channel: SseChannel; endpoint: string } | null = null;
  private lost: string | null = null;
  requestsSent = 0;

  constructor(
    private readonly transport: ProviderTransport,
    private readonly url: string,
    private readonly baseHeaders: Record<string, string>,
    options: McpSessionOptions = {},
  ) {
    this.mode = options.transport ?? "streamable-http";
    this.kind = this.mode === "sse" ? "sse" : "streamable-http";
    this.limits = { ...SSE_LIMITS, ...options.limits };
  }

  get transportKind(): McpTransportKind {
    return this.kind;
  }

  private headers(): Record<string, string> {
    if (this.kind === "sse") {
      return { ...this.baseHeaders, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    }
    return {
      ...this.baseHeaders,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": this.protocolVersion,
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
    };
  }

  state(): { sessionId: string | null; protocolVersion: string } {
    return { sessionId: this.sessionId, protocolVersion: this.protocolVersion };
  }

  resume(state: { sessionId: string | null; protocolVersion: string }): void {
    this.sessionId = state.sessionId;
    this.protocolVersion = state.protocolVersion;
  }

  reset(): void {
    this.close();
    this.sessionId = null;
    this.protocolVersion = MCP_PROTOCOL_VERSION;
  }

  close(): void {
    this.sse?.channel.close();
    this.sse = null;
  }

  async send(method: string, params: Record<string, unknown>): Promise<{ id: number; response: ProviderResponse }> {
    const id = this.nextId++;
    this.requestsSent++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (this.kind === "sse") return { id, response: await this.sendOnStream(id, body) };
    const response = await this.transport.request({
      method: "POST",
      url: this.url,
      headers: this.headers(),
      body,
    });
    return { id, response };
  }

  private async sendOnStream(id: number, body: string): Promise<ProviderResponse> {
    const sse = this.sse;
    if (!sse || sse.channel.failure) {
      throw new TransportError(`The event stream closed before the request (${sse?.channel.failure ?? "not open"}). Nothing was sent`, false);
    }
    const answer = sse.channel.expect(id);
    let posted: ProviderResponse;
    try {
      posted = await this.transport.request({ method: "POST", url: sse.endpoint, headers: this.headers(), body });
    } catch (error) {
      sse.channel.forget(id);
      throw error;
    }
    if (posted.status < 200 || posted.status >= 300 || responseFor(posted, id)) {
      sse.channel.forget(id);
      return posted;
    }
    const outcome = await answer;
    if ("message" in outcome) {
      return { status: posted.status, bodyText: outcome.text, json: outcome.message, truncated: false, headers: { "content-type": "application/json" } };
    }
    this.lost = outcome.lost;
    return {
      status: posted.status,
      bodyText: `[no response on the event stream: ${outcome.lost}]`,
      json: null,
      truncated: true,
      headers: { "content-type": "text/event-stream" },
    };
  }

  async read(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    let sent: { id: number; response: ProviderResponse };
    this.lost = null;
    try {
      sent = await this.send(method, params);
    } catch (error) {
      throw new McpReadError(`${method} failed: ${error instanceof Error ? error.message : "no response"}`);
    }
    const { id, response } = sent;
    if (response.status < 200 || response.status >= 300) {
      const failure = new McpReadError(`${method} answered HTTP ${response.status}`, response.status);
      failure.wwwAuthenticate = response.headers?.["www-authenticate"] ?? null;
      throw failure;
    }
    const message = responseFor(response, id);
    if (!message) {
      throw new McpReadError(this.lost ? `${method} got no response on the event stream: ${this.lost}` : `${method} returned no JSON-RPC response`, response.status);
    }
    if (message.error) {
      throw new McpReadError(`${method} returned error ${String(message.error.code)}: ${String(message.error.message ?? "").slice(0, 200)}`, response.status);
    }
    if (message.result === null || typeof message.result !== "object") throw new McpReadError(`${method} returned no result`, response.status);
    if (method === "initialize" && this.kind === "streamable-http") this.sessionId = sessionIdOf(response.headers?.["mcp-session-id"]);
    return message.result as Record<string, unknown>;
  }

  private async openStream(): Promise<void> {
    this.close();
    this.requestsSent++;
    this.sse = await SseChannel.open(this.transport, this.url, this.baseHeaders, this.limits);
  }

  private async handshake(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.kind === "sse") {
      try {
        await this.openStream();
      } catch (error) {
        const status = error instanceof McpReadError ? error.status : null;
        if (status === null || !(SSE_FALLBACK_STATUSES.has(status) || (status >= 200 && status < 300))) throw error;
        this.kind = "streamable-http";
        return this.read("initialize", params);
      }
      return this.read("initialize", params);
    }
    try {
      return await this.read("initialize", params);
    } catch (error) {
      if (this.mode !== "auto" || !(error instanceof McpReadError) || error.status === null || !SSE_FALLBACK_STATUSES.has(error.status) || !this.transport.stream) {
        throw error;
      }
      this.kind = "sse";
      try {
        await this.openStream();
      } catch (streamError) {
        if (streamError instanceof McpReadError && (streamError.status === 401 || streamError.status === 403)) throw streamError;
        this.kind = "streamable-http";
        const why = streamError instanceof Error ? streamError.message.replace(/\. The tool was not called; nothing was sent\.$/, "") : "no stream";
        throw new McpReadError(`initialize answered HTTP ${error.status}, and the server did not open an HTTP+SSE event stream either (${why})`, error.status);
      }
      return this.read("initialize", params);
    }
  }

  async initialize(): Promise<McpServerInfo> {
    const result = await this.handshake({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    const version = typeof result.protocolVersion === "string" ? result.protocolVersion : "";
    const accepted = ACCEPTED_PROTOCOL_VERSIONS.has(version) || (this.kind === "sse" && version === SSE_PROTOCOL_VERSION);
    if (!accepted) throw new McpReadError(`the server speaks MCP ${version || "(unstated)"}, which Anlyon does not support`);
    this.protocolVersion = version;
    try {
      this.requestsSent++;
      await this.transport.request({
        method: "POST",
        url: this.sse ? this.sse.endpoint : this.url,
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
    } catch (error) {
      throw new McpReadError(`notifications/initialized failed: ${error instanceof Error ? error.message : "no response"}`);
    }
    const info = result.serverInfo !== null && typeof result.serverInfo === "object" ? result.serverInfo as Record<string, unknown> : null;
    const text = (value: unknown) => (typeof value === "string" ? stripUnstorable(value.slice(0, 200)) : undefined);
    return {
      protocolVersion: version,
      serverInfo: info ? { name: text(info.name), title: text(info.title), version: text(info.version) } : null,
    };
  }

  async listTools(): Promise<unknown[]> {
    const tools: unknown[] = [];
    let bytes = 0;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await this.read("tools/list", cursor ? { cursor } : {});
      const listed = Array.isArray(result.tools) ? result.tools : [];
      bytes += Buffer.byteLength(JSON.stringify(listed));
      if (bytes > MAX_LISTING_BYTES) throw new McpReadError(`the server's tool listing is larger than ${MAX_LISTING_BYTES} bytes`);
      for (const tool of listed) tools.push(tool);
      if (tools.length > MAX_TOOLS) throw new McpReadError(`the server lists more than ${MAX_TOOLS} tools`);
      if (typeof result.nextCursor !== "string" || !result.nextCursor) return tools;
      cursor = result.nextCursor;
    }
    throw new McpReadError(`tools/list did not end within ${MAX_LIST_PAGES} pages`);
  }

  async findTool(name: string): Promise<unknown | null> {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await this.read("tools/list", cursor ? { cursor } : {});
      const tools = Array.isArray(result.tools) ? result.tools : [];
      const found = tools.find((tool) => tool !== null && typeof tool === "object" && (tool as { name?: unknown }).name === name);
      if (found) return found;
      if (typeof result.nextCursor !== "string" || !result.nextCursor) return null;
      cursor = result.nextCursor;
    }
    throw new McpReadError(`tools/list did not end within ${MAX_LIST_PAGES} pages`);
  }
}
