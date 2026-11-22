/**
 * The shared tool contract every tool module implements.
 *
 * `handler` receives the per-request SDK client and the already-validated
 * arguments; whatever it returns is serialized as the tool result.
 *
 * `annotations` and `scopes` are required, not optional, so a new tool cannot
 * ship without saying what it does to the world and what it needs to do it.
 * Hosts use both: ChatGPT shows a confirmation before a destructive call and
 * explains permissions from the scopes.
 */

import type { Client } from '@anlyonhq/sdk';

/**
 * MCP tool annotations. `destructiveHint` and `idempotentHint` only mean
 * something when `readOnlyHint` is false. That a change can be undone later
 * does not make it non-destructive: a call that changes or sends something is
 * destructive unless it only adds.
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  /** Reaches systems outside Anlyon: a customer URL, a webhook, a production API. */
  openWorldHint: boolean;
}

/**
 * The OAuth consent groups a tool needs  the same names the consent screen
 * lists (server/src/core/auth/oauth-scopes.ts). A scheduler test fails if
 * one here does not exist there.
 */
export type ConsentScope =
  | 'anlyon:messaging'
  | 'anlyon:actions'
  | 'anlyon:approvals.decide'
  | 'anlyon:workspace.switch';

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Adds something new and changes nothing that already exists. */
export const ADDITIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** Deletes by id: destructive, and a repeat has no further effect. */
export const DELETES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations: ToolAnnotations;
  scopes: readonly ConsentScope[];
  handler: (client: Client, args: Record<string, unknown>) => Promise<unknown>;
}
