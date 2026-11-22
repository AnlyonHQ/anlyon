/**
 * Analytics resource client for Anlyon Scheduler SDK
 */

import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import type {
  ApiResponse,
  MessageAnalytics,
  TimeSeriesDataPoint,
  TopUrlEntry,
  CurrentUsage,
  UsageHistoryEntry,
  TimeGranularity,
  ErrorDistribution,
  OnboardingStatus,
  AnalyticsOverview,
  AgentAnalytics,
  TrustControlAnalytics,
  DeliveryAnalytics,
} from '../types/api';

export interface DateRangeParams {
  /** Start date (ISO 8601 or Date object) */
  startDate?: string | Date;
  /** End date (ISO 8601 or Date object) */
  endDate?: string | Date;
}

export interface TimeSeriesParams extends DateRangeParams {
  /** Time granularity for data points */
  granularity?: TimeGranularity;
}

export interface TopUrlsParams extends DateRangeParams {
  /** Number of URLs to return (1-100, default: 10) */
  limit?: number;
}

export interface ProductAnalyticsParams extends TimeSeriesParams {
  /** Limit top entities returned by product breakdowns (1-100). */
  limit?: number;
  /** Restrict results to one environment. API keys remain bound to their environment. */
  environmentId?: string;
}

/**
 * Client for accessing analytics and usage data
 */
export class AnalyticsResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/analytics');
  }

  /** Get the cross-product analytics overview. */
  async getOverview(
    params?: ProductAnalyticsParams
  ): Promise<ApiResponse<AnalyticsOverview>> {
    return this._get<AnalyticsOverview>(
      '/overview',
      this.normalizeDateParams(params)
    );
  }

  /** Get agent run volume, reliability, latency, token, and cost analytics. */
  async getAgentAnalytics(
    params?: ProductAnalyticsParams
  ): Promise<ApiResponse<AgentAnalytics>> {
    return this._get<AgentAnalytics>(
      '/agents',
      this.normalizeDateParams(params)
    );
  }

  /** Get action invocation and approval decision analytics. */
  async getTrustControlAnalytics(
    params?: ProductAnalyticsParams
  ): Promise<ApiResponse<TrustControlAnalytics>> {
    return this._get<TrustControlAnalytics>(
      '/trust-control',
      this.normalizeDateParams(params)
    );
  }

  /** Get message delivery analytics. Event-webhook deliveries are messages. */
  async getDeliveryAnalytics(
    params?: ProductAnalyticsParams
  ): Promise<ApiResponse<DeliveryAnalytics>> {
    return this._get<DeliveryAnalytics>(
      '/delivery',
      this.normalizeDateParams(params)
    );
  }

  /**
   * Get aggregated message statistics
   *
   * @example
   * ```typescript
   * const result = await client.analytics.getMessageStats({
   *   startDate: new Date('2024-01-01'),
   *   endDate: new Date('2024-01-31'),
   * });
   *
   * console.log(`Success rate: ${result.data?.successRate}%`);
   * ```
   */
  async getMessageStats(
    params?: DateRangeParams
  ): Promise<ApiResponse<MessageAnalytics>> {
    return this._get<MessageAnalytics>('/messages', this.normalizeDateParams(params));
  }

  /**
   * Get message time series data
   *
   * @example
   * ```typescript
   * const result = await client.analytics.getTimeSeries({
   *   startDate: '2024-01-01',
   *   endDate: '2024-01-31',
   *   granularity: 'day',
   * });
   *
   * result.data?.forEach(point => {
   *   console.log(`${point.period}: ${point.delivered} delivered, ${point.failed} failed`);
   * });
   * ```
   */
  async getTimeSeries(
    params?: TimeSeriesParams
  ): Promise<ApiResponse<TimeSeriesDataPoint[]>> {
    return this._get<TimeSeriesDataPoint[]>(
      '/time-series',
      this.normalizeDateParams(params)
    );
  }

  /**
   * Get top destination URLs by usage
   *
   * @example
   * ```typescript
   * const result = await client.analytics.getTopUrls({
   *   limit: 20,
   *   startDate: new Date('2024-01-01'),
   * });
   *
   * result.data?.forEach(entry => {
   *   console.log(`${entry.url}: ${entry.messageCount} messages, ${entry.successRate}% success`);
   * });
   * ```
   */
  async getTopUrls(params?: TopUrlsParams): Promise<ApiResponse<TopUrlEntry[]>> {
    return this._get<TopUrlEntry[]>('/top-urls', this.normalizeDateParams(params));
  }

  /**
   * Get current day usage statistics
   *
   * @example
   * ```typescript
   * const result = await client.analytics.getCurrentUsage();
   *
   * console.log(`${result.data?.messagesPublished} messages published today`);
   * ```
   */
  async getCurrentUsage(): Promise<ApiResponse<CurrentUsage>> {
    return this._get<CurrentUsage>('/usage/current');
  }

  /**
   * Get historical usage data
   *
   * @example
   * ```typescript
   * const result = await client.analytics.getUsageHistory({
   *   startDate: new Date('2024-01-01'),
   *   endDate: new Date('2024-01-31'),
   * });
   *
   * result.data?.forEach(entry => {
   *   console.log(`${entry.date}: ${entry.messagesPublished} messages`);
   * });
   * ```
   */
  async getUsageHistory(
    params?: DateRangeParams
  ): Promise<ApiResponse<UsageHistoryEntry[]>> {
    return this._get<UsageHistoryEntry[]>(
      '/usage/history',
      this.normalizeDateParams(params)
    );
  }

  /**
   * Get error distribution statistics
   *
   * @example
   * ```typescript
   * const result = await client.analytics.getErrorDistribution({
   *   startDate: new Date('2024-01-01'),
   * });
   *
   * result.data?.forEach(error => {
   *   console.log(`${error.errorMessage}: ${error.count}`);
   * });
   * ```
   */
  async getErrorDistribution(
    params?: DateRangeParams & { limit?: number }
  ): Promise<ApiResponse<ErrorDistribution[]>> {
    return this._get<ErrorDistribution[]>('/errors', this.normalizeDateParams(params));
  }

  /** Get workspace setup progress and first-message activation state. */
  async getOnboardingStatus(): Promise<ApiResponse<OnboardingStatus>> {
    return this._get<OnboardingStatus>('/onboarding');
  }

  private normalizeDateParams(
    params?: DateRangeParams
  ): Record<string, unknown> | undefined {
    if (!params) return undefined;

    return {
      ...params,
      startDate:
        params.startDate instanceof Date
          ? params.startDate.toISOString()
          : params.startDate,
      endDate:
        params.endDate instanceof Date
          ? params.endDate.toISOString()
          : params.endDate,
    };
  }
}
