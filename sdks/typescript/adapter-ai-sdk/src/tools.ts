/**
 * Vercel AI SDK tool definitions wrapping Anlyon primitives.
 *
 * These are thin wrappers. They call the SDK and never re-implement API logic.
 * Each tool returns a string suitable for the AI SDK's tool result format.
 *
 * `createAnlyonTools(client)` returns the governed tools only: actions and
 * approvals. The events tools stay exported one by one, and the factory
 * returns them only with `{ legacy: true }`.
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { Client } from '@anlyonhq/sdk';
import { connectRequiredResult, describeInvocation } from './actions.ts';

/**
 * What every factory below returns.
 *
 * `tool()` infers `ExecutableTool<…>`, and `ai` does not re-export that name  so an inferred
 * return type cannot be named in our emitted `.d.ts` and the declaration build fails outright
 * (TS2742). `ToolSet` *is* exported, and `ToolSet[string]` is exactly the shape `streamText`
 * and `generateText` accept, so annotating with it keeps the published types resolvable from
 * `ai` alone  no `@ai-sdk/*` internals leaking into the peer list.
 *
 * The trade is that a caller holding one factory's result loses input narrowing. That costs
 * little here: every tool takes its own `execute` and returns a string, and the documented
 * entry point is `createAnlyonTools()` passed straight to a generate call.
 */
type AnlyonTool = ToolSet[string];

/** Bounds for waitForApproval  a model turn should not hang on a human forever. */
const DEFAULT_APPROVAL_WAIT_SECONDS = 60;
const MAX_APPROVAL_WAIT_SECONDS = 120;

/**
 * Publish event tool  publish an event to a topic for async fan-out.
 */
export function anlyonPublishEventTool(client: Client): AnlyonTool {
  return tool({
    description:
      'Publish an event to an Anlyon topic. Fan-out to subscriptions is asynchronous. Use idempotencyKey to dedupe retries.',
    inputSchema: z.object({
      topic: z.string().min(1).describe('Topic name or public id (top_xxx)'),
      type: z.string().min(1).describe('Dot-segmented event type (e.g. "order.created")'),
      data: z.record(z.string(), z.unknown()).optional().describe('Arbitrary event payload'),
      idempotencyKey: z.string().optional().describe('Optional idempotency key for deduplication'),
    }),
    execute: async ({ topic, type, data, idempotencyKey }) => {
      const { data: result } = await client.events.publish({
        topic,
        type,
        data,
        idempotencyKey,
      });
      if (!result) return 'Event publish returned no data.';
      const dedupe = result.deduplicated ? ' (deduplicated)' : '';
      return `Published event: ${result.id} [${result.status}]${dedupe}`;
    },
  });
}

/**
 * List events tool  list published events with optional filters.
 */
export function anlyonListEventsTool(client: Client): AnlyonTool {
  return tool({
    description: 'List published Anlyon events with optional topic/type filters. Paginated.',
    inputSchema: z.object({
      topic: z.string().optional().describe('Filter by topic name or id'),
      type: z.string().optional().describe('Filter by event type'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size (default 20)'),
      offset: z.number().int().min(0).optional().describe('Skip count for pagination'),
    }),
    execute: async ({ topic, type, limit, offset }) => {
      const { data } = await client.events.list({ topic, type, limit, offset });
      if (!data || data.length === 0) return 'No events found.';
      return data
        .map((e) => {
          const topicPart = e.topic ? ` topic=${e.topic}` : '';
          return `[${e.id}] ${e.type}${topicPart} status=${e.status} createdAt=${e.createdAt}`;
        })
        .join('\n');
    },
  });
}

/**
 * Invoke action tool. Calls a hosted action by name. Anlyon holds the credentials.
 *
 * With a client from `anlyon.forUser(endUserId)`, an end user who has not connected the
 * integration gets a `{ status: 'connect_required', integration, connectUrl, message }` result
 * instead of an error.
 */
export function anlyonInvokeActionTool(client: Client): AnlyonTool {
  return tool({
    description:
      'Invoke an Anlyon hosted action by name. Anlyon holds the credentials and makes the HTTP call. You never see them. If the action requires human approval, this returns an approval id instead of a result. If the outcome comes back unknown, do not invoke the action again.',
    inputSchema: z.object({
      name: z.string().min(1).describe('Action name (or act_xxx id)'),
      input: z.record(z.string(), z.unknown()).optional().describe("Input matching the action's inputSchema"),
    }),
    execute: async ({ name, input }) => {
      let data;
      try {
        ({ data } = await client.actions.invoke(name, input ?? {}));
      } catch (error) {
        const connect = connectRequiredResult(error);
        if (connect) return connect;
        throw error;
      }
      if (!data) return 'Action invocation returned no data.';
      return describeInvocation(name, data);
    },
  });
}

/**
 * List actions tool  discover what tools this workspace exposes.
 */
export function anlyonListActionsTool(client: Client): AnlyonTool {
  return tool({
    description:
      'List the Anlyon hosted actions available to you, with their input schemas and whether each requires human approval.',
    inputSchema: z.object({}),
    execute: async () => {
      const { data } = await client.actions.list();
      if (!data || data.length === 0) return 'No actions defined.';
      return data
        .map((a) => {
          const gate = a.requiresApproval ? ' (requires approval)' : '';
          const off = a.enabled ? '' : ' [disabled]';
          return `${a.name}${gate}${off}: ${a.description ?? 'no description'}\n  input: ${JSON.stringify(a.inputSchema)}`;
        })
        .join('\n');
    },
  });
}

/**
 * Request approval tool  ask the human before doing something consequential.
 */
export function anlyonRequestApprovalTool(client: Client): AnlyonTool {
  return tool({
    description:
      "Ask the human to approve something before you do it. Use this for irreversible or expensive actions that aren't already gated. Returns an approval id to check later.",
    inputSchema: z.object({
      title: z.string().min(1).describe('What you want to do, in one line'),
      description: z.string().optional().describe('Context the human needs to decide'),
      payload: z.record(z.string(), z.unknown()).optional().describe('Structured detail of the proposal'),
      expiresInSeconds: z
        .number()
        .int()
        .min(60)
        .max(2_592_000)
        .optional()
        .describe('How long to wait for a decision (default 24h)'),
    }),
    execute: async ({ title, description, payload, expiresInSeconds }) => {
      const { data } = await client.approvals.request({
        title,
        description,
        payload,
        expiresInSeconds,
      });
      if (!data) return 'Approval request returned no data.';
      return `Approval requested: ${data.id} (expires ${data.expiresAt}). Check it with checkApproval.`;
    },
  });
}

/**
 * Check approval tool  poll a decision.
 */
export function anlyonCheckApprovalTool(client: Client): AnlyonTool {
  return tool({
    description: 'Check whether an Anlyon approval has been decided (pending/approved/denied/expired).',
    inputSchema: z.object({
      approvalId: z.string().min(1).describe('Approval id (apr_xxx)'),
    }),
    execute: async ({ approvalId }) => {
      const { data } = await client.approvals.get(approvalId);
      if (!data) return 'Approval not found.';
      const note = data.decisionNote ? `  "${data.decisionNote}"` : '';
      return `Approval ${data.id} is ${data.status}${note}`;
    },
  });
}

/**
 * Wait-for-approval tool  the agent blocks on a human decision instead of
 * polling. Still pending when it returns? Call it again.
 */
export function anlyonWaitForApprovalTool(client: Client): AnlyonTool {
  return tool({
    description:
      'Wait for a human to decide an Anlyon approval, instead of polling checkApproval. Blocks until the approval is approved, denied or expired, or until timeoutSeconds elapses. If it comes back still pending, call this again.',
    inputSchema: z.object({
      approvalId: z.string().min(1).describe('Approval id (apr_xxx)'),
      timeoutSeconds: z
        .number()
        .int()
        .min(1)
        .max(MAX_APPROVAL_WAIT_SECONDS)
        .optional()
        .describe(`How long to wait (default ${DEFAULT_APPROVAL_WAIT_SECONDS}s, max ${MAX_APPROVAL_WAIT_SECONDS}s)`),
    }),
    execute: async ({ approvalId, timeoutSeconds }) => {
      const seconds = Math.min(timeoutSeconds ?? DEFAULT_APPROVAL_WAIT_SECONDS, MAX_APPROVAL_WAIT_SECONDS);
      const approval = await client.approvals.waitForDecision(approvalId, {
        timeoutMs: seconds * 1000,
      });

      if (approval.status === 'pending') {
        return `Approval ${approval.id} is still pending after ${seconds}s. Call this again to keep waiting.`;
      }
      const note = approval.decisionNote ? `  "${approval.decisionNote}"` : '';
      return `Approval ${approval.id} is ${approval.status}${note}`;
    },
  });
}

/** The tools `createAnlyonTools(client)` returns: actions and approvals. */
export const GOVERNED_TOOL_NAMES = [
  'listActions',
  'invokeAction',
  'requestApproval',
  'checkApproval',
  'waitForApproval',
] as const;

/**
 * The events tools. They are not part of governed execution, and the factory
 * returns them only with `{ legacy: true }`. Version 3 removed the memory,
 * files, semantic cache and context tools, whose API no longer exists.
 */
export const LEGACY_TOOL_NAMES = [
  'publishEvent',
  'listEvents',
] as const;

export type AnlyonGovernedTools = Record<(typeof GOVERNED_TOOL_NAMES)[number], AnlyonTool>;
export type AnlyonLegacyTools = Record<(typeof LEGACY_TOOL_NAMES)[number], AnlyonTool>;

export interface CreateAnlyonToolsOptions {
  /** Also return the events tools: `publishEvent` and `listEvents`. Off by default. */
  legacy?: boolean;
}

/**
 * Create the Anlyon tools for `streamText` or `generateText`.
 *
 * By default this returns the governed tools only: `listActions`,
 * `invokeAction`, `requestApproval`, `checkApproval` and `waitForApproval`.
 * Pass `{ legacy: true }` to also get the events tools.
 *
 * @example
 * ```ts
 * import { streamText } from 'ai';
 * import { createAnlyonTools } from '@anlyonhq/ai-sdk';
 * import { Client } from '@anlyonhq/sdk';
 *
 * const client = new Client({ apiKey: process.env.ANLYON_API_KEY! });
 * const tools = createAnlyonTools(client);
 *
 * const result = streamText({ model, tools, prompt: '...' });
 * ```
 */
export function createAnlyonTools(
  client: Client,
  options: CreateAnlyonToolsOptions & { legacy: true },
): AnlyonGovernedTools & AnlyonLegacyTools;
export function createAnlyonTools(client: Client, options?: CreateAnlyonToolsOptions): AnlyonGovernedTools;
export function createAnlyonTools(
  client: Client,
  options: CreateAnlyonToolsOptions = {},
): AnlyonGovernedTools | (AnlyonGovernedTools & AnlyonLegacyTools) {
  const governed: AnlyonGovernedTools = {
    listActions: anlyonListActionsTool(client),
    invokeAction: anlyonInvokeActionTool(client),
    requestApproval: anlyonRequestApprovalTool(client),
    checkApproval: anlyonCheckApprovalTool(client),
    waitForApproval: anlyonWaitForApprovalTool(client),
  };
  if (options.legacy !== true) return governed;

  const legacy: AnlyonLegacyTools = {
    publishEvent: anlyonPublishEventTool(client),
    listEvents: anlyonListEventsTool(client),
  };
  return { ...governed, ...legacy };
}
