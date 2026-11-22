/**
 * Dynamic action tools  a workspace's Actions, surfaced as first-class MCP tools.
 *
 * Define an action in the Anlyon dashboard and it appears in the model's tool
 * list as `action_<name>`, with the action's own input schema. The generic
 * `invoke_action` tool still works; this exists because a model picks a tool it
 * can see far more reliably than one it has to remember to name.
 *
 * The action list is fetched per API key and cached briefly, so `tools/list`
 * (which some hosts call on every turn) does not hammer the API.
 */

import { createHash } from 'node:crypto';
import type { Action, Client } from '@anlyonhq/sdk';
import { resolveCacheScope } from '../auth.ts';
import type { ToolAnnotations } from './types.ts';

/** Prefix keeps generated names from ever colliding with a static tool. */
export const ACTION_TOOL_PREFIX = 'action_';

/**
 * What the hosts accept, with this server under the key `anlyon` that `anlyon setup` writes. The MCP
 * spec allows more, but Claude Code sends `mcp__anlyon__<tool>` to an API that caps a name at 64, so 51
 * are left, and Cursor caps server name plus tool name at 60. A name over the cap can fail the host's
 * whole request, not just that tool, and an adopted tool's name is `<server>-<tool>`, up to 100.
 */
export const MAX_TOOL_NAME_LENGTH = 51;

const CACHE_TTL_MS = 30_000;

export interface ActionTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations: ToolAnnotations;
  /** The action to invoke  not the tool name, which may have been sanitized. */
  actionName: string;
}

/**
 * What calling this action does to the world, from what the action declares.
 *
 * Only a plain GET is read-only. A governed-effect adapter moves money or
 * changes a resource whatever its method, and POST, PUT, PATCH and DELETE
 * change or send something, so all of those are destructive: that a change
 * could be undone afterwards does not make it non-destructive. PUT and DELETE
 * are idempotent by HTTP's definition; POST and PATCH are not assumed to be.
 * Every action reaches a system outside Anlyon.
 */
export function actionAnnotations(action: Pick<Action, 'method' | 'adapter'>): ToolAnnotations {
  if (action.method === 'GET' && !action.adapter) {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  }
  return {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: !action.adapter && (action.method === 'PUT' || action.method === 'DELETE'),
    openWorldHint: true,
  };
}

/**
 * What one call counts, from what the action declares, so a coding agent reads
 * it before calling. The declaration says what is counted. It does not say a
 * limit is configured, so the sentence never claims one exists.
 *
 * An adapter with no declaration counts what its provider operation moves,
 * which the action list does not spell out, so that case stays general.
 */
export function impactSentence(action: Pick<Action, 'impact' | 'adapter'>): string {
  const impact = action.impact;
  if (!impact) {
    return action.adapter
      ? 'Each call counts toward any shared limit set for this environment.'
      : '';
  }
  const counted =
    impact.dimension === 'money' ? `money in ${impact.unit}` : impact.dimension.replace(/_/g, ' ');
  const bound = impact.bound === 'upper_bound' ? 'upper bound' : 'exact';
  return `Each call counts ${counted} toward any shared limit set for this environment (amount: ${impact.amount}, ${bound}).`;
}

/**
 * Backend action names are already `[a-zA-Z0-9_-]{1,100}`, but the tool name is
 * a contract with the host: sanitize defensively and keep it inside the length
 * cap. A name changed to fit ends in a hash of the action's name, so two long
 * names stay apart and a name means the same action on every list, whatever
 * order the list came in. Every tool still carries its `actionName`.
 */
export function toToolName(actionName: string): string {
  const safe = actionName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const whole = `${ACTION_TOOL_PREFIX}${safe}`;
  if (safe === actionName && whole.length <= MAX_TOOL_NAME_LENGTH) return whole;
  const hash = createHash('sha256').update(actionName).digest('hex').slice(0, 8);
  return `${whole.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}-${hash}`;
}

export function isActionToolName(name: string): boolean {
  return name.startsWith(ACTION_TOOL_PREFIX);
}

/**
 * One MCP tool per enabled action. The action's stored inputSchema is passed
 * through verbatim  the backend already guarantees it is inside the supported
 * JSON-Schema subset, so re-deriving it here could only lose fidelity.
 */
export function buildActionTools(actions: Action[]): ActionTool[] {
  const tools: ActionTool[] = [];
  const seen = new Set<string>();

  for (const action of actions) {
    if (!action.enabled) continue;

    const name = toToolName(action.name);
    if (seen.has(name)) continue;
    seen.add(name);

    const gated = action.requiresApproval
      ? ' Gated. It requires human approval, and the call parks until a human decides.'
      : '';
    const base = action.description ?? `Invoke the "${action.name}" action.`;
    const counted = impactSentence(action);

    const schema = (action.inputSchema ?? {}) as Record<string, unknown>;

    tools.push({
      name,
      description: `${base}${gated}${counted ? ` ${counted}` : ''}`,
      inputSchema: {
        type: 'object',
        properties: (schema.properties as Record<string, unknown>) ?? {},
        ...(Array.isArray(schema.required) ? { required: schema.required as string[] } : {}),
        ...(typeof schema.additionalProperties === 'boolean'
          ? { additionalProperties: schema.additionalProperties }
          : {}),
      },
      annotations: actionAnnotations(action),
      actionName: action.name,
    });
  }

  return tools;
}

interface CacheEntry {
  tools: ActionTool[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Bound the cache. These entries are per caller, and a hosted deployment serves
 * arbitrarily many, so an unbounded Map is a slow leak. Eviction is
 * oldest-inserted-first, matching client-factory.
 */
const MAX_CACHED_SCOPES = 1000;

function remember(key: string, tools: ActionTool[]): void {
  if (!cache.has(key) && cache.size >= MAX_CACHED_SCOPES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { tools, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * The workspace's action tools, cached for 30s per caller.
 *
 * Keyed by resolveCacheScope() rather than the credential: these tools are one
 * workspace's private action names, so a key collision would hand them to
 * another tenant. See auth.ts.
 *
 * Never throws: a workspace whose actions cannot be listed (no `actions:read`
 * scope, API down) still gets the static tool list rather than a broken one.
 */
export async function getActionTools(client: Client, apiKey: string): Promise<ActionTool[]> {
  const key = resolveCacheScope(apiKey);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.tools;

  try {
    const { data } = await client.actions.list();
    const tools = buildActionTools(data ?? []);
    remember(key, tools);
    return tools;
  } catch {
    remember(key, []);
    return [];
  }
}

/**
 * Forget the current caller's action tools.
 *
 * The cache key is the caller, not the workspace, so switching workspace does
 * not change it  without this, select_workspace would leave the old
 * workspace's action tools on the list for up to the TTL. Scoped to this caller
 * so one switch does not flush every other tenant.
 */
export function invalidateActionToolsForCaller(apiKey: string): void {
  cache.delete(resolveCacheScope(apiKey));
}

/** Test seam. */
export function clearActionToolCache(): void {
  cache.clear();
}

/** Dynamic tools are on by default; ANLYON_MCP_DYNAMIC_ACTIONS=0 opts out. */
export function dynamicActionsEnabled(): boolean {
  return process.env.ANLYON_MCP_DYNAMIC_ACTIONS !== '0';
}
