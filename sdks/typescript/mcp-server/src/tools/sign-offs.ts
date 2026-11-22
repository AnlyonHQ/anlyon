/**
 * Sign-off tools: follow a change that waits for a human's sign-off.
 *
 * An agent may never loosen its own guardrails. When a call through this server asks for a change
 * that loosens one (raise or remove a limit, disable a policy, add a write action, widen a
 * secret's hosts, resume a halted environment), Anlyon does not apply it. The tool returns a
 * sign-off request with a link a workspace admin opens to approve or reject it (see
 * `signOffRequiredResult` in server.ts). These two tools read that request. Nothing here can
 * approve one, and no API key or MCP session can.
 *
 * Reading your own requests needs no scope.
 */

import type { SignOffRequest } from '@anlyonhq/sdk';
import { READ_ONLY, type McpTool } from './types.ts';

/** Default and ceiling for wait_for_sign_off: an MCP host will not hold a call open forever. */
const DEFAULT_WAIT_SECONDS = 45;
const MAX_WAIT_SECONDS = 300;

const NEXT_STEP: Record<string, string> = {
  pending:
    'Waiting for a human. You cannot approve it yourself. Give them signOffUrl, then call wait_for_sign_off with this id.',
  applied: 'A workspace admin approved it and the change was applied. result holds what the original call returns.',
  rejected: 'A workspace admin rejected it. Nothing changed. Do not ask again unless the person you act for wants to.',
  expired: 'Nobody decided in time. Nothing changed.',
  cancelled: 'The request was withdrawn. Nothing changed.',
  failed: 'It was approved but could not be applied. Nothing changed. error says why. Ask again if it is still needed.',
};

/** What check_sign_off and wait_for_sign_off return: the status, the change, the link and what to do next. */
export function describeSignOff(signOff: SignOffRequest): Record<string, unknown> {
  return {
    id: signOff.id,
    status: signOff.status,
    operation: signOff.operation,
    summary: signOff.summary,
    diff: signOff.diff,
    signOffUrl: signOff.signOffUrl,
    expiresAt: signOff.expiresAt,
    decidedAt: signOff.decidedAt,
    decisionNote: signOff.decisionNote,
    ...(signOff.status === 'applied' ? { result: signOff.result } : {}),
    ...(signOff.error ? { error: signOff.error } : {}),
    next: NEXT_STEP[signOff.status] ?? `The request is ${signOff.status}.`,
  };
}

const ID_SCHEMA = { type: 'string', description: 'The sign-off request id (sor_xxx).' };

export const signOffTools: McpTool[] = [
  {
    name: 'check_sign_off',
    annotations: READ_ONLY,
    scopes: [],
    description:
      "Check a change that waits for a human's sign-off: its status (pending, applied, rejected, expired, cancelled, failed), the diff, and the link a workspace admin approves it at. You cannot approve it yourself.",
    inputSchema: {
      type: 'object',
      properties: { id: ID_SCHEMA },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const { data } = await client.signOffs.get(args.id as string);
      return describeSignOff(data!);
    },
  },
  {
    name: 'wait_for_sign_off',
    annotations: READ_ONLY,
    scopes: [],
    description:
      `Wait for a human to decide a change that needs their sign-off, instead of polling check_sign_off. Blocks until it is applied, rejected, expired, cancelled or failed, or until timeoutSeconds elapses. If it is still pending when this returns, call it again. You cannot approve it yourself.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: ID_SCHEMA,
        timeoutSeconds: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_WAIT_SECONDS,
          description: `How long to wait before returning the still-pending request (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}).`,
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const requested = (args.timeoutSeconds as number | undefined) ?? DEFAULT_WAIT_SECONDS;
      const timeoutMs = Math.min(Math.max(requested, 1), MAX_WAIT_SECONDS) * 1000;
      return describeSignOff(await client.signOffs.wait(args.id as string, { timeoutMs }));
    },
  },
];
