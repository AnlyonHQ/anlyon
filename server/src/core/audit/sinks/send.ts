import { gzipSync } from "node:zlib";
import { safeFetch } from "../../../lib/safe-http.ts";
import { signDeliveryPayload } from "../../../utils/crypto.ts";
import type { AuditExportEvent } from "../event-schema.ts";
import type { DatadogConfig, S3Config, SinkTarget, SplunkConfig } from "./config.ts";
import { amzDate, encodeS3Key, sha256Hex, signV4 } from "./sigv4.ts";

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string | Buffer; signal?: AbortSignal }) => Promise<Response>;

export interface SendResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  durationMs: number;
  location?: string;
}

const TIMEOUT_MS = 15_000;
const USER_AGENT = "Anlyon-Audit/1";
const DATADOG_MAX_BYTES = 4_500_000;

function defaultFetcher(allowPrivateNetwork: boolean): Fetcher {
  return (url, init) =>
    safeFetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal }, { allowPrivateNetwork });
}

export interface SendOptions {
  batchId: string;
  fetcher?: Fetcher;
  now?: Date;
  allowPrivateNetwork?: boolean;
}

export async function sendToSink(target: SinkTarget, events: AuditExportEvent[], options: SendOptions): Promise<SendResult> {
  const started = Date.now();
  const fetcher = options.fetcher ?? defaultFetcher(options.allowPrivateNetwork === true);
  try {
    switch (target.type) {
      case "webhook":
        return finish(started, await sendWebhook(target.config.url, target.credentials.signingSecret, events, options, fetcher));
      case "s3":
        return await sendS3(target.config, target.credentials, events, options, fetcher, started);
      case "datadog":
        return finish(started, await sendDatadog(target.config, target.credentials.apiKey, events, fetcher));
      case "splunk":
        return finish(started, await sendSplunk(target.config, target.credentials.token, events, fetcher));
    }
  } catch (error) {
    return { ok: false, status: null, error: describeError(error), durationMs: Date.now() - started };
  }
}

async function finish(started: number, response: Response): Promise<SendResult> {
  const durationMs = Date.now() - started;
  if (response.ok) return { ok: true, status: response.status, error: null, durationMs };
  return { ok: false, status: response.status, error: await responseError(response), durationMs };
}

const ERROR_BODY_BYTES = 4096;

async function responseError(response: Response): Promise<string> {
  let body = "";
  try {
    const reader = response.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total < ERROR_BODY_BYTES) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        total += value.byteLength;
      }
      await reader.cancel().catch(() => undefined);
      body = Buffer.concat(chunks).subarray(0, ERROR_BODY_BYTES).toString("utf8").slice(0, 300);
    }
  } catch {
  }
  return `HTTP ${response.status}${body ? `: ${body.replace(/\s+/g, " ").trim()}` : ""}`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return `No response within ${TIMEOUT_MS / 1000} seconds`;
    if (error.name === "SsrfBlockedError") return `Destination refused: ${error.message}`;
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    return cause?.code ? `${error.message} (${cause.code})` : error.message;
  }
  return String(error);
}

export function webhookBody(events: AuditExportEvent[], batchId: string): string {
  return JSON.stringify({ schema: "anlyon.audit.batch.v1", batchId, events });
}

export function webhookHeaders(body: string, secret: string, batchId: string, now: Date): Record<string, string> {
  const timestamp = Math.floor(now.getTime() / 1000);
  return {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    "Anlyon-Signature": signDeliveryPayload(body, secret, timestamp),
    "Anlyon-Timestamp": String(timestamp),
    "Anlyon-Batch-Id": batchId,
  };
}

async function sendWebhook(url: string, secret: string, events: AuditExportEvent[], options: SendOptions, fetcher: Fetcher) {
  const body = webhookBody(events, options.batchId);
  return fetcher(url, {
    method: "POST",
    headers: webhookHeaders(body, secret, options.batchId, options.now ?? new Date()),
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export function s3ObjectKey(config: Pick<S3Config, "prefix">, events: AuditExportEvent[], batchId: string): string {
  const first = new Date(events[0]?.occurredAt ?? Date.now());
  const yyyy = first.getUTCFullYear();
  const mm = String(first.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(first.getUTCDate()).padStart(2, "0");
  const time = first.toISOString().slice(11, 19).replace(/:/g, "");
  const prefix = (config.prefix ?? "anlyon-audit").replace(/^\/+|\/+$/g, "");
  return `${prefix ? `${prefix}/` : ""}${yyyy}/${mm}/${dd}/${time}Z-${batchId}.ndjson.gz`;
}

export function s3ObjectUrl(config: S3Config, key: string): { url: string; host: string; path: string } {
  const encodedKey = encodeS3Key(key);
  if (config.endpoint) {
    const endpoint = new URL(config.endpoint);
    const base = endpoint.pathname.replace(/\/+$/, "");
    if (config.forcePathStyle === false) {
      const host = `${config.bucket}.${endpoint.host}`;
      const path = `${base}/${encodedKey}`;
      return { url: `${endpoint.protocol}//${host}${path}`, host, path };
    }
    const path = `${base}/${config.bucket}/${encodedKey}`;
    return { url: `${endpoint.protocol}//${endpoint.host}${path}`, host: endpoint.host, path };
  }
  if (config.forcePathStyle) {
    const host = `s3.${config.region}.amazonaws.com`;
    const path = `/${config.bucket}/${encodedKey}`;
    return { url: `https://${host}${path}`, host, path };
  }
  const host = `${config.bucket}.s3.${config.region}.amazonaws.com`;
  const path = `/${encodedKey}`;
  return { url: `https://${host}${path}`, host, path };
}

export function ndjson(events: AuditExportEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

async function sendS3(
  config: S3Config,
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
  events: AuditExportEvent[],
  options: SendOptions,
  fetcher: Fetcher,
  started: number,
): Promise<SendResult> {
  const key = s3ObjectKey(config, events, options.batchId);
  const { url, host, path } = s3ObjectUrl(config, key);
  const body = gzipSync(Buffer.from(ndjson(events), "utf8"));
  const payloadHash = sha256Hex(body);
  const headers: Record<string, string> = {
    "content-type": "application/gzip",
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate(options.now ?? new Date()),
  };
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;
  const authorization = signV4({
    method: "PUT",
    path,
    headers,
    payloadHash,
    region: config.region,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
  });
  const { host: _host, ...sent } = headers;
  const response = await fetcher(url, {
    method: "PUT",
    headers: { ...sent, authorization, "user-agent": USER_AGENT },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const result = await finish(started, response);
  return result.ok ? { ...result, location: key } : result;
}

export function datadogPayload(config: DatadogConfig, events: AuditExportEvent[]): Array<Record<string, unknown>> {
  const tags = ["source:anlyon", ...(config.tags ?? [])];
  return events.map((event) => ({
    ddsource: "anlyon",
    service: config.service ?? "anlyon",
    hostname: "anlyon",
    ddtags: [...tags, `category:${event.category}`, ...(event.environmentId ? [`environment_id:${event.environmentId}`] : [])].join(","),
    message: JSON.stringify(event),
  }));
}

async function sendDatadog(config: DatadogConfig, apiKey: string, events: AuditExportEvent[], fetcher: Fetcher) {
  const url = `https://http-intake.logs.${config.site}/api/v2/logs`;
  const logs = datadogPayload(config, events);
  const chunks: Array<Array<Record<string, unknown>>> = [];
  let current: Array<Record<string, unknown>> = [];
  let size = 2;
  for (const log of logs) {
    const bytes = Buffer.byteLength(JSON.stringify(log)) + 1;
    if (current.length > 0 && size + bytes > DATADOG_MAX_BYTES) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(log);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current);
  let response: Response | null = null;
  for (const chunk of chunks) {
    response = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "DD-API-KEY": apiKey, "User-Agent": USER_AGENT },
      body: JSON.stringify(chunk),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return response;
  }
  return response ?? new Response(null, { status: 202 });
}

export function splunkUrl(config: Pick<SplunkConfig, "url">): string {
  const base = config.url.replace(/\/+$/, "");
  return /\/services\/collector(\/event)?$/.test(base) ? (base.endsWith("/event") ? base : `${base}/event`) : `${base}/services/collector/event`;
}

export function splunkBody(config: SplunkConfig, events: AuditExportEvent[]): string {
  return events
    .map((event) =>
      JSON.stringify({
        time: new Date(event.occurredAt).getTime() / 1000,
        host: "anlyon",
        source: config.source ?? "anlyon",
        sourcetype: config.sourcetype ?? "anlyon:audit",
        ...(config.index ? { index: config.index } : {}),
        event,
      }),
    )
    .join("\n");
}

async function sendSplunk(config: SplunkConfig, token: string, events: AuditExportEvent[], fetcher: Fetcher) {
  return fetcher(splunkUrl(config), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Splunk ${token}`, "User-Agent": USER_AGENT },
    body: splunkBody(config, events),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}
