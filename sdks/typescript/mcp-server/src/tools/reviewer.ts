/**
 * Reviewer tools: see what is waiting for a decision, and decide it.
 *
 * These let a person review from wherever their MCP client runs instead of only
 * from the Anlyon inbox. Deciding is the `approvals:decide` scope and nothing
 * weaker: the API enforces it on every decision, and the hosted endpoint does
 * not list these tools to a connection that was not granted the "Approve on
 * your behalf" consent group.
 *
 * N-of-M is unchanged. A decision made here is recorded against the credential
 * that made it: a user for an OAuth connection, the key for an API key. A key
 * can never decide an approval it requested itself.
 */

import { READ_ONLY, type McpTool } from './types.ts';

const DEFAULT_LIMIT = 20;

export const reviewerTools: McpTool[] = [
  {
    name: 'list_pending_approvals',
    annotations: READ_ONLY,
    scopes: ['anlyon:actions', 'anlyon:approvals.decide'],
    description:
      'List the approvals in this environment still waiting for a decision: what is being asked, the request that would be sent, how many approvals it needs and when it expires. Use this before decide_approval.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: `How many to return (default ${DEFAULT_LIMIT}).`,
        },
      },
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const { data } = await client.approvals.list({
        status: 'pending',
        limit: (args.limit as number | undefined) ?? DEFAULT_LIMIT,
      });
      return data;
    },
  },
  {
    name: 'decide_approval',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    scopes: ['anlyon:approvals.decide'],
    description:
      'Approve or deny a pending approval, with a reason recorded as the decision note. Approving a gated action makes Anlyon run the request exactly as it was shown for review. Denying means it is never sent. If the approval needs more than one approver, this decision counts once and it stays pending until enough distinct approvers agree. Only decide what the person you act for has asked you to decide.',
    inputSchema: {
      type: 'object',
      properties: {
        approvalId: { type: 'string', description: 'Approval id (apr_xxx), from list_pending_approvals.' },
        decision: { type: 'string', enum: ['approve', 'deny'] },
        reason: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          description: 'Why. Stored as the decision note and shown to everyone who reads the approval.',
        },
      },
      required: ['approvalId', 'decision', 'reason'],
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const approvalId = args.approvalId as string;
      const request = { note: args.reason as string };
      const { data } =
        args.decision === 'approve'
          ? await client.approvals.approve(approvalId, request)
          : await client.approvals.deny(approvalId, request);
      return data;
    },
  },
];
