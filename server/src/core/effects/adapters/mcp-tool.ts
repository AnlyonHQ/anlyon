import { hashTools, type McpTool } from "@anlyon-dev/risk";
import { isFeatureEnabled } from "@anlyon/feature-flags";
import type { ActionDeclarations, ActionMcpBinding } from "../../../db/schema/actions.ts";
import { ValidationError } from "../../../utils/errors.ts";
import { stripUnstorable } from "../../../utils/storable-text.ts";
import { LOOSE_REASONS, validateMcpArguments, type SchemaCheck } from "../../../utils/mcp-json-schema.ts";
import { assertNoSecretRef, hasInputRef, usesAccountHost } from "../../actions/template.ts";
import type {
  AdapterCapabilities,
  AdapterContext,
  DispatchRequest,
  EffectAdapter,
  EvidenceDraft,
  ImpactQuantity,
  Interpretation,
  Observation,
  PreviewDraft,
  ReconcileRequest,
} from "../adapter.ts";
import { declaredHost, impactQuantity, parseImpactDeclaration } from "../declarations.ts";
import { MCP_MAX_RESPONSE_BYTES, McpReadError, McpSession, responseFor, type JsonRpcMessage } from "../../mcp-upstreams/client.ts";
import { cacheSession, dropCachedSession, getCachedSession, sessionKey } from "../../mcp-upstreams/session-cache.ts";
import { endUserKeyHeader, withEndUserKeyRef } from "../../mcp-upstreams/end-user-key.ts";
import { TransportError } from "../transport.ts";
import { captureMcpToolCall, upstreamAnswerOutcome, upstreamThrownOutcome } from "../../../lib/mcp-analytics.ts";

export { responseFor };

export const MCP_TOOL_TYPE = "mcp.tool";
export const MCP_TOOL_VERSION = "1";

const PREVIEW_ARGUMENTS_LIMIT = 4000;
const LOOSE_PREVIEW_NOTE = "Loosely checked. This server's input schema uses something Anlyon doesn't check, so the arguments are sent as the agent wrote them, shown here in full.";
const RESULT_SUMMARY_LIMIT = 500;
const TOOL_HASH = /^[0-9a-f]{64}$/;
const OAUTH_CONNECTION = /^mcp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BEFORE_EXECUTION_CODES = new Set([-32700, -32600, -32601, -32602]);

export interface McpToolDefinition {
  urlTemplate: string;
  headers: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  mcp: ActionMcpBinding;
  declarations: ActionDeclarations | null;
}

export interface McpToolRequest {
  url: string;
  headers: Record<string, string>;
  tool: string;
  toolHash: string;
  arguments: Record<string, unknown>;
  impact: ImpactQuantity[];
  schemaCheck?: "loose";
}

function requestOf(operation: { request: Record<string, unknown> }): McpToolRequest {
  return operation.request as unknown as McpToolRequest;
}

function parseBinding(raw: unknown): ActionMcpBinding {
  const value = (raw ?? {}) as Record<string, unknown>;
  if (typeof value.upstreamId !== "string" || !value.upstreamId) throw new ValidationError("An MCP tool action needs the upstream it was adopted from.");
  if (typeof value.toolName !== "string" || !value.toolName) throw new ValidationError("An MCP tool action needs a tool name.");
  if (typeof value.toolHash !== "string" || !TOOL_HASH.test(value.toolHash)) throw new ValidationError("An MCP tool action needs the tool's definition hash.");
  const classes = ["read", "write", "irreversible", "destructive"];
  if (typeof value.suggestedClass !== "string" || !classes.includes(value.suggestedClass)) {
    throw new ValidationError(`An MCP tool action's suggested class must be one of ${classes.join(", ")}.`);
  }
  if (value.oauthConnection !== undefined && (typeof value.oauthConnection !== "string" || !OAUTH_CONNECTION.test(value.oauthConnection))) {
    throw new ValidationError("An MCP tool action's OAuth connection must name its upstream.");
  }
  const endUserKey = value.endUserKey as { connection?: unknown; header?: unknown } | undefined;
  if (endUserKey !== undefined) {
    if (endUserKey === null || typeof endUserKey !== "object" || typeof endUserKey.connection !== "string" || !OAUTH_CONNECTION.test(endUserKey.connection)
      || typeof endUserKey.header !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(endUserKey.header)) {
      throw new ValidationError("An MCP tool action's end-user key must name its upstream and the header the key is sent in.");
    }
    if (value.oauthConnection !== undefined) throw new ValidationError("An MCP tool action's upstream either signs people in with OAuth or takes each end user's own key, not both.");
  }
  if (value.schemaCheck !== undefined && value.schemaCheck !== "full" && value.schemaCheck !== "loose") {
    throw new ValidationError("An MCP tool action's schema check must be full or loose.");
  }
  if (value.schemaCheckReason !== undefined && !(LOOSE_REASONS as readonly unknown[]).includes(value.schemaCheckReason)) {
    throw new ValidationError(`An MCP tool action's schema check reason must be one of ${LOOSE_REASONS.join(", ")}.`);
  }
  return {
    upstreamId: value.upstreamId,
    toolName: value.toolName,
    toolHash: value.toolHash,
    suggestedClass: value.suggestedClass as ActionMcpBinding["suggestedClass"],
    ...(value.oauthConnection ? { oauthConnection: value.oauthConnection as string } : {}),
    ...(endUserKey ? { endUserKey: { connection: endUserKey.connection as string, header: endUserKey.header as string } } : {}),
    ...(value.schemaCheck ? { schemaCheck: value.schemaCheck } : {}),
    ...(value.schemaCheck === "loose" && value.schemaCheckReason ? { schemaCheckReason: value.schemaCheckReason as string } : {}),
  };
}

function parseDefinition(raw: unknown): McpToolDefinition {
  const value = (raw ?? {}) as Record<string, unknown>;
  if (typeof value.urlTemplate !== "string") throw new ValidationError("An MCP tool action needs the upstream's https endpoint.");
  const url = value.urlTemplate;
  declaredHost(url);
  if (hasInputRef(url) || usesAccountHost(url) || url.includes("{{")) {
    throw new ValidationError("An MCP tool action's endpoint is fixed: it takes no placeholder.");
  }
  const headers = (value.headers as Record<string, unknown> | null | undefined) ?? {};
  for (const [name, header] of Object.entries(headers)) {
    if (typeof header !== "string") throw new ValidationError(`Header ${name} must be text.`);
    if (hasInputRef(header) || usesAccountHost(header)) throw new ValidationError(`Header ${name} is fixed at adoption: it takes no input.`);
    if (/\{\{\s*connection:/.test(header)) throw new ValidationError(`Header ${name} may not name a connection: an OAuth upstream's token is added at dispatch.`);
  }
  const inputSchema = (value.inputSchema as Record<string, unknown> | null | undefined) ?? {};
  const declared = (value.declarations ?? null) as Record<string, unknown> | null;
  if (declared?.verify) throw new ValidationError("An MCP tool action cannot declare a read-back yet.");
  const impact = declared?.impact ? parseImpactDeclaration(declared.impact) : null;
  const mcp = parseBinding(value.mcp);
  if (mcp.endUserKey) endUserKeyHeader(headers as Record<string, string>, mcp.endUserKey.header);
  return {
    urlTemplate: url,
    headers,
    inputSchema,
    mcp,
    declarations: impact ? { impact, verify: null } : null,
  };
}

function capabilitiesOf(declarations: ActionDeclarations | null): AdapterCapabilities {
  return {
    idempotency: {
      supported: false,
      retentionSeconds: null,
      description: "MCP has no idempotency key. Anlyon calls the tool once and never repeats the call.",
    },
    outcomeLookup: {
      supported: false,
      description: "Anlyon cannot read an MCP tool's result back. A lost response stays unknown until an operator resolves it.",
    },
    conditionalMutation: {
      supported: false,
      description: "MCP has no conditional call. The tool's definition is checked in the same session just before the call; the server's state is not.",
    },
    asynchronousCompletion: {
      supported: false,
      description: "The tool's result is recorded as the outcome. Work the server finishes later is not tracked.",
    },
    compensation: {
      supported: false,
      actionHint: null,
      description: "Anlyon does not know how to undo this tool. Adopt the tool that reverses it as its own governed action.",
    },
    sameKeyReplay: {
      supported: false,
      windowSeconds: null,
      description: "Not supported. Without an idempotency key a repeated call could apply twice, so a replay is refused before anything is sent.",
    },
    reversible: {
      supported: false,
      description: "Anlyon cannot reverse an MCP tool call. Whether the server can is not known to Anlyon.",
    },
    unsupported: [
      "Idempotency",
      "Atomic stale-state protection",
      "Replay of a lost call",
      "Read-back verification. A result is graded acknowledged and never confirmed",
      "A guarantee that the tool is unchanged between the definition check and the call, which are two requests in one session",
      "A call without a listing first. Every call lists the tools to check the adopted definition; only the handshake before it is reused, for a few minutes",
      "A check that the tool's isError flag tells the truth. The result is graded as the tool reports it",
    ],
    impactDimensions: declarations?.impact ? [declarations.impact.dimension] : [],
  };
}

async function findWithSession(session: McpSession, key: string, name: string): Promise<unknown | null> {
  const cached = session.transportKind === "sse" ? null : getCachedSession(key);
  if (!cached) {
    await session.initialize();
    if (session.transportKind !== "sse") cacheSession(key, session.state());
    return session.findTool(name);
  }
  session.resume(cached);
  try {
    return await session.findTool(name);
  } catch (error) {
    dropCachedSession(key);
    if (!(error instanceof McpReadError) || error.status !== 404 || cached.sessionId === null) throw error;
    session.reset();
    await session.initialize();
    cacheSession(key, session.state());
    return session.findTool(name);
  }
}

async function currentHash(tool: McpTool): Promise<string | null> {
  try {
    return await hashTools([tool]);
  } catch {
    return null;
  }
}

const NOT_SENT_CODES = ["tool_missing", "tool_changed", "token_refresh_failed", "unauthorized", "insufficient_scope"] as const;
type NotSentCode = (typeof NOT_SENT_CODES)[number];

function notSentCode(message: string): NotSentCode | null {
  return NOT_SENT_CODES.find((code) => message.startsWith(`${code}:`)) ?? null;
}

function insufficientScope(challenge: string | null | undefined): string | null {
  if (!challenge || !/error\s*=\s*"?insufficient_scope"?/i.test(challenge)) return null;
  const scope = /scope\s*=\s*"([^"]*)"/i.exec(challenge)?.[1] ?? "";
  return scope.slice(0, 200);
}

async function findAuthorized(ctx: AdapterContext<McpToolDefinition>, session: McpSession, key: string, name: string): Promise<unknown | null> {
  const refused = (error: unknown) => {
    if (!(error instanceof McpReadError)) return error;
    const scope = error.status === 403 ? insufficientScope(error.wwwAuthenticate) : null;
    if (scope !== null) {
      return new TransportError(`insufficient_scope: the server needs the scope "${scope}", which this sign-in was not granted. Reconnect with it. The tool was not called; nothing was sent.`, false);
    }
    return error;
  };
  try {
    return await findWithSession(session, key, name);
  } catch (error) {
    if (!(error instanceof McpReadError) || error.status !== 401 || !ctx.refreshCredential) throw refused(error);
    dropCachedSession(key);
    if (!(await ctx.refreshCredential())) {
      throw new TransportError("token_refresh_failed: the server refused the token and a new one could not be had. Connect again. The tool was not called; nothing was sent.", false);
    }
    session.reset();
    try {
      return await findWithSession(session, key, name);
    } catch (again) {
      if (again instanceof McpReadError && again.status === 401) {
        throw new TransportError("unauthorized: the server refused a newly refreshed token. The tool was not called; nothing was sent.", false);
      }
      throw refused(again);
    }
  }
}

function textOf(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((item): item is { type: string; text: string } => item !== null && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string")
    .map((item) => item.text)
    .join("\n");
  return stripUnstorable(text.length > RESULT_SUMMARY_LIMIT ? `${text.slice(0, RESULT_SUMMARY_LIMIT)} [truncated]` : text);
}

function unknownWith(evidence: EvidenceDraft): Interpretation {
  return { outcome: "unknown", partialEffect: "none", providerReference: null, evidence: [evidence] };
}

export function schemaCheckOf(binding: Pick<ActionMcpBinding, "schemaCheck">): SchemaCheck {
  return binding.schemaCheck === "loose" ? "loose" : "full";
}

export function buildMcpToolAdapter(raw: unknown): EffectAdapter<McpToolDefinition> {
  const definition = parseDefinition(raw);
  const { hostname } = declaredHost(definition.urlTemplate);

  const adapter: EffectAdapter<McpToolDefinition> = {
    type: MCP_TOOL_TYPE,
    version: MCP_TOOL_VERSION,
    title: "Adopted MCP tool",
    successDefinition: "The MCP server answers tools/call with a result that is not marked isError. No read-back exists, so the result is acknowledged and not confirmed.",
    successEvidence: "response_status",
    hosts: [hostname],
    maxResponseBytes: MCP_MAX_RESPONSE_BYTES,
    capabilities: capabilitiesOf(definition.declarations),
    inputSchema: definition.inputSchema,

    parseConfig: parseDefinition,

    checkCredential() {},
    authHeaders() {
      return {};
    },

    normalize(config, input) {
      const check = schemaCheckOf(config.mcp);
      if (check === "loose" || Object.keys(config.inputSchema).length > 0) {
        const checked = validateMcpArguments(config.inputSchema, input, check);
        if (!checked.valid) throw new ValidationError(`Invalid input: ${checked.errors.join(", ")}`);
      }
      assertNoSecretRef(input);
      const { host } = declaredHost(config.urlTemplate);
      const path = new URL(config.urlTemplate).pathname || "/";
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(config.headers)) headers[name] = String(value);
      if (config.mcp.oauthConnection) headers.Authorization = `Bearer {{connection:${config.mcp.oauthConnection}}}`;
      const sent = config.mcp.endUserKey ? withEndUserKeyRef(headers, config.mcp.endUserKey) : headers;
      const impact = config.declarations?.impact ? impactQuantity(config.declarations.impact, input) : null;
      const request: McpToolRequest = {
        url: config.urlTemplate,
        headers: sent,
        tool: config.mcp.toolName,
        toolHash: config.mcp.toolHash,
        arguments: input,
        impact: impact ? [impact] : [],
        ...(check === "loose" ? { schemaCheck: "loose" as const } : {}),
      };
      return {
        target: {
          account: host,
          resourceType: "mcp.tool",
          resourceId: config.mcp.toolName,
          resourceKey: `mcp:${host}${path}#${config.mcp.toolName}`,
          display: { Server: `${host}${path}`, Tool: config.mcp.toolName },
        },
        request: request as unknown as Record<string, unknown>,
      };
    },

    describeImpact(operation) {
      return requestOf(operation).impact;
    },

    async preparePreview(_ctx, operation): Promise<PreviewDraft> {
      const request = requestOf(operation);
      const loose = request.schemaCheck === "loose";
      const args = loose ? JSON.stringify(request.arguments, null, 2) : JSON.stringify(request.arguments);
      return {
        blocks: [{
          type: "fields",
          title: "Tool call",
          fields: [
            { label: "Server", value: request.url },
            { label: "Tool", value: request.tool },
            { label: "Tool definition", value: `sha256 ${request.toolHash}. A tool that no longer matches it is not called.` },
            ...Object.entries(request.headers).map(([name, value]) => ({ label: `Header ${name}`, value })),
            ...(loose ? [{ label: "Input check", value: LOOSE_PREVIEW_NOTE }] : []),
            { label: "Arguments", value: !loose && args.length > PREVIEW_ARGUMENTS_LIMIT ? `${args.slice(0, PREVIEW_ARGUMENTS_LIMIT)} [truncated]` : args },
          ],
        }],
        preconditions: { host: operation.target.account, tool: request.tool, toolHash: request.toolHash },
        evidence: {
          source: "system",
          observedAt: new Date(),
          impliedOutcome: null,
          providerIds: {},
          summary: "Previewed from the adopted tool and the input. The server was not read.",
          details: {},
        },
      };
    },

    async dispatch(ctx, request: DispatchRequest): Promise<Observation> {
      if (request.kind === "replay") {
        throw new TransportError("An MCP tool has no idempotency key, so a lost call is not repeated. Nothing was sent.", false);
      }
      if (!isFeatureEnabled("mcp-upstreams")) {
        throw new TransportError("MCP upstreams are not enabled on this deployment. Nothing was sent.", false);
      }
      const req = requestOf(request.operation);
      const session = new McpSession(ctx.transport, req.url, req.headers, { transport: ctx.mcpTransport ?? "auto" });
      const startedAt = new Date();
      const started = performance.now();
      let outcome: { isError: boolean; errorType?: string; errorStatus?: number } = { isError: true, errorType: "internal" };
      try {
        const key = sessionKey({
          workspaceId: ctx.environment.workspaceId ?? null,
          environmentId: ctx.environment.id,
          upstreamId: ctx.config.mcp.upstreamId,
          endUserId: ctx.config.mcp.oauthConnection || ctx.config.mcp.endUserKey ? ctx.endUserId ?? null : null,
        });
        const tool = (await findAuthorized(ctx, session, key, req.tool)) as McpTool | null;
        if (!tool) {
          throw new TransportError(`tool_missing: the server no longer lists ${req.tool}. The tool was not called; nothing was sent.`, false);
        }
        const hash = await currentHash(tool);
        if (hash !== req.toolHash) {
          throw new TransportError(
            `tool_changed: ${req.tool} no longer matches the definition it was adopted at (sha256 ${req.toolHash}, now ${hash ?? "unreadable"}). Re-adopt it to review the change. The tool was not called; nothing was sent.`,
            false,
          );
        }
        const preCallRequests = session.requestsSent;
        const { id, response } = await session.send("tools/call", { name: req.tool, arguments: req.arguments });
        const scope = response.status === 403 ? insufficientScope(response.headers?.["www-authenticate"]) : null;
        const json = responseFor(response, id);
        outcome = upstreamAnswerOutcome(response.status, json as JsonRpcMessage | null);
        return {
          kind: "response", status: response.status, json, bodyText: stripUnstorable(response.bodyText), observedAt: new Date(),
          details: { preCallRequests, ...(scope !== null ? { code: "insufficient_scope", requiredScope: scope } : {}) },
        };
      } catch (error) {
        outcome = { isError: true, ...upstreamThrownOutcome(error) };
        throw error;
      } finally {
        session.close();
        const workspaceId = ctx.environment.workspaceId ?? null;
        captureMcpToolCall({
          kind: "upstream",
          serverName: hostname,
          toolName: req.tool,
          upstreamId: ctx.config.mcp.upstreamId,
          startedAt,
          durationMs: performance.now() - started,
          ...outcome,
          caller: { distinctId: workspaceId ?? ctx.environment.id, isPerson: false, workspaceId },
        });
      }
    },

    interpret(request, observation): Interpretation {
      if (request.kind === "replay") {
        return unknownWith({
          source: "system",
          observedAt: observation.observedAt,
          impliedOutcome: null,
          providerIds: {},
          summary: "An MCP tool is not replayed. Nothing was sent and the outcome is unchanged.",
          details: {},
        });
      }
      if (observation.kind === "transport_error") {
        const outcome = observation.requestSent ? "unknown" : "failed";
        const code = observation.requestSent ? null : notSentCode(observation.message);
        return {
          outcome,
          partialEffect: "none",
          providerReference: null,
          evidence: [{
            source: "system",
            observedAt: observation.observedAt,
            impliedOutcome: outcome,
            providerIds: {},
            summary: code === "tool_changed"
              ? "The tool changed since it was adopted, so it was not called."
              : code === "tool_missing"
                ? "The server no longer lists the tool, so it was not called."
                : code === "token_refresh_failed" || code === "unauthorized" || code === "insufficient_scope"
                  ? "The server refused the sign-in before the tool was called, so it was not called."
                  : observation.requestSent
                  ? "The call may have reached the server. No response was received."
                  : "The call never left Anlyon.",
            details: { error: observation.message, ...(code ? { code } : {}) },
          }],
        };
      }
      const message = observation.json as JsonRpcMessage | null;
      const facts = observation.details ?? {};
      const fail = (partialEffect: "none" | "possible", summary: string, details: Record<string, unknown>): Interpretation => ({
        outcome: "failed",
        partialEffect,
        providerReference: null,
        evidence: [{ source: "provider_response", observedAt: observation.observedAt, impliedOutcome: "failed", providerIds: {}, summary, details }],
      });
      if (observation.status >= 500 || (observation.status >= 200 && observation.status < 300 && !message)) {
        return unknownWith({
          source: "provider_response",
          observedAt: observation.observedAt,
          impliedOutcome: "unknown",
          providerIds: {},
          summary: observation.status >= 500
            ? `The server answered HTTP ${observation.status}. The tool may or may not have run.`
            : "The server answered without a readable JSON-RPC response. The tool may or may not have run.",
          details: { status: observation.status, ...facts },
        });
      }
      if (observation.status < 200 || observation.status >= 300) {
        return fail("none", `The server refused the call (HTTP ${observation.status}).`, { status: observation.status, ...facts });
      }
      if (message!.error) {
        const code = typeof message!.error.code === "number" ? message!.error.code : null;
        const before = code !== null && BEFORE_EXECUTION_CODES.has(code);
        return fail(
          before ? "none" : "possible",
          before
            ? `The server rejected the call before running the tool (JSON-RPC ${code}).`
            : `The server returned JSON-RPC error ${code ?? "(no code)"}. The tool may have acted before it failed.`,
          { code, message: stripUnstorable(String(message!.error.message ?? "").slice(0, RESULT_SUMMARY_LIMIT)), ...facts },
        );
      }
      const result = (message!.result ?? {}) as Record<string, unknown>;
      if (result.isError === true) {
        return fail("possible", "The tool reported an error. It may have acted before it failed.", { text: textOf(result), ...facts });
      }
      return {
        outcome: "succeeded",
        partialEffect: "none",
        providerReference: null,
        evidence: [{
          source: "provider_response",
          observedAt: observation.observedAt,
          impliedOutcome: "succeeded",
          providerIds: {},
          summary: "The tool accepted the call and returned a result.",
          details: { text: textOf(result), ...facts },
        }],
      };
    },

    async reconcile(_ctx, request: ReconcileRequest): Promise<Interpretation> {
      return unknownWith({
        source: "system",
        observedAt: request.now,
        impliedOutcome: null,
        providerIds: {},
        summary: "An MCP tool's result cannot be read back. The outcome stays unknown until an operator resolves it.",
        details: {},
      });
    },
  };
  return adapter;
}
