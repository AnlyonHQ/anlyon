/**
 * Agent platform MCP tools  the ones that make any MCP-speaking agent use
 * Anlyon as its trust backend.
 *
 * Trust:  list_actions, invoke_action, request_approval, check_approval,
 *         wait_for_approval, get_invocation
 *
 * Secrets are deliberately absent: they are write-only and belong in a human's
 * hands, not in an agent's tool list.
 */

import { ADDITIVE, READ_ONLY, type McpTool } from './types.ts';
import type { Approval, Client } from '@anlyonhq/sdk';

/**
 * Default and ceiling for wait_for_approval: an MCP host will not hold a call open forever. The default
 * sits under 60 seconds because that is the request timeout of the official MCP TypeScript client, so a
 * host that keeps it would otherwise lose a race the server wins by a moment: the call fails with a
 * timeout where a still-pending answer was on its way.
 */
const DEFAULT_WAIT_SECONDS = 45;
const MAX_WAIT_SECONDS = 120;

/**
 * An approval, with what a gated action did once the decision let it run. The agent asked for a result
 * and has no other way to read this one, so without it the turn would end knowing only "approved". A
 * failure to read it costs the agent the outcome, not the decision, so it never fails the call.
 */
async function withOutcome(client: Client, approval: Approval): Promise<unknown> {
  const invocationId = (approval.payload as { invocationId?: unknown } | null | undefined)?.invocationId;
  if (approval.status !== 'approved' || typeof invocationId !== 'string') return approval;
  try {
    const { data } = await client.actions.invocation(invocationId);
    return { ...approval, invocation: data };
  } catch {
    return { ...approval, next: `Read the outcome with get_invocation, id ${invocationId}, or in the console's invocation log.` };
  }
}

/**
 * What a governed action adds, one sentence per concept. Each tool
 * carries only the ones that apply to it. The limit sentence says what a limit
 * is shared across, never that one is configured.
 */
const SHARED_LIMIT =
  'Any limit on a governed action is shared by every agent, session and key in the environment, so a new session does not get a new allowance.';
const BOUND_APPROVAL =
  'An approval for a governed action is bound to the exact request, and a changed request is refused at dispatch.';
const GRADE_MEANING = 'confirmed means a read-back matched, acknowledged means the provider accepted it, unknown means do not retry.';
const RESULT_GRADE = `The result of a governed action carries a grade: ${GRADE_MEANING}`;
const INVOCATION_GRADE = `The invocation of a governed action carries a grade: ${GRADE_MEANING}`;

export const agentTools: McpTool[] = [
  {
    name: 'list_actions',
    annotations: READ_ONLY,
    scopes: ['anlyon:actions'],
    description:
      'List the hosted tools this workspace has defined, with their input schemas and whether each one requires human approval. Call this to discover what you can do before invoking anything.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (client) => {
      const { data } = await client.actions.list();
      return data;
    },
  },
  {
    name: 'invoke_action',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    scopes: ['anlyon:actions'],
    description:
      `Invoke a hosted tool by name with a JSON input. Anlyon holds the credentials and makes the call. You never see them. If the action requires approval, this returns pendingApproval=true with an approvalId: call wait_for_approval, which returns the outcome once a human approves. ${SHARED_LIMIT} ${BOUND_APPROVAL} ${RESULT_GRADE}`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Action name (or act_xxx id).' },
        input: {
          type: 'object',
          additionalProperties: true,
          description: "Input matching the action's inputSchema.",
        },
      },
      required: ['name'],
    },
    handler: async (client, args) => {
      const { data } = await client.actions.invoke(
        args.name as string,
        (args.input as Record<string, unknown> | undefined) ?? {}
      );
      return data;
    },
  },
  {
    name: 'request_approval',
    annotations: ADDITIVE,
    scopes: ['anlyon:actions'],
    description:
      "Ask the human for a decision before doing something consequential. Returns an approval id (apr_xxx). Poll check_approval until it is approved or denied. Use this whenever you're about to take an irreversible or expensive action that isn't already gated. This approval does not release a gated action: that approval comes from invoking the action and is bound to the exact request.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, description: 'What you want to do, in one line.' },
        description: {
          type: 'string',
          description: 'Context the human needs to decide. Be specific about consequences.',
        },
        payload: {
          type: 'object',
          additionalProperties: true,
          description: 'Structured detail of the proposed action.',
        },
        expiresInSeconds: {
          type: 'integer',
          minimum: 60,
          maximum: 2592000,
          description: 'How long to wait for a decision (default 24h).',
        },
      },
      required: ['title'],
    },
    handler: async (client, args) => {
      const { data } = await client.approvals.request({
        title: args.title as string,
        description: args.description as string | undefined,
        payload: args.payload as Record<string, unknown> | undefined,
        expiresInSeconds: args.expiresInSeconds as number | undefined,
      });
      return data;
    },
  },
  {
    name: 'check_approval',
    annotations: READ_ONLY,
    scopes: ['anlyon:actions'],
    description:
      `Check whether an approval has been decided. Status is pending, approved, denied or expired. For a gated action, once it is approved the linked invocation has already run, and it is returned as invocation. ${BOUND_APPROVAL} ${INVOCATION_GRADE}`,
    inputSchema: {
      type: 'object',
      properties: {
        approvalId: { type: 'string', description: 'Approval id (apr_xxx).' },
      },
      required: ['approvalId'],
    },
    handler: async (client, args) => {
      const { data } = await client.approvals.get(args.approvalId as string);
      return withOutcome(client, data!);
    },
  },
  {
    name: 'wait_for_approval',
    annotations: READ_ONLY,
    scopes: ['anlyon:actions'],
    description:
      `Wait for a human to decide an approval, instead of polling check_approval. Blocks until the approval is approved, denied or expired, or until timeoutSeconds elapses. If it is still pending when this returns, tell the user it is waiting for them, and call it again. For a gated action, an approved result carries the outcome as invocation. Use this right after request_approval or after a gated invoke_action so the human's decision arrives in the same turn. ${BOUND_APPROVAL} ${INVOCATION_GRADE}`,
    inputSchema: {
      type: 'object',
      properties: {
        approvalId: { type: 'string', description: 'Approval id (apr_xxx).' },
        timeoutSeconds: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_WAIT_SECONDS,
          description: `How long to wait before giving up and returning the pending approval (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}).`,
        },
      },
      required: ['approvalId'],
    },
    handler: async (client, args) => {
      const requested = (args.timeoutSeconds as number | undefined) ?? DEFAULT_WAIT_SECONDS;
      const timeoutMs = Math.min(Math.max(requested, 1), MAX_WAIT_SECONDS) * 1000;

      return withOutcome(client, await client.approvals.waitForDecision(args.approvalId as string, { timeoutMs }));
    },
  },
  {
    name: 'get_invocation',
    annotations: READ_ONLY,
    scopes: ['anlyon:actions'],
    description:
      `Read what one action call did: its status, the response, and for a governed action the receipt's grade. Use it when an earlier call's outcome was not returned. ${RESULT_GRADE}`,
    inputSchema: {
      type: 'object',
      properties: {
        invocationId: { type: 'string', description: 'Invocation id (inv_xxx).' },
      },
      required: ['invocationId'],
    },
    handler: async (client, args) => {
      const { data } = await client.actions.invocation(args.invocationId as string);
      return data;
    },
  },
];
