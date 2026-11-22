import { redactCutTail, redactValues } from "../../utils/redaction.ts";
import { safeFetch } from "../../lib/safe-http.ts";
import { readBodyLimited } from "../../lib/read-body.ts";
import { env } from "../../config/env.ts";
import { outcomeOfDispatchError } from "../actions/dispatch-errors.ts";
import { encodeFormBody } from "../actions/form-encoding.ts";
import { applyAccountHost, SECRET_REF } from "../actions/template.ts";
import type { AnyEffectAdapter } from "./adapter.ts";

export interface ProviderRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  payload?: { encoding: "json" | "form"; value: unknown };
}

export interface ProviderResponse {
  status: number;
  bodyText: string;
  json: unknown;
  truncated: boolean;
  headers?: Record<string, string>;
}

export const RESPONSE_HEADERS = ["content-type", "mcp-session-id", "www-authenticate"] as const;

export class TransportError extends Error {
  constructor(message: string, readonly requestSent: boolean) {
    super(message);
    this.name = "TransportError";
  }
}

export interface ProviderStreamLimits {
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  maxBytes: number;
  maxLineBytes: number;
}

export interface ProviderStream {
  status: number;
  headers: Record<string, string>;
  lines(): AsyncIterable<string>;
  close(): void;
}

export interface ProviderTransport {
  request(request: ProviderRequest): Promise<ProviderResponse>;
  stream?(request: ProviderRequest, limits: ProviderStreamLimits): Promise<ProviderStream>;
}

export function redact(text: string, secrets: readonly string[]): string {
  return redactValues(text, secrets);
}

export function adapterTransport(
  adapter: Pick<AnyEffectAdapter, "hosts" | "authHeaders" | "maxResponseBytes">,
  credential: string | ReadonlyMap<string, string>,
  opts: { timeoutMs?: number; accountHost?: string | null } = {},
): ProviderTransport {
  return createProviderTransport({
    hosts: adapter.hosts,
    ...(typeof credential === "string"
      ? { credential, authHeaders: (value: string) => adapter.authHeaders(value) }
      : { secrets: credential }),
    maxResponseBytes: adapter.maxResponseBytes,
    timeoutMs: opts.timeoutMs,
    accountHost: opts.accountHost ?? null,
  });
}

function secretValue(secrets: ReadonlyMap<string, string>, name: string): string {
  const value = secrets.get(name);
  if (value === undefined) throw new TransportError(`Secret ${name} is not available to this request. Nothing was sent`, false);
  return value;
}

function resolveText(text: string, secrets: ReadonlyMap<string, string> | undefined): string {
  return secrets ? text.replace(SECRET_REF, (_m, name: string) => secretValue(secrets, name)) : text;
}

function resolveValue(value: unknown, secrets: ReadonlyMap<string, string> | undefined): unknown {
  if (typeof value === "string") return resolveText(value, secrets);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, secrets)]));
}

export function createProviderTransport(opts: {
  hosts: readonly string[];
  credential?: string;
  authHeaders?: (credential: string) => Record<string, string>;
  secrets?: ReadonlyMap<string, string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  accountHost?: string | null;
}): ProviderTransport {
  const allowed = new Set(opts.hosts.map((host) => host.toLowerCase()));
  const named = opts.secrets;
  const secretsNow = () => [...(opts.credential !== undefined ? [opts.credential] : []), ...(named?.values() ?? [])];
  const prepare = (req: ProviderRequest): { url: URL; headers: Record<string, string>; body: string | undefined } => {
    let withHost: string;
    try {
      withHost = applyAccountHost(req.url, opts.accountHost ?? null);
    } catch {
      throw new TransportError("The request needs the account's own host and none was resolved. Nothing was sent", false);
    }
    const target = resolveText(withHost, named);
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new TransportError("Adapter produced an invalid URL", false);
    }
    if (url.protocol !== "https:" || !allowed.has(url.hostname.toLowerCase()) || url.username || url.password) {
      throw new TransportError(`Adapter may not reach ${url.protocol}//${url.hostname}`, false);
    }
    const headers: Record<string, string> = {
      ...Object.fromEntries(Object.entries(req.headers ?? {}).map(([name, value]) => [name, resolveText(value, named)])),
      ...(opts.credential !== undefined && opts.authHeaders ? opts.authHeaders(opts.credential) : {}),
    };
    let body = req.body;
    if (req.payload) {
      const value = resolveValue(req.payload.value, named);
      body = req.payload.encoding === "form" ? encodeFormBody((value ?? {}) as Record<string, unknown>) : JSON.stringify(value);
    }
    return { url, headers, body };
  };
  const headersOf = (response: Response, secrets: readonly string[]): Record<string, string> => {
    const responseHeaders: Record<string, string> = {};
    for (const name of RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) responseHeaders[name] = redact(value, secrets).slice(0, 500);
    }
    return responseHeaders;
  };
  return {
    async request(req) {
      const secrets = secretsNow();
      const { url, headers, body } = prepare(req);
      let response: Response;
      try {
        response = await safeFetch(url.toString(), {
          method: req.method,
          headers,
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? env.ACTION_TIMEOUT_MS),
        });
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error), secrets).slice(0, 500);
        throw new TransportError(message, outcomeOfDispatchError(error) === "unknown");
      }
      let bodyText = "";
      let truncated = false;
      try {
        const read = await readBodyLimited(response, opts.maxResponseBytes ?? env.ACTION_MAX_RESPONSE_BYTES);
        bodyText = redact(read.truncated ? redactCutTail(read.text, secrets) : read.text, secrets);
        truncated = read.truncated;
      } catch (error) {
        bodyText = `[response body unavailable: ${redact(error instanceof Error ? error.message : "unreadable", secrets).slice(0, 200)}]`;
        truncated = true;
      }
      let json: unknown = null;
      if (!truncated) {
        try { json = JSON.parse(bodyText); } catch { json = null; }
      }
      return { status: response.status, bodyText, json, truncated, headers: headersOf(response, secrets) };
    },

    async stream(req, limits) {
      const secrets = secretsNow();
      const { url, headers, body } = prepare(req);
      const controller = new AbortController();
      let reason: string | null = null;
      const stop = (why: string) => {
        if (reason === null) reason = why;
        controller.abort();
      };
      const total = setTimeout(() => stop(`the stream reached its ${limits.totalTimeoutMs} ms limit`), limits.totalTimeoutMs);
      total.unref?.();
      const connect = setTimeout(() => stop(`no response within ${limits.connectTimeoutMs} ms`), limits.connectTimeoutMs);
      connect.unref?.();
      let response: Response;
      try {
        response = await safeFetch(url.toString(), { method: req.method, headers, body, signal: controller.signal });
      } catch (error) {
        clearTimeout(total);
        const message = reason ?? redact(error instanceof Error ? error.message : String(error), secrets).slice(0, 500);
        throw new TransportError(message, outcomeOfDispatchError(error) === "unknown");
      } finally {
        clearTimeout(connect);
      }
      const reader = response.body?.getReader() ?? null;
      const aborted = new Promise<never>((_resolve, reject) => {
        const fail = () => reject(new TransportError(reason ?? "the stream was closed", true));
        if (controller.signal.aborted) fail();
        else controller.signal.addEventListener("abort", fail, { once: true });
      });
      aborted.catch(() => {});
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(total);
        stop("the stream was closed");
        reader?.cancel().catch(() => {});
      };
      async function* lines(): AsyncGenerator<string> {
        if (!reader) return;
        const decoder = new TextDecoder();
        let buffer = "";
        let bytes = 0;
        const tooLong = () => {
          stop(`a line of the stream was longer than ${limits.maxLineBytes} bytes`);
          return new TransportError(reason!, true);
        };
        try {
          for (;;) {
            if (closed) throw new TransportError(reason ?? "the stream was closed", true);
            const idle = setTimeout(() => stop(`no data for ${limits.idleTimeoutMs} ms`), limits.idleTimeoutMs);
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
              chunk = await Promise.race([reader.read(), aborted]);
            } catch (error) {
              if (error instanceof TransportError) throw error;
              throw new TransportError(reason ?? redact(error instanceof Error ? error.message : "the stream failed", secrets).slice(0, 200), true);
            } finally {
              clearTimeout(idle);
            }
            if (chunk.done || !chunk.value) break;
            bytes += chunk.value.byteLength;
            if (bytes > limits.maxBytes) {
              stop(`the stream sent more than ${limits.maxBytes} bytes`);
              throw new TransportError(reason!, true);
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            for (;;) {
              const at = buffer.search(/[\r\n]/);
              if (at < 0 || (buffer[at] === "\r" && at === buffer.length - 1)) break;
              const end = buffer[at] === "\r" && buffer[at + 1] === "\n" ? at + 2 : at + 1;
              const line = buffer.slice(0, at);
              buffer = buffer.slice(end);
              if (Buffer.byteLength(line) > limits.maxLineBytes) throw tooLong();
              yield redact(line, secrets);
            }
            if (buffer.length > limits.maxLineBytes) throw tooLong();
          }
          buffer += decoder.decode();
          if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1);
          if (buffer) {
            if (Buffer.byteLength(buffer) > limits.maxLineBytes) throw tooLong();
            yield redact(buffer, secrets);
          }
        } finally {
          close();
        }
      }
      return { status: response.status, headers: headersOf(response, secrets), lines, close };
    },
  };
}
