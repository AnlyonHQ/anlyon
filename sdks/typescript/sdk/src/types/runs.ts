/**
 * Run and span types for the Anlyon SDK  the agent trace model.
 */

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export type SpanType =
  | 'model_call'
  | 'context_assembly'
  | 'session_read'
  | 'session_write'
  | 'memory_recall'
  | 'memory_write'
  | 'tool_call'
  | 'action_call'
  | 'approval_wait'
  | 'approval_decision'
  | 'workflow_step'
  | 'queue_delivery'
  | 'event_delivery'
  | 'custom';

export type SpanStatus = 'running' | 'succeeded' | 'failed';

export interface Run {
  /** Public run id (run_xxx). */
  id: string;
  agentId: string | null;
  agentVersion: string | null;
  environmentId: string;
  name: string | null;
  status: RunStatus;
  userId: string | null;
  application: string | null;
  input: unknown;
  output: unknown;
  error: Record<string, unknown> | null;
  tokens: number | null;
  cost: number | null;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
}

export interface Span {
  /** Public span id (span_xxx). */
  id: string;
  parentId: string | null;
  name: string;
  type: SpanType;
  status: SpanStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  model: string | null;
  provider: string | null;
  tokens: Record<string, number> | null;
  cost: number | null;
  input: unknown;
  output: unknown;
  error: Record<string, unknown> | null;
  /** OTel-style attributes, including correlation refs (e.g. messageId). */
  attributes: Record<string, unknown> | null;
}

/** A span with its children nested  the shape returned by {@link RunsResource.get}. */
export interface SpanNode extends Span {
  children: SpanNode[];
}

export interface RunWithSpans extends Run {
  spans: SpanNode[];
}

export interface StartRunRequest {
  name?: string;
  agentId?: string;
  agentVersion?: string;
  userId?: string;
  application?: string;
  input?: unknown;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface EndRunRequest {
  status?: RunStatus;
  output?: unknown;
  error?: Record<string, unknown>;
  tokens?: number;
  cost?: number;
  metadata?: Record<string, unknown>;
}

export interface SpanInput {
  /** Provide to make ingestion idempotent  resending the same id updates the span. */
  id?: string;
  parentId?: string;
  name: string;
  type?: SpanType;
  status?: SpanStatus;
  startedAt: string;
  endedAt?: string;
  model?: string;
  provider?: string;
  tokens?: Record<string, number>;
  cost?: number;
  input?: unknown;
  output?: unknown;
  error?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
}

export interface ListRunsParams {
	/** Case-insensitive substring search across run ID, name, and application. */
	search?: string;
  status?: RunStatus;
  agentId?: string;
  userId?: string;
  startedAfter?: string;
  startedBefore?: string;
  limit?: number;
  offset?: number;
}

export interface IngestSpansResult {
  ingested: number;
}

/** Bounded OpenTelemetry Protocol JSON trace accepted by {@link RunsResource.importTrace}. */
export interface OtlpTrace {
  resourceSpans: Array<Record<string, unknown>>;
}

export type FeedbackSource = 'user' | 'model' | 'code';

export interface RunFeedback {
  id: string;
  runId: string;
  spanId: string | null;
  source: FeedbackSource;
  label: string | null;
  rating: number | null;
  comment: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AddFeedbackRequest {
  spanId?: string;
  source?: FeedbackSource;
  label?: string;
  rating?: number;
  comment?: string;
  metadata?: Record<string, unknown>;
}
