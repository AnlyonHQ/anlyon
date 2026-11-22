import { createHash, randomBytes } from "node:crypto";
import type { ApiKeyScope } from "../auth/api-key-scopes.ts";
import { readBodyLimited } from "../../lib/read-body.ts";
import { safeFetch, SsrfBlockedError } from "../../lib/safe-http.ts";
import { validateUrl } from "../../utils/url-validation.ts";
import { signStandardWebhook, standardWebhookKey } from "../../utils/crypto.ts";
import { deleteMcpSubscription, upsertMcpSubscription } from "../events/service.ts";
import { QuotaExceededError } from "../billing/usage-enforcement.ts";
import { MCP_EVENTS, mcpEvent } from "./catalog.ts";

export interface McpEventsPrincipal {
  userId: string;
  clientId: string;
  workspaceId: string;
  environmentId: string;
  scopes: readonly ApiKeyScope[];
}

export class McpEventsError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "McpEventsError";
  }
}

export const INVALID_PARAMS = -32602;
export const CALLBACK_ENDPOINT_ERROR = -32015;
export const FORBIDDEN = -31003;
export const QUOTA_EXCEEDED = -31029;

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_TTL_MS = DEFAULT_TTL_MS;
export const MIN_TTL_MS = 10 * 60 * 1000;

const CHALLENGE_TIMEOUT_MS = 10_000;
const CHALLENGE_RESPONSE_MAX_BYTES = 4 * 1024;

const NO_ARGUMENTS_SCHEMA = { type: "object", properties: {}, additionalProperties: false } as const;

export function listEvents() {
  return {
    events: MCP_EVENTS.map((event) => ({
      name: event.name,
      description: event.description,
      delivery: ["webhook"],
      inputSchema: NO_ARGUMENTS_SCHEMA,
      payloadSchema: event.payloadSchema,
    })),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface Target {
  name: string;
  url: string;
}

function parseTarget(params: unknown): Target & { delivery: Record<string, unknown> } {
  if (!isObject(params)) throw new McpEventsError(INVALID_PARAMS, "params must be an object");
  const { name, arguments: args, delivery } = params;
  if (typeof name !== "string" || !mcpEvent(name)) {
    throw new McpEventsError(INVALID_PARAMS, `Unknown event ${JSON.stringify(name)}. Call events/list.`);
  }
  if (args !== undefined && !(isObject(args) && Object.keys(args).length === 0)) {
    throw new McpEventsError(INVALID_PARAMS, `${name} takes no arguments`);
  }
  if (!isObject(delivery) || delivery.mode !== "webhook" || typeof delivery.url !== "string") {
    throw new McpEventsError(INVALID_PARAMS, 'delivery must be { mode: "webhook", url, ... }');
  }
  return { name, url: delivery.url, delivery };
}

export function mcpSubscriptionId(principal: McpEventsPrincipal, target: Target): string {
  const identity = [
    principal.userId,
    principal.clientId,
    principal.workspaceId,
    principal.environmentId,
    target.url,
    target.name,
    "{}",
  ].join("\n");
  return `sub_mcp_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

function assertAllowed(principal: McpEventsPrincipal, name: string): void {
  const needed: ApiKeyScope[] = ["events:write", (mcpEvent(name) as NonNullable<ReturnType<typeof mcpEvent>>).readScope];
  const missing = needed.filter((scope) => !principal.scopes.includes(scope));
  if (missing.length > 0) {
    throw new McpEventsError(FORBIDDEN, `Subscribing to ${name} needs ${missing.join(" and ")}`, { missing });
  }
}

async function verifyCallback(url: string, secret: string): Promise<void> {
  const challenge = randomBytes(24).toString("base64url");
  const body = JSON.stringify({ type: "verification", challenge });
  const webhookId = `msg_verification_${randomBytes(12).toString("hex")}`;
  const timestamp = Math.floor(Date.now() / 1000);

  let response: Response;
  try {
    response = await safeFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signStandardWebhook(webhookId, timestamp, body, secret),
      },
      body,
      signal: AbortSignal.timeout(CHALLENGE_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      throw new McpEventsError(CALLBACK_ENDPOINT_ERROR, "Callback address is not public", { reason: "forbidden_destination" });
    }
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new McpEventsError(CALLBACK_ENDPOINT_ERROR, "Callback endpoint did not answer the challenge", {
      reason: timedOut ? "timeout" : "unreachable",
    });
  }

  const text = (await readBodyLimited(response, CHALLENGE_RESPONSE_MAX_BYTES)).text;
  let echoed: unknown;
  try {
    echoed = (JSON.parse(text) as { challenge?: unknown }).challenge;
  } catch {
    echoed = undefined;
  }
  if (!response.ok || echoed !== challenge) {
    throw new McpEventsError(CALLBACK_ENDPOINT_ERROR, "Callback endpoint failed the challenge", {
      reason: "challenge_failed",
      status: response.status,
    });
  }
}

export async function subscribe(principal: McpEventsPrincipal, params: unknown) {
  const target = parseTarget(params);
  assertAllowed(principal, target.name);

  const checked = validateUrl(target.url);
  if (!checked.valid) throw new McpEventsError(INVALID_PARAMS, `delivery.url: ${checked.error}`);
  if (new URL(target.url).protocol !== "https:") {
    throw new McpEventsError(INVALID_PARAMS, "delivery.url must be https");
  }

  const secret = target.delivery.secret;
  try {
    if (typeof secret !== "string") throw new Error("delivery.secret is required");
    standardWebhookKey(secret);
  } catch (error) {
    throw new McpEventsError(INVALID_PARAMS, `delivery.secret: ${(error as Error).message}`);
  }

  const ttlMs = (params as { ttlMs?: unknown }).ttlMs;
  if (ttlMs !== undefined && ttlMs !== null && (typeof ttlMs !== "number" || !Number.isInteger(ttlMs) || ttlMs <= 0)) {
    throw new McpEventsError(INVALID_PARAMS, "ttlMs must be a positive integer");
  }
  const granted = Math.min(Math.max((ttlMs as number | null | undefined) ?? DEFAULT_TTL_MS, MIN_TTL_MS), MAX_TTL_MS);
  const expiresAt = new Date(Date.now() + granted);

  await verifyCallback(target.url, secret as string);

  const id = mcpSubscriptionId(principal, target);
  try {
    await upsertMcpSubscription({
      workspaceId: principal.workspaceId,
      environmentId: principal.environmentId,
      subscriptionId: id,
      url: target.url,
      secret: secret as string,
      mcpEventName: target.name,
      platformTypes: (mcpEvent(target.name) as NonNullable<ReturnType<typeof mcpEvent>>).platformTypes,
      principal: `${principal.userId}:${principal.clientId}`,
      expiresAt,
    });
  } catch (error) {
    if (error instanceof QuotaExceededError) throw new McpEventsError(QUOTA_EXCEEDED, error.message);
    throw error;
  }

  return { id, refreshBefore: expiresAt.toISOString(), cursor: null, truncated: false };
}

export async function unsubscribe(principal: McpEventsPrincipal, params: unknown) {
  const target = parseTarget(params);
  await deleteMcpSubscription(principal.workspaceId, mcpSubscriptionId(principal, target));
  return {};
}
