/**
 * Runs resource  the agent trace model. A run is a tree of spans.
 *
 * Report runs from any runtime: start a run, ingest spans as steps happen, then
 * end it. Span ingestion is idempotent when each span carries an `id`, so a
 * retried batch never duplicates.
 */

import { BaseResource } from './base';
import type { IdempotentRequestOptions } from './base';
import type { HttpClient } from '../core/http-client';
import type { ApiResponse, PaginatedResponse } from '../types/api';
import type {
  AddFeedbackRequest,
  EndRunRequest,
  IngestSpansResult,
  ListRunsParams,
  Run,
  RunFeedback,
  RunWithSpans,
  OtlpTrace,
  SpanInput,
  StartRunRequest,
} from '../types/runs';

export class RunsResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/runs');
  }

  /**
   * Start a run. The environment is taken from the API key.
   *
   * @example
   * ```typescript
   * const { data } = await client.runs.start({ name: 'nightly-summary', agentId: 'agt_123' });
   * ```
   */
  async start(
    request: StartRunRequest = {},
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<Run>> {
    return this._post<Run>('', request, this._idempotent(options));
  }

  /**
   * List runs, newest first.
   */
  async list(params?: ListRunsParams): Promise<PaginatedResponse<Run>> {
    return this._getPaginated<Run>('', params as Record<string, unknown>);
  }

  /**
   * Get a run with its span tree.
   */
  async get(runId: string): Promise<ApiResponse<RunWithSpans>> {
    return this._get<RunWithSpans>(`/${runId}`);
  }

  /** Export a redacted trace in OpenTelemetry Protocol JSON shape. */
  async exportTrace(runId: string): Promise<ApiResponse<Record<string, unknown>>> {
    return this._get<Record<string, unknown>>(`/${runId}/export`);
  }

  /** Import one OTLP/JSON trace as a new run in this API key's environment. */
  async importTrace(
    trace: OtlpTrace,
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<Run>> {
    return this._post<Run>('/import', trace, this._idempotent(options));
  }

  /**
   * End or update a run.
   *
   * @example
   * ```typescript
   * await client.runs.end('run_123', { status: 'succeeded', output: { ok: true } });
   * ```
   */
  async end(
    runId: string,
    request: EndRunRequest,
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<Run>> {
    return this._patch<Run>(`/${runId}`, request, this._idempotent(options));
  }

  /**
   * Idempotently ingest a batch of spans for a run. Give each span an `id` so a
   * retry updates it in place rather than duplicating.
   *
   * @example
   * ```typescript
   * await client.runs.ingestSpans('run_123', [
   *   { id: 'span_a', name: 'plan', type: 'model_call', startedAt: t0, endedAt: t1 },
   * ]);
   * ```
   */
  async ingestSpans(
    runId: string,
    spans: SpanInput[],
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<IngestSpansResult>> {
    return this._post<IngestSpansResult>(`/${runId}/spans`, { spans }, this._idempotent(options));
  }

  /**
   * Attach feedback to a run, or a specific span within it  the start of the
   * learning loop from production behaviour.
   *
   * @example
   * ```typescript
   * await client.runs.addFeedback('run_123', { label: 'thumbs_up', rating: 1 });
   * ```
   */
  async addFeedback(
    runId: string,
    feedback: AddFeedbackRequest = {},
    options?: IdempotentRequestOptions
  ): Promise<ApiResponse<RunFeedback>> {
    return this._post<RunFeedback>(`/${runId}/feedback`, feedback, this._idempotent(options));
  }

  /** List feedback for a run. */
  async listFeedback(runId: string): Promise<ApiResponse<RunFeedback[]>> {
    return this._get<RunFeedback[]>(`/${runId}/feedback`);
  }
}
