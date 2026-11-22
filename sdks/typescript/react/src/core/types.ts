/**
 * What the end-user session routes (`/api/v2/end-user-session`) return. Dates are ISO 8601 strings.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

/** How much a call uses. Money is in minor units with a lowercase ISO 4217 currency. */
export interface ImpactQuantity {
  dimension: string;
  currency?: string;
  amount: number;
  bound: 'exact' | 'upper_bound';
}

/** Typed preview data. Never HTML. */
export type PreviewBlock =
  | { type: 'fields'; title: string; fields: Array<{ label: string; value: string }> }
  | { type: 'text_diff'; title: string; path: string; before: string; after: string; truncated: boolean }
  | { type: 'impact'; title: string; quantities: ImpactQuantity[] }
  | {
      type: 'limitations';
      title: string;
      items: Array<{ kind: 'unsupported' | 'guarantee' | 'irreversible' | 'freshness'; text: string }>;
    };

export interface ApprovalPreview {
  /** Where the call lands: the account, and labels for people. */
  target: { account: string | null; display: Record<string, string> };
  /** The exact change: the adapter's own fields and diffs. Empty when the action's input is the change. */
  blocks: PreviewBlock[];
  impact: ImpactQuantity[];
  /** Whether the change can be undone afterwards. Absent from servers before October 2026. */
  reversible?: boolean;
  /** The same, as one short line, e.g. `This can't be undone once it runs.` */
  undo?: string;
  expiresAt: string;
}

/** One approval the end user decides. */
export interface Approval {
  id: string;
  kind: 'action' | 'custom' | 'function_plan';
  status: ApprovalStatus;
  title: string;
  description: string | null;
  /** The action the agent wants to run, e.g. `gmail-send`. */
  actionName: string | null;
  /** The action's input, or a custom approval's details. */
  input: Record<string, unknown> | null;
  preview: ApprovalPreview | null;
  /** The note recorded with the decision. */
  decisionNote: string | null;
  expiresAt: string;
  decidedAt: string | null;
  createdAt: string;
}

export interface ApprovalDecision {
  approval: Approval;
  /** Present when approving ran the call: its status, e.g. `succeeded`. */
  result?: { status: string };
}

export type ConnectionStatus = 'active' | 'needs_reconnect' | 'revoked';

/** One of the end user's connected accounts. Never a token. */
export interface Connection {
  integration: string;
  /** The integration's name, e.g. `GitHub`. */
  displayName: string;
  kind: 'oauth' | 'api_key';
  status: ConnectionStatus;
  scopes: string[];
  connectedAt: string;
  updatedAt: string;
}

export interface ConnectLink {
  url: string;
  expiresAt: string;
  integration: string;
}

/** What the AI SDK adapter's tools return when the end user has to connect an account. */
export interface ConnectRequiredResult {
  status: 'connect_required' | 'reconnect_required';
  integration: string;
  /** The name the API gave, e.g. an MCP server's own. */
  displayName?: string;
  connectUrl: string | null;
  message?: string;
}

export function isConnectRequiredResult(value: unknown): value is ConnectRequiredResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (v.status === 'connect_required' || v.status === 'reconnect_required') && typeof v.integration === 'string';
}
