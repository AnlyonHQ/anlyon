import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import type { ApiResponse, PaginatedResponse } from '../types/api';

export interface ExecutionLog {
  id: string;
  type: 'message';
  entityId: string;
  status: string;
  timestamp: string;
  duration?: number | null; attemptNumber?: number | null; requestUrl?: string | null;
  requestMethod?: string | null; requestHeaders?: Record<string, unknown> | null; requestBody?: unknown | null;
  responseStatus?: number | null; responseHeaders?: Record<string, unknown> | null; responseBody?: string | null;
  errorMessage?: string | null; errorCode?: string | null;
}
export interface ExecutionLogStats {
  byStatus: Record<string, number>; byHttpStatus: Record<string, number>; byErrorCode: Record<string, number>;
  byHour: Array<{ hour: string; count: number; errors: number }>;
  avgDuration: number; p50Duration: number; p95Duration: number; p99Duration: number;
}
export interface ExecutionLogListResponse extends PaginatedResponse<ExecutionLog> {
  stats: { totalSuccess: number; totalError: number; totalRetry: number; avgDuration: number; errorRate: number };
}
export interface ExecutionLogExport { logs: ExecutionLog[] }

export interface LogQuery {
  type?: 'message' | 'all'; status?: string; startDate?: string | Date; endDate?: string | Date;
  httpStatus?: string; minDuration?: number; maxDuration?: number; url?: string; messageId?: string;
  errorCode?: string; search?: string; sortBy?: 'timestamp' | 'duration' | 'status' | 'httpStatus';
  sortOrder?: 'asc' | 'desc'; page?: number; limit?: number;
}

export class LogsResource extends BaseResource {
  constructor(http: HttpClient) { super(http, '/api/v2/logs'); }
  list(params?: LogQuery): Promise<ExecutionLogListResponse> { return this.http.get(this.buildPath(), { params: this.params(params) }); }
  stats(params?: Pick<LogQuery, 'type' | 'startDate' | 'endDate'>): Promise<ApiResponse<ExecutionLogStats>> { return this._get('/stats', this.params(params)); }
  export(params?: Omit<LogQuery, 'page' | 'limit'> & { format?: 'json' }): Promise<ExecutionLogExport>;
  export(params: Omit<LogQuery, 'page' | 'limit'> & { format: 'csv' }): Promise<string>;
  export(params: Omit<LogQuery, 'page' | 'limit'> & { format?: 'json' | 'csv' } = {}): Promise<ExecutionLogExport | string> {
    const format = params.format ?? 'json';
    return this.http.get(this.buildPath('/export'), { params: this.params({ ...params, format }), responseType: format === 'csv' ? 'text' : 'json' });
  }
  private params<T extends { startDate?: string | Date; endDate?: string | Date }>(params?: T): Record<string, unknown> | undefined {
    if (!params) return undefined;
    return { ...params, startDate: params.startDate instanceof Date ? params.startDate.toISOString() : params.startDate, endDate: params.endDate instanceof Date ? params.endDate.toISOString() : params.endDate };
  }
}
