/**
 * Dynamic function tools: a workspace's hosted functions, beside its actions.
 *
 * A published function appears as `function_<name>`, taking `input` (checked against the version's
 * input schema) and, to carry out an approved plan, `planRunId`. Called without `planRunId` it
 * plans: reads run, writes are recorded and nothing is sent; a plan with writes waits on one
 * approval. Called again with the plan run's id once that approval is granted, it applies the plan.
 * Every write the function makes is an action call, governed and receipted like any other.
 *
 * Listed per caller and cached briefly, like the action tools. A caller that cannot list functions
 * (no `functions:read`, or hosted functions are not available on the deployment) gets none.
 */

import type { Client, FunctionRun, HostedFunction } from '@anlyonhq/sdk';
import { resolveCacheScope } from '../auth.ts';
import type { ToolAnnotations } from './types.ts';

/** Prefix keeps generated names from colliding with a static tool or an action tool. */
export const FUNCTION_TOOL_PREFIX = 'function_';

/** MCP tool names are capped at 64 characters. */
const MAX_TOOL_NAME_LENGTH = 64;

const CACHE_TTL_MS = 30_000;

export interface FunctionTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    additionalProperties: false;
  };
  annotations: ToolAnnotations;
  /** The function to run: not the tool name, which may have been sanitized. */
  functionName: string;
}

/**
 * A function can write through its actions, so its tool is never read-only. A plan sends no writes,
 * but the same tool applies an approved plan.
 */
const FUNCTION_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export function toFunctionToolName(functionName: string): string {
  const safe = functionName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${FUNCTION_TOOL_PREFIX}${safe}`.slice(0, MAX_TOOL_NAME_LENGTH);
}

export function isFunctionToolName(name: string): boolean {
  return name.startsWith(FUNCTION_TOOL_PREFIX);
}

/** One tool per function with a published version. */
export function buildFunctionTools(functions: HostedFunction[]): FunctionTool[] {
  const tools: FunctionTool[] = [];
  const seen = new Set<string>();
  for (const fn of functions) {
    if (!fn.currentVersion) continue;
    const name = toFunctionToolName(fn.name);
    if (seen.has(name)) continue;
    seen.add(name);
    const schema = fn.currentVersion.inputSchema ?? {};
    const base = fn.description ?? `Run the "${fn.name}" function.`;
    tools.push({
      name,
      description:
        `${base} Without planRunId this plans: reads run, writes are recorded and not sent, and a plan with writes ` +
        'waits for an approval. Once it is approved, call again with planRunId to carry out exactly those writes.',
      inputSchema: {
        type: 'object',
        properties: {
          input: Object.keys(schema).length > 0 ? schema : { type: 'object', description: 'The function input.' },
          planRunId: {
            type: 'string',
            description: 'The approved plan run (frn_...) to carry out. Omit to plan.',
          },
        },
        additionalProperties: false,
      },
      annotations: FUNCTION_ANNOTATIONS,
      functionName: fn.name,
    });
  }
  return tools;
}

/** What the model is told a run came to, with the next step when there is one. */
export function describeRun(run: FunctionRun): string {
  const body = JSON.stringify(run, null, 2);
  const approval = run.plan?.approval;
  if (run.status === 'awaiting_approval' && approval) {
    return (
      `Planned ${run.plan!.writes.length} write(s); nothing was sent. Waiting on approval ${approval.id} ` +
      `(decided by ${approval.decider === 'end_user' ? 'the end user' : 'the team'}). Call wait_for_approval with ` +
      `approvalId=${approval.id}, then call this tool again with planRunId=${run.id} to carry out the plan.\n\n${body}`
    );
  }
  if (run.status === 'diverged') {
    return `The run stopped at a write the approved plan does not have. Nothing further was sent. Plan again for a new approval.\n\n${body}`;
  }
  return body;
}

interface CacheEntry {
  tools: FunctionTool[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHED_SCOPES = 1000;

function remember(key: string, tools: FunctionTool[]): void {
  if (!cache.has(key) && cache.size >= MAX_CACHED_SCOPES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { tools, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** The caller's function tools, cached for 30s. Never throws. */
export async function getFunctionTools(client: Client, apiKey: string): Promise<FunctionTool[]> {
  const key = resolveCacheScope(apiKey);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.tools;
  try {
    const { data } = await client.functions.list();
    const tools = buildFunctionTools(data ?? []);
    remember(key, tools);
    return tools;
  } catch {
    remember(key, []);
    return [];
  }
}

/** Forget the current caller's function tools (a workspace switch). */
export function invalidateFunctionToolsForCaller(apiKey: string): void {
  cache.delete(resolveCacheScope(apiKey));
}

/** Test seam. */
export function clearFunctionToolCache(): void {
  cache.clear();
}
