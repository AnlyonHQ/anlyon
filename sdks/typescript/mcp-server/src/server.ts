/**
 * MCP server setup  creates the Server instance, registers all tools,
 * and wires the callTool handler.
 *
 * The tool list is the static tools plus the workspace's own Actions, resolved
 * per request from the caller's API key (see tools/dynamic-actions.ts): define
 * an action in the dashboard and it shows up in the model's tool list.
 *
 * By default the list is the governed execution tools: actions, approvals,
 * reviewer and workspace tools. The events tools are registered but hidden,
 * and a hidden tool is not callable either. ANLYON_MCP_LEGACY_TOOLS=1 brings
 * them back.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { eventsTools } from './tools/events.ts';
import { agentTools } from './tools/agent.ts';
import { workspaceTools } from './tools/workspace.ts';
import { reviewerTools } from './tools/reviewer.ts';
import { signOffTools } from './tools/sign-offs.ts';
import type { ConsentScope, ToolAnnotations } from './tools/types.ts';
import {
  dynamicActionsEnabled,
  getActionTools,
  isActionToolName,
} from './tools/dynamic-actions.ts';
import { describeRun, getFunctionTools, isFunctionToolName } from './tools/dynamic-functions.ts';
import { resolveApiKey } from './auth.ts';
import { getClient } from './client-factory.ts';
import { validateArgs } from './validation.ts';
import { SERVER_NAME, SERVER_VERSION } from './pkg.ts';

export const ALL_TOOLS = [
  ...eventsTools,
  ...agentTools,
  ...reviewerTools,
  ...signOffTools,
  ...workspaceTools,
];
const toolMap = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/**
 * The tools hidden by default: the events tools (pub/sub over /api/v2/events).
 * They are not part of governed execution and are off by default. Set
 * ANLYON_MCP_LEGACY_TOOLS=1 to list and call them. Version 3 removed the
 * memory, queue, files, semantic cache, session and context tools, whose API
 * no longer exists.
 */
export const LEGACY_TOOL_NAMES: ReadonlySet<string> = new Set(eventsTools.map((t) => t.name));

export function isLegacyTool(name: string): boolean {
  return LEGACY_TOOL_NAMES.has(name);
}

/** Read per call, so a host that sets the variable after import is honoured. */
export function legacyToolsEnabled(): boolean {
  return process.env.ANLYON_MCP_LEGACY_TOOLS === '1';
}

/** The static tools served by default: everything that is not legacy. */
export const DEFAULT_TOOLS = ALL_TOOLS.filter((t) => !isLegacyTool(t.name));

/**
 * The hiding predicate for one request: the legacy default composed with
 * whatever the host passed. A caller's predicate can hide more, never less.
 */
function hiddenFor(options: ServerOptions): (name: string) => boolean {
  const legacy = legacyToolsEnabled() ? () => false : isLegacyTool;
  const caller = options.hiddenTools;
  return caller ? (name) => legacy(name) || caller(name) : legacy;
}

/** Every generated action tool invokes through the actions consent group. */
const ACTION_TOOL_SCOPES: readonly ConsentScope[] = ['anlyon:actions'];

/** The consent groups a tool needs, generated action tools included. */
export function scopesOfTool(name: string): readonly ConsentScope[] {
  return toolMap.get(name)?.scopes ?? (isActionToolName(name) ? ACTION_TOOL_SCOPES : []);
}

/**
 * Hide every tool that needs a consent group the caller was not granted.
 *
 * For OAuth hosts: the tool list then matches the consent screen, so a model is
 * never offered a tool every call of which would be refused. Calling a hidden
 * tool by name answers as an unknown tool. API-key callers carry their scopes
 * on the key, not in the request, and are never filtered by this.
 */
export function hiddenOutsideGrant(grantedGroups: readonly string[]): (name: string) => boolean {
  const granted = new Set(grantedGroups);
  return (name) => scopesOfTool(name).some((scope) => !granted.has(scope));
}

const MISSING_KEY_MESSAGE =
  'ANLYON_API_KEY is not set. Get your API key from the Anlyon dashboard (Workspace Settings → API Keys).';

/** OAuth security scheme for a tool: the consent groups it needs. */
export interface SecurityScheme {
  type: 'oauth2';
  scopes: ConsentScope[];
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  securitySchemes: SecurityScheme[];
  /** MCP's extension field; the default presentation never sets it. */
  _meta?: Record<string, unknown>;
}

function toDescriptor(
  tool: { name: string; description: string; inputSchema: object; annotations: ToolAnnotations },
  scopes: readonly ConsentScope[]
): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
    annotations: tool.annotations,
    securitySchemes: [{ type: 'oauth2', scopes: [...scopes] }],
  };
}

type ToolResult = CallToolResult;

const text = (body: string, isError = false): ToolResult => ({
  content: [{ type: 'text' as const, text: body }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Tools this deployment does not serve.
 *
 * A catalogue that advertises a tool whose endpoint answers 404 is worse than
 * one that omits it: the model calls it, fails, and has no way to know the
 * feature is switched off rather than broken. The published binary passes
 * nothing — it cannot know what the remote deployment has turned off — but a
 * host that owns the feature registry (the hosted MCP route does) passes one,
 * so discovery and HTTP availability agree.
 */
export interface ServerOptions {
  /**
   * Composed with the legacy default, never replacing it: a tool is hidden if
   * either says so.
   */
  hiddenTools?: (name: string) => boolean;
  /** How this client is shown the server. Absent: the default, exactly as is. */
  presentation?: Presentation;
  /**
   * Which of the caller's actions are served as `action_<name>` tools, by action
   * name. Absent: all of them. An action it refuses is neither listed nor
   * callable, exactly like a hidden tool. The hosted `/mcp/<pack>` route passes
   * one so each integration's server shows only that integration's actions.
   */
  actions?: (actionName: string) => boolean;
  /**
   * Whether the caller's hosted functions are served as `function_<name>` tools. Absent: they are.
   * An integration's own server passes false: it serves that integration's actions alone.
   */
  functions?: boolean;
}

/**
 * A pure rewrite of what one kind of client sees: the tool list, a tool's
 * result, and a failed call. A host picks one per request (the hosted route
 * picks by OAuth client); the server's tools, data and behaviour are the same
 * for every client. An implementation holds no state and reaches no data; it
 * only transforms what it is given. Core defines the shape and never imports
 * an implementation.
 */
export interface Presentation {
  tools(tools: ToolDescriptor[]): ToolDescriptor[];
  result(toolName: string, result: CallToolResult): CallToolResult;
  /** A call that threw: `error` is what the tool raised, `result` the default error result. */
  failure(toolName: string, error: unknown, result: CallToolResult, scopes: readonly ConsentScope[]): CallToolResult;
}

const errorText = (error: unknown) => text(`Error: ${error instanceof Error ? error.message : String(error)}`, true);

/**
 * What a tool returns when the end user has no working account for the
 * integration an action needs. Nothing was sent. The same shape as the AI SDK
 * adapter's tool result: the model relays `message`, and the app behind it can
 * show `connectUrl` as a "Connect" button.
 */
export interface ConnectRequiredResult {
  /** `connect_required`: never connected. `reconnect_required`: revoked, or a refresh failed. */
  status: 'connect_required' | 'reconnect_required';
  /** The integration the action needs, e.g. `gmail`, or `mcp-<id>` for a tool adopted from an MCP server. */
  integration: string;
  /** The name to show the user, e.g. `Gmail` or the MCP server's own. Absent when the API gave none. */
  displayName?: string;
  /** A connect link for this end user, or null when the environment has no default redirect URL. */
  connectUrl: string | null;
  /** A short sentence the model can relay to the user. */
  message: string;
}

const CONNECT_CODES = {
  END_USER_NOT_CONNECTED: 'connect_required',
  END_USER_RECONNECT_REQUIRED: 'reconnect_required',
} as const;

/**
 * The result for an error that means the end user has to connect, or connect
 * again, or null for any other error. Matched on `code` rather than the class,
 * so it works whichever copy of `@anlyonhq/sdk` threw it.
 */
export function connectRequiredResult(error: unknown): ConnectRequiredResult | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  if (code !== 'END_USER_NOT_CONNECTED' && code !== 'END_USER_RECONNECT_REQUIRED') return null;
  const fields = error as { integration?: unknown; connectUrl?: unknown; displayName?: unknown; details?: unknown };
  const details = (fields.details && typeof fields.details === 'object' ? fields.details : {}) as Record<string, unknown>;
  const first = (...values: unknown[]): string =>
    (values.find((v) => typeof v === 'string' && v) as string | undefined) ?? '';
  const integration = first(fields.integration, details.integration);
  const connectUrl = first(fields.connectUrl, details.connectUrl) || null;
  const displayName = first(fields.displayName, details.displayName);
  const status = CONNECT_CODES[code];
  const named = displayName || integration || 'the account this needs';
  const message =
    status === 'connect_required'
      ? `The user has not connected ${named} yet, so nothing was done. Ask them to connect it, then try again.`
      : `The user's ${named} connection has stopped working, so nothing was done. Ask them to reconnect it, then try again.`;
  return { status, integration, ...(displayName ? { displayName } : {}), connectUrl, message };
}

/**
 * A connect-required error as a result, not an error: the call did what it
 * should (refused before sending anything) and the model has something to tell
 * the user. `structuredContent` carries the fields for a host that renders them.
 */
function connectRequired(error: unknown): ToolResult | null {
  const result = connectRequiredResult(error);
  if (!result) return null;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: { ...result },
  };
}

/** What a tool returns when its change waits for a human's sign-off. */
export interface SignOffRequiredResult {
  status: 'sign_off_required';
  signOffId: string;
  signOffUrl: string;
  summary: string;
  diff: string;
  expiresAt: string | null;
}

/**
 * The fields of a SignOffRequiredError, or null for any other error. Matched on `code` rather than
 * the class, so it works whichever copy of `@anlyonhq/sdk` threw it.
 */
export function signOffRequiredResult(error: unknown): SignOffRequiredResult | null {
  if (!error || typeof error !== 'object' || (error as { code?: unknown }).code !== 'SIGN_OFF_REQUIRED') return null;
  const e = error as { signOff?: unknown; details?: unknown };
  const signOff = (e.signOff ?? e.details) as Record<string, unknown> | undefined;
  if (!signOff || typeof signOff !== 'object' || typeof signOff.id !== 'string' || typeof signOff.signOffUrl !== 'string') return null;
  const str = (value: unknown) => (typeof value === 'string' ? value : '');
  return {
    status: 'sign_off_required',
    signOffId: signOff.id,
    signOffUrl: signOff.signOffUrl,
    summary: str(signOff.summary),
    diff: str(signOff.diff),
    expiresAt: str(signOff.expiresAt) || null,
  };
}

/**
 * A loosening change the server held for a human's sign-off, as a result, not an error: the call
 * did what it should (asked, and applied nothing), and the model has a link to hand to a person.
 * The text leads with that link, so a model that relays one line relays the right one.
 */
export function signOffRequired(error: unknown): ToolResult | null {
  const result = signOffRequiredResult(error);
  if (!result) return null;
  const lines = [
    `A human must approve this change before it applies. Give them this link: ${result.signOffUrl}`,
    '',
    ...(result.summary ? [`Change: ${result.summary}`] : []),
    ...(result.diff ? ['', result.diff, ''] : []),
    `Sign-off id: ${result.signOffId}`,
    ...(result.expiresAt ? [`Expires: ${result.expiresAt}`] : []),
    '',
    'You cannot approve it yourself. Call wait_for_sign_off with this id, or check_sign_off later.',
  ];
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: { ...result },
  };
}

/** A call that threw with an answer the model should relay rather than an error. */
function relayable(error: unknown): ToolResult | null {
  return connectRequired(error) ?? signOffRequired(error);
}

/**
 * The tool list for the current request context: static tools, plus one tool
 * per enabled action in the caller's workspace.
 */
export async function listTools(options: ServerOptions = {}): Promise<{ tools: ToolDescriptor[] }> {
  const hidden = hiddenFor(options);
  const tools: ToolDescriptor[] = ALL_TOOLS.filter((t) => !hidden(t.name)).map((t) => toDescriptor(t, t.scopes));

  const apiKey = resolveApiKey();
  if (apiKey && dynamicActionsEnabled()) {
    const served = options.actions ?? (() => true);
    for (const t of await getActionTools(getClient(apiKey), apiKey)) {
      if (!hidden(t.name) && served(t.actionName)) tools.push(toDescriptor(t, ACTION_TOOL_SCOPES));
    }
    if (options.functions !== false) {
      for (const t of await getFunctionTools(getClient(apiKey), apiKey)) {
        if (!hidden(t.name)) tools.push(toDescriptor(t, ACTION_TOOL_SCOPES));
      }
    }
  }

  return { tools: options.presentation ? options.presentation.tools(tools) : tools };
}

export async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  options: ServerOptions = {}
): Promise<ToolResult> {
  const result = await callDefault(name, args, options);
  const presentation = options.presentation;
  if (!presentation || result.isError) return result;
  return presentation.result(name, result);
}

/** A call that threw, as the default result, or as the presentation rewrites it. */
function failed(name: string, error: unknown, options: ServerOptions): ToolResult {
  const result = errorText(error);
  return options.presentation ? options.presentation.failure(name, error, result, scopesOfTool(name)) : result;
}

async function callDefault(
  name: string,
  args: Record<string, unknown> = {},
  options: ServerOptions = {}
): Promise<ToolResult> {
  const apiKey = resolveApiKey();
  if (!apiKey) return text(MISSING_KEY_MESSAGE, true);

  const client = getClient(apiKey);
  const hidden = hiddenFor(options);
  const tool = hidden(name) ? undefined : toolMap.get(name);

  if (!tool && isFunctionToolName(name)) {
    if (hidden(name) || options.functions === false || !dynamicActionsEnabled()) return text(`Unknown tool: ${name}`, true);
    const functionTool = (await getFunctionTools(client, apiKey)).find((t) => t.name === name);
    if (!functionTool) return text(`Unknown function tool: ${name}.`, true);
    const invalid = validateArgs(functionTool.inputSchema, args);
    if (invalid) return text(`Invalid arguments for ${name}: ${invalid}`, true);
    const input = (args.input ?? {}) as Record<string, unknown>;
    const planRunId = typeof args.planRunId === 'string' ? args.planRunId : undefined;
    try {
      const { data } = await client.functions.run(
        functionTool.functionName,
        planRunId ? { mode: 'apply', planRunId } : { input, mode: 'plan' }
      );
      return text(describeRun(data!));
    } catch (error) {
      return relayable(error) ?? failed(name, error, options);
    }
  }

  if (!tool) {
    if (hidden(name) || !isActionToolName(name) || !dynamicActionsEnabled()) {
      return text(`Unknown tool: ${name}`, true);
    }

    const served = options.actions ?? (() => true);
    const actionTool = (await getActionTools(client, apiKey)).find((t) => t.name === name && served(t.actionName));
    if (!actionTool) {
      return text(
        `Unknown action tool: ${name}. Call list_actions to see what this workspace has defined.`,
        true
      );
    }

    const invalid = validateArgs(actionTool.inputSchema, args);
    if (invalid) return text(`Invalid arguments for ${name}: ${invalid}`, true);

    try {
      const { data } = await client.actions.invoke(actionTool.actionName, args);

      if (data?.pendingApproval) {
        return text(
          `Awaiting human approval. Nothing has been sent. Tell the user it is waiting for them in Anlyon, under Approvals. Call wait_for_approval with approvalId=${data.approvalId} to block until they decide. The action runs by itself once approved, and wait_for_approval returns its outcome.`
        );
      }
      return text(JSON.stringify(data, null, 2));
    } catch (error) {
      return relayable(error) ?? failed(name, error, options);
    }
  }

  const validationError = validateArgs(tool.inputSchema, args);
  if (validationError) return text(`Invalid arguments for ${name}: ${validationError}`, true);

  try {
    return text(JSON.stringify(await tool.handler(client, args), null, 2));
  } catch (error) {
    return relayable(error) ?? failed(name, error, options);
  }
}

export function createServer(options: ServerOptions = {}): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => listTools(options));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments ?? {}, options)
  );

  return server;
}
