/**
 * One AI SDK tool per Anlyon action, the tool result for an end user who has to connect first, and
 * the tool that reads what happened to a call after the person decided.
 *
 * Pass a client from `anlyon.forUser(endUserId)` to act for one of your users. The end user is
 * bound to the client by your server. No tool's input schema has an end-user field, so nothing the
 * model writes can choose or switch the end user.
 */

import { jsonSchema, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { Action, Client, Invocation, InvokeResult } from '@anlyonhq/sdk';

type AnlyonTool = ToolSet[string];

/** The name {@link anlyonTools} gives the check tool, unless `checkTool` renames or removes it. */
export const DEFAULT_CHECK_TOOL_NAME = 'anlyon_check_request';

/** How much of a destination's response body a tool result carries by default. */
export const DEFAULT_MAX_BODY_CHARS = 8000;

/**
 * What a tool returns when the end user has no working connection for the integration an action
 * needs. Nothing was sent. The model relays `message`; your app can render `connectUrl` as a
 * "Connect" button.
 */
export interface ConnectRequiredToolResult {
  /** `connect_required`: never connected. `reconnect_required`: revoked, or a refresh failed. */
  status: 'connect_required' | 'reconnect_required';
  /** The integration the action needs, e.g. `gmail`. */
  integration: string;
  /** The integration's name for people, e.g. `Gmail`. */
  displayName?: string;
  /**
   * A connect link for this end user. It works once, for ten minutes. Null when the environment
   * has no default redirect URL: make one with `endUsers.createConnectLink()` instead.
   */
  connectUrl: string | null;
  /** The end user the call was for, when the API named them. */
  endUserId?: string | null;
  /** The API request's id (`X-Request-Id`), for support. */
  requestId?: string | null;
  /** A short sentence the model can relay to the user. */
  message: string;
}

/** One limit that did not have enough left, as the refusal reported it. */
export interface LimitShortfall {
  /** The limit's name, e.g. `Reminders per day`. */
  name: string;
  /** What this call needed. */
  requested: number;
  /** What the limit had left. */
  available: number;
}

/**
 * Why a call was refused, in a form code can branch on. `impact_limit_exceeded`: a limit had not
 * enough left. `policy_denied`: an approval policy refused it. `approval_denied`: the person
 * declined. `approval_expired`: nobody answered in time. Any other reason Anlyon gives for refusing
 * to send the request comes through as its own lowercase code.
 */
export type RefusalCode = 'impact_limit_exceeded' | 'policy_denied' | 'approval_denied' | 'approval_expired' | (string & {});

/** What a tool from {@link anlyonTools} returns when the action ran, or is waiting for approval. */
export interface ActionToolResult {
  /** The invocation's status: `succeeded`, `failed`, `unknown`, `running`, `denied`, `expired` or `pending_approval`. */
  status: string;
  invocationId: string | null;
  /** Set while the action waits for a person to decide (apr_xxx). */
  approvalId: string | null;
  /** The destination's HTTP status, when the request was sent. */
  responseStatus: number | null;
  /** The destination's response body, when there is one. Cut at `maxBodyChars`, with a marker. */
  body: string | null;
  /** True when `body` was cut short. */
  bodyTruncated?: boolean;
  /** The receipt grade of a governed action, or null for an action with no declaration. */
  grade: string | null;
  /** The receipt (eff_xxx) of a governed action, or null. */
  effectId?: string | null;
  /** The end user the call was made for (`forUser()`), or null for a workspace call. */
  endUserId?: string | null;
  /** The API request's id (`X-Request-Id`) when the API sent one, for support. */
  requestId?: string | null;
  /** Why the call was refused, or null when it was not. */
  code?: RefusalCode | null;
  /** For `impact_limit_exceeded`: each limit that had not enough left. Empty otherwise. */
  limits?: LimitShortfall[];
  /** Anlyon's own reason, for a call that failed or was refused. */
  error?: string | null;
  /** A short sentence the model can relay to the user. */
  message: string;
}

/** Every result a tool from {@link anlyonTools} can return. Check `status` to tell them apart. */
export type AnlyonActionToolResult = ActionToolResult | ConnectRequiredToolResult;

/** What the check tool returns. */
export interface CheckRequestToolResult extends ActionToolResult {
  /** The action the call was for. */
  action: string | null;
  /** The approval's status (`pending`, `approved`, `denied`, `expired`), or null when it had none. */
  approvalStatus: string | null;
}

const CONNECT_CODES = {
  END_USER_NOT_CONNECTED: 'connect_required',
  END_USER_RECONNECT_REQUIRED: 'reconnect_required',
} as const;

/** Names for people, by catalogue id. An error that carries its own `displayName` wins. */
const INTEGRATION_NAMES: Record<string, string> = {
  airtable: 'Airtable',
  asana: 'Asana',
  attio: 'Attio',
  calcom: 'Cal.com',
  calendly: 'Calendly',
  clickup: 'ClickUp',
  close: 'Close',
  discord: 'Discord',
  front: 'Front',
  github: 'GitHub',
  gitlab: 'GitLab',
  gmail: 'Gmail',
  'google-calendar': 'Google Calendar',
  'google-drive': 'Google Drive',
  'google-sheets': 'Google Sheets',
  hubspot: 'HubSpot',
  intercom: 'Intercom',
  jira: 'Jira',
  linear: 'Linear',
  'linear-key': 'Linear',
  mailchimp: 'Mailchimp',
  monday: 'monday.com',
  notion: 'Notion',
  pagerduty: 'PagerDuty',
  pipedrive: 'Pipedrive',
  postmark: 'Postmark',
  resend: 'Resend',
  salesforce: 'Salesforce',
  sendgrid: 'SendGrid',
  sentry: 'Sentry',
  slack: 'Slack',
  stripe: 'Stripe',
  todoist: 'Todoist',
  trello: 'Trello',
  twilio: 'Twilio',
  vercel: 'Vercel',
  zendesk: 'Zendesk',
};

/** `github` → `GitHub`. An id not in the list is title-cased: `acme-crm` → `Acme Crm`. */
export function integrationDisplayName(id: string): string {
  return INTEGRATION_NAMES[id] ?? id.split(/[-_]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * The tool result for an error that means the end user has to connect, or connect again. Returns
 * null for any other error, which the caller should rethrow.
 *
 * Matches on the error's `code` rather than its class, so it works whichever copy of
 * `@anlyonhq/sdk` threw it.
 */
export function connectRequiredResult(error: unknown): ConnectRequiredToolResult | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  if (code !== 'END_USER_NOT_CONNECTED' && code !== 'END_USER_RECONNECT_REQUIRED') return null;
  const fields = error as { integration?: unknown; connectUrl?: unknown; endUserId?: unknown; displayName?: unknown; requestId?: unknown; details?: unknown };
  const details = (fields.details && typeof fields.details === 'object' ? fields.details : {}) as Record<string, unknown>;
  const text = (...values: unknown[]): string => (values.find((v) => typeof v === 'string' && v) as string | undefined) ?? '';
  const integration = text(fields.integration, details.integration);
  const connectUrl = text(fields.connectUrl, details.connectUrl) || null;
  const displayName = text(fields.displayName, details.displayName) || (integration ? integrationDisplayName(integration) : '');
  const status = CONNECT_CODES[code];
  const named = displayName || 'the account this needs';
  const message =
    status === 'connect_required'
      ? `The user has not connected ${named} yet, so nothing was done. Ask them to connect it, then try again.`
      : `The user's ${named} connection has stopped working, so nothing was done. Ask them to reconnect it, then try again.`;
  return {
    status,
    integration,
    ...(displayName ? { displayName } : {}),
    connectUrl,
    endUserId: text(fields.endUserId, details.endUserId) || null,
    requestId: text(fields.requestId) || null,
    message,
  };
}

/** A response body cut to `max` characters, with a marker that says how much was left out. */
export function capBody(body: string | null | undefined, max: number = DEFAULT_MAX_BODY_CHARS): { body: string | null; truncated: boolean } {
  if (body === null || body === undefined) return { body: null, truncated: false };
  const limit = Math.max(0, Math.floor(max));
  if (body.length <= limit) return { body, truncated: false };
  return { body: `${body.slice(0, limit)}…[truncated: ${body.length - limit} more characters]`, truncated: true };
}

/** `Dispatch refused (impact_limit_exceeded): Not enough allowance: Reminders needs 1, has 0.` */
const DISPATCH_REFUSED = /^Dispatch refused \(([a-z0-9_]+)\):\s*([\s\S]*)$/;
const SHORTFALL = /([^:;]+?) needs (\d+(?:\.\d+)?), has (\d+(?:\.\d+)?)/g;

/** Why an invocation was refused, read from its decision or its error. Null when it was not refused. */
export function refusalOf(invocation: Pick<Invocation, 'status' | 'error'> & { decision?: Invocation['decision'] }): { code: RefusalCode; limits: LimitShortfall[] } | null {
  const decision = invocation.decision ?? null;
  if (invocation.status === 'denied') {
    return { code: decision?.code === 'POLICY_DENIED' ? 'policy_denied' : 'approval_denied', limits: [] };
  }
  if (invocation.status === 'expired') return { code: 'approval_expired', limits: [] };
  if (invocation.status !== 'failed' || !invocation.error) return null;
  const refused = DISPATCH_REFUSED.exec(invocation.error);
  if (!refused) return null;
  const code = refused[1]!;
  const limits: LimitShortfall[] = [];
  if (code === 'impact_limit_exceeded') {
    const text = refused[2]!.replace(/^Not enough allowance:\s*/, '');
    for (const match of text.matchAll(SHORTFALL)) {
      limits.push({ name: match[1]!.trim(), requested: Number(match[2]), available: Number(match[3]) });
    }
  }
  return { code, limits };
}

export interface DescribeOptions {
  /** The check tool's name, when the model has one. The pending message tells the model to call it. */
  checkTool?: string | null;
  /** How much of the response body the message quotes. Default {@link DEFAULT_MAX_BODY_CHARS}. */
  maxBodyChars?: number;
}

/** The sentence for an invocation, as `invokeAction` words it. */
export function describeInvocation(name: string, data: InvokeResult | Invocation, options: DescribeOptions = {}): string {
  const pending = 'pendingApproval' in data ? data.pendingApproval : data.status === 'pending_approval';
  if (pending) {
    const check = options.checkTool
      ? ` Nothing has happened yet. When the user says they decided, call ${options.checkTool} with invocationId "${data.id}" to read the outcome. Do not call "${name}" again.`
      : '';
    return `Action "${name}" needs human approval before it runs. Approval id: ${data.approvalId}. It will execute automatically once approved.${check}`;
  }
  const grade = data.grade ? ` Receipt grade: ${data.grade}.` : '';
  if (data.status === 'succeeded') {
    const { body } = capBody(data.body, options.maxBodyChars);
    return `Action "${name}" succeeded (HTTP ${data.responseStatus}): ${body ?? ''}${grade}`;
  }
  if (data.status === 'unknown') {
    return `Action "${name}" has an unknown outcome. The request may have reached the destination. Do not invoke it again. It has to be reconciled in Anlyon first.${grade}`;
  }
  if (data.status === 'running') {
    return `Action "${name}" is still running. Do not invoke it again.${grade}`;
  }
  const refusal = refusalOf(data);
  if (refusal?.code === 'impact_limit_exceeded') {
    const which = refusal.limits.length
      ? ` (${refusal.limits.map((l) => `${l.name}: needs ${l.requested}, ${l.available} left`).join('; ')})`
      : '';
    return `Action "${name}" was refused because a limit was reached${which}. Nothing was sent. Do not retry it now.`;
  }
  if (refusal?.code === 'policy_denied') return `Action "${name}" was refused by policy, so it did not run.${data.decision?.explanation ? ` ${data.decision.explanation}` : ''}`;
  if (refusal?.code === 'approval_denied') return `Action "${name}" was declined, so it did not run.`;
  if (refusal?.code === 'approval_expired') return `Nobody answered the approval for "${name}" in time, so it did not run.`;
  return `Action "${name}" failed: ${data.error ?? `HTTP ${data.responseStatus}`}${grade}`;
}

/** A success response's request id, when the API put one in the body. Read defensively. */
function requestIdOf(response: unknown): string | null {
  const value = response && typeof response === 'object' ? (response as { requestId?: unknown }).requestId : undefined;
  return typeof value === 'string' && value ? value : null;
}

/** The structured result for an invocation. */
function resultOf(name: string, data: InvokeResult | Invocation, requestId: string | null, options: DescribeOptions): ActionToolResult {
  const pending = 'pendingApproval' in data ? data.pendingApproval : data.status === 'pending_approval';
  const { body, truncated } = capBody(data.body, options.maxBodyChars);
  const refusal = refusalOf(data);
  return {
    status: pending ? 'pending_approval' : data.status,
    invocationId: data.id ?? null,
    approvalId: data.approvalId ?? null,
    responseStatus: data.responseStatus ?? null,
    body,
    bodyTruncated: truncated,
    grade: data.grade ?? null,
    effectId: data.effectId ?? null,
    endUserId: data.endUserId ?? null,
    requestId,
    code: refusal?.code ?? null,
    limits: refusal?.limits ?? [],
    error: data.error ?? null,
    message: describeInvocation(name, data, options),
  };
}

/** A tool name the providers accept: letters, digits, `_` and `-`, at most 64 characters. */
function toolName(actionName: string): string {
  return actionName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

const EMPTY_INPUT_SCHEMA = { type: 'object', properties: {} } as const;

function inputSchema(action: Action): Record<string, unknown> {
  const schema = action.inputSchema;
  return schema && typeof schema === 'object' && schema.type === 'object' ? schema : { ...EMPTY_INPUT_SCHEMA };
}

function description(action: Action): string {
  const own = action.description?.trim() || `Invoke the Anlyon action ${action.name}.`;
  const gate = action.requiresApproval ? ' A person approves each call before it runs.' : '';
  return `${own}${gate}`;
}

export interface ActionToolOptions {
  /** The check tool's name, which a `pending_approval` message tells the model to call. Null for none. */
  checkTool?: string | null;
  /** How much of the destination's response body the result carries. Default 8,000 characters. */
  maxBodyChars?: number;
}

/** Build the tool for one action. Exported for callers that hold the `Action` already. */
export function anlyonActionTool(client: Client, action: Action, options: ActionToolOptions = {}): AnlyonTool {
  return tool({
    description: description(action),
    inputSchema: jsonSchema<Record<string, unknown>>(inputSchema(action) as Parameters<typeof jsonSchema>[0]),
    execute: async (input): Promise<AnlyonActionToolResult> => {
      try {
        const response = await client.actions.invoke(action.name, input ?? {});
        const data = response.data;
        if (!data) throw new Error(`Action "${action.name}" returned no data.`);
        return resultOf(action.name, data, requestIdOf(response), options);
      } catch (error) {
        const connect = connectRequiredResult(error);
        if (connect) return connect;
        throw error;
      }
    },
  });
}

export interface CheckRequestToolOptions {
  /**
   * How long to wait, at most, for a call that was just approved to finish running. Default 6,000
   * ms. A call still waiting for a decision is answered at once.
   */
  settleMs?: number;
  /** How much of the destination's response body the result carries. Default 8,000 characters. */
  maxBodyChars?: number;
}

const SETTLE_POLL_MS = 1000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  return status === 404 || code === 'NOT_FOUND' || code === 'INVOCATION_NOT_FOUND';
}

async function approvalStatusOf(client: Client, approvalId: string | null): Promise<string | null> {
  if (!approvalId) return null;
  try {
    const { data } = await client.approvals.get(approvalId);
    return data?.status ?? null;
  } catch {
    return null;
  }
}

/**
 * A tool that reads what happened to an earlier action call: whether the person approved or
 * declined it, and its result once it ran. It reads with the same client the action tools use, so
 * a `forUser()` client reads only that end user's calls.
 *
 * Give the model this tool with the action tools ({@link anlyonTools} does, as
 * `anlyon_check_request`), and it can report the outcome after the user answers an approval in your
 * app, without calling the action again.
 */
export function anlyonCheckRequestTool(client: Client, options: CheckRequestToolOptions = {}): AnlyonTool {
  const settleMs = Math.max(0, options.settleMs ?? 6000);
  return tool({
    description:
      'Read what happened to an earlier Anlyon action call: whether it was approved or declined, and its result once it ran. Call it after the user says they approved or declined, with the invocationId from that call\'s result. Never call the action again to find out.',
    inputSchema: z.object({ invocationId: z.string().min(1).describe('The inv_ id from the earlier result') }),
    execute: async ({ invocationId }): Promise<CheckRequestToolResult> => {
      const deadline = Date.now() + settleMs;
      let invocation: Invocation | undefined;
      let requestId: string | null = null;
      let approvalStatus: string | null = null;
      for (;;) {
        try {
          const response = await client.actions.invocation(invocationId);
          invocation = response.data;
          requestId = requestIdOf(response);
        } catch (error) {
          if (!isNotFound(error)) throw error;
          invocation = undefined;
        }
        if (!invocation) break;
        approvalStatus = await approvalStatusOf(client, invocation.approvalId);
        const settling =
          invocation.status === 'running' || (invocation.status === 'pending_approval' && approvalStatus === 'approved');
        if (!settling || Date.now() + SETTLE_POLL_MS > deadline) break;
        await sleep(SETTLE_POLL_MS);
      }

      if (!invocation) {
        return {
          status: 'not_found', action: null, invocationId, approvalId: null, approvalStatus: null, responseStatus: null,
          body: null, bodyTruncated: false, grade: null, effectId: null, endUserId: null, requestId, code: null, limits: [],
          error: null, message: 'Anlyon has no call with that id for this user.',
        };
      }
      const name = invocation.actionName;
      const base = resultOf(name, invocation, requestId, { maxBodyChars: options.maxBodyChars });
      let message = base.message;
      if (invocation.status === 'pending_approval') {
        message = approvalStatus === 'approved'
          ? `It was approved and "${name}" is about to run. Check again in a moment. Do not call "${name}" again.`
          : `"${name}" is still waiting for the user's decision. Nothing has happened yet. Do not call it again.`;
      } else if (invocation.status === 'succeeded') {
        message = `${approvalStatus === 'approved' ? 'It was approved and ' : ''}${base.message}`;
      }
      return { ...base, action: name, approvalStatus, message };
    },
  });
}

export interface AnlyonToolsOptions {
  /**
   * The client the tools call. Pass `anlyon.forUser(endUserId)` to act for one of your users: each
   * call then uses that end user's connections, limits and approvals.
   */
  client: Client;
  /**
   * The actions to expose, by name. Omit for every enabled action. A name the workspace does not
   * have, or a disabled action, is an error.
   */
  actions?: readonly string[];
  /**
   * The tool that reads what happened to a call after the person decided. Added as
   * `anlyon_check_request` by default. Pass a string to name it yourself, or `false` to leave it out
   * (then a `pending_approval` message does not mention it).
   */
  checkTool?: string | false;
  /** How much of a destination's response body a tool result carries. Default 8,000 characters. */
  maxBodyChars?: number;
}

/**
 * One tool per Anlyon action, for `streamText` or `generateText`, and `anlyon_check_request`, which
 * reads what happened after an approval. Each action tool's input schema is the action's own, and
 * no tool has an end-user field.
 *
 * When the end user has not connected the integration an action needs, the tool does not throw.
 * It returns `{ status: 'connect_required', integration, displayName, connectUrl, message }` (or
 * `reconnect_required`), so the model can tell the user and your app can show a "Connect" button.
 *
 * @example
 * ```ts
 * import { streamText } from 'ai';
 * import { anthropic } from '@ai-sdk/anthropic';
 * import { Client } from '@anlyonhq/sdk';
 * import { anlyonTools } from '@anlyonhq/ai-sdk';
 *
 * const anlyon = new Client({ apiKey: process.env.ANLYON_API_KEY!, baseUrl: process.env.ANLYON_BASE_URL });
 *
 * // In your route handler, with the user from your own session:
 * const tools = await anlyonTools({
 *   client: anlyon.forUser(session.user.id),
 *   actions: ['gmail-send-email', 'google-calendar-create-event'],
 * });
 * const result = streamText({ model: anthropic('claude-sonnet-5-5'), tools, prompt });
 * ```
 */
export async function anlyonTools(options: AnlyonToolsOptions): Promise<ToolSet> {
  const { client, actions: wanted, maxBodyChars } = options;
  const checkTool = options.checkTool === false ? null : options.checkTool ?? DEFAULT_CHECK_TOOL_NAME;
  if (checkTool !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(checkTool)) {
    throw new Error(`checkTool must be 1 to 64 letters, digits, "_" or "-": "${checkTool}".`);
  }
  const { data } = await client.actions.list();
  const listed = data ?? [];
  let chosen: Action[];
  if (wanted === undefined) {
    chosen = listed.filter((action) => action.enabled);
  } else {
    const byName = new Map(listed.map((action) => [action.name, action]));
    const missing = wanted.filter((name) => !byName.get(name)?.enabled);
    if (missing.length > 0) {
      throw new Error(`These actions do not exist or are disabled in this environment: ${missing.join(', ')}.`);
    }
    chosen = wanted.map((name) => byName.get(name)!);
  }

  const tools: ToolSet = {};
  for (const action of chosen) {
    const name = toolName(action.name);
    if (tools[name]) throw new Error(`Two actions map to the tool name "${name}". Pass \`actions\` to choose one.`);
    tools[name] = anlyonActionTool(client, action, { checkTool, maxBodyChars });
  }
  if (checkTool !== null) {
    if (tools[checkTool]) throw new Error(`An action maps to the tool name "${checkTool}". Pass \`checkTool\` to name the check tool something else.`);
    tools[checkTool] = anlyonCheckRequestTool(client, { maxBodyChars });
  }
  return tools;
}
