import type { HttpMethod } from "./message.ts";

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  requestId?: string;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  cursor?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasMore: boolean;
    nextCursor?: string;
  };
}

export interface PublishMessageRequest {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: any;
  queue?: string;
  executeAt?: number;
  scheduledFor?: string;
  maxRetries?: number;
  contentId?: string;
  callbackUrl?: string;
  failureCallbackUrl?: string;
  runId?: string;
  parentSpanId?: string;
}

export interface AnalyticsQuery {
  startDate: string;
  endDate: string;
  granularity?: "hour" | "day" | "week" | "month";
}

export interface MessageAnalytics {
  published: number;
  delivered: number;
  failed: number;
  pending: number;
  successRate: number;
  averageDeliveryTime: number;
}
