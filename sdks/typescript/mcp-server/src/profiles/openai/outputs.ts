/**
 * Tool results for ChatGPT, without the diagnostic fields its plugin guidelines
 * ask tools not to return: request templates, secret names, policy ids, vote
 * history, timings. Pure functions over the default result's JSON; the default
 * result is unchanged for every other client, and anything not recognised here
 * passes through as it came.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

const pick = (value: Json, keys: readonly string[]): Json =>
  Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));

const ACTION_FIELDS = ['name', 'description', 'method', 'requiresApproval', 'enabled', 'inputSchema'] as const;
const INVOCATION_FIELDS = ['id', 'actionName', 'status', 'responseStatus', 'grade', 'body', 'error', 'decision', 'approvalId', 'pendingApproval', 'completedAt'] as const;
const APPROVAL_FIELDS = [
  'id', 'kind', 'status', 'title', 'description', 'payload', 'requiredApprovals', 'approvedCount',
  'policyExplanation', 'decisionNote', 'decidedBy', 'decisionOrigin', 'expiresAt', 'decidedAt',
] as const;

export const action = (value: Json) => pick(value, ACTION_FIELDS);
export const invocation = (value: Json) => pick(value, INVOCATION_FIELDS);
export const approval = (value: Json) => pick(value, APPROVAL_FIELDS);

const eachObject = (value: unknown, view: (item: Json) => Json) =>
  Array.isArray(value) ? value.map((item) => (isObject(item) ? view(item) : item)) : value;

/** The trimmed form of one tool's parsed result, or the result itself. */
export function trimmed(toolName: string, value: unknown): unknown {
  if (toolName === 'list_actions') return eachObject(value, action);
  if (toolName === 'list_pending_approvals') return eachObject(value, approval);
  if (!isObject(value)) return value;
  if (toolName === 'invoke_action' || toolName === 'get_invocation' || toolName.startsWith('action_')) return invocation(value);
  if (['request_approval', 'check_approval', 'wait_for_approval'].includes(toolName)) {
    return {
      ...approval(value),
      ...(isObject(value.invocation) ? { invocation: invocation(value.invocation) } : {}),
      ...(typeof value.next === 'string' ? { next: value.next } : {}),
    };
  }
  if (toolName === 'decide_approval') {
    return {
      ...(isObject(value.approval) ? { approval: approval(value.approval) } : {}),
      ...(isObject(value.invocation) ? { invocation: invocation(value.invocation) } : {}),
      ...(typeof value.selfApproved === 'boolean' ? { selfApproved: value.selfApproved } : {}),
    };
  }
  return value;
}

/** Rewrite a JSON text result in place; non-JSON text (a status line) is left alone. */
export function trimResult(toolName: string, result: CallToolResult): CallToolResult {
  return {
    ...result,
    content: result.content.map((part) => {
      if (part.type !== 'text') return part;
      let parsed: unknown;
      try {
        parsed = JSON.parse(part.text);
      } catch {
        return part;
      }
      return { ...part, text: JSON.stringify(trimmed(toolName, parsed), null, 2) };
    }),
  };
}
