/**
 * Realtime event stream types (item 3).
 */

export interface StreamEvent {
  /** Redis stream id  the resume cursor. */
  id: string;
  /** Schema version. */
  v: number;
  /** Event type, e.g. "run.started", "approval.requested". */
  type: string;
  /** null = workspace-wide (not environment-specific). */
  environmentId: string | null;
  data: Record<string, unknown>;
  ts: number;
}

export interface StreamOptions {
  /** Resume after this event id (from a previously seen event). */
  cursor?: string;
  /** Abort the stream. */
  signal?: AbortSignal;
}
