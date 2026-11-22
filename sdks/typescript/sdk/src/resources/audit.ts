/**
 * Audit resource: the workspace's stored audit records and the evidence export.
 *
 * Enterprise edition and Team plan; elsewhere every call answers 404. Needs an operator key holding
 * `audit:read`, which no key receives by default, and returns only the key's own environment's
 * records. Streaming to a SIEM, sinks and retention are managed in the console.
 *
 * Every record has the `anlyon.audit.v1` shape. Its `id` is stable across every delivery and
 * export: deduplicate on it.
 */

import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import type { ApiResponse } from '../types/api';

export type AuditCategory =
  | 'approval'
  | 'invocation'
  | 'policy'
  | 'action'
  | 'access'
  | 'environment'
  | 'connection'
  | 'limit'
  | 'audit';

export interface AuditEvent {
  schema: 'anlyon.audit.v1';
  /** Stable across retries, redeliveries, sinks and exports. Deduplicate on it. */
  id: string;
  /** Orders records within one deployment. Not a dedup key. */
  sequence: number;
  type: string;
  category: AuditCategory;
  occurredAt: string;
  workspaceId: string;
  environmentId: string | null;
  actor: { type: 'user' | 'api_key' | 'oauth_client' | 'assistant' | 'policy' | 'system'; id: string | null; onBehalfOf?: string | null };
  resource: { type: string; id: string } | null;
  outcome: string | null;
  data: Record<string, unknown>;
  context: { requestId?: string; ip?: string; userAgent?: string } | null;
  test?: true;
  /** Created from history by the one-time backfill, with the original time. */
  backfilled?: true;
}

export interface AuditEventFilter {
  from?: string | Date;
  to?: string | Date;
  /** Event types or prefixes, for example `['approval.*', 'policy.updated']`. */
  type?: string[];
  category?: AuditCategory;
  /** A governed action's name or id. */
  action?: string;
}

export interface AuditEventPage {
  success: true;
  data: AuditEvent[];
  /** Pass `nextBefore` as `before` for the next (older) page. Null on the last page. */
  pagination: { nextBefore: number | null };
}

export interface AuditExportDocument {
  schema: 'anlyon.audit.export.v1';
  generatedAt: string;
  workspaceId: string;
  filters: Record<string, unknown>;
  events: AuditEvent[];
  count: number;
}

export interface AuditSchema {
  schema: 'anlyon.audit.v1';
  jsonSchema: Record<string, unknown>;
  eventTypes: Record<AuditCategory, string[]>;
}

type ExportParams = Omit<AuditEventFilter, 'from' | 'to'> & { from: string | Date; to: string | Date };

export class AuditResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/audit');
  }

  /**
   * Stored audit records, newest first, a page at a time.
   *
   * @example
   * ```typescript
   * const page = await client.audit.listEvents({ type: ['approval.*'], limit: 100 });
   * const older = await client.audit.listEvents({ before: page.pagination.nextBefore ?? undefined });
   * ```
   */
  listEvents(params: AuditEventFilter & { limit?: number; before?: number } = {}): Promise<AuditEventPage> {
    return this.http.get(this.buildPath('/events'), { params: query(params) });
  }

  /**
   * Every record in a range of at most 366 days, oldest first: one JSON document, or CSV text.
   * Taking an export is itself recorded.
   *
   * @example
   * ```typescript
   * const csv = await client.audit.export({ from: '2026-10-01', to: '2026-11-01', format: 'csv' });
   * ```
   */
  export(params: ExportParams & { format?: 'json' }): Promise<AuditExportDocument>;
  export(params: ExportParams & { format: 'csv' }): Promise<string>;
  export(params: ExportParams & { format?: 'json' | 'csv' }): Promise<AuditExportDocument | string> {
    const format = params.format ?? 'json';
    return this.http.get(this.buildPath('/export'), {
      params: { ...query(params), format },
      responseType: format === 'csv' ? 'text' : 'json',
    });
  }

  /** The JSON Schema of one v1 record, and the record types by category. */
  schema(): Promise<ApiResponse<AuditSchema>> {
    return this._get<AuditSchema>('/schema');
  }
}

function iso(value: string | Date | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function query(params: AuditEventFilter & { limit?: number; before?: number; format?: string }): Record<string, unknown> {
  const { from, to, type, format: _format, ...rest } = params;
  return {
    ...rest,
    from: iso(from),
    to: iso(to),
    type: type && type.length > 0 ? type.join(',') : undefined,
  };
}
