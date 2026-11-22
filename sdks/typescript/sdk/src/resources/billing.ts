/**
 * Billing resource client for Anlyon Scheduler SDK
 */

import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import type {
  ApiResponse,
  PlanDetails,
  BillingUsage,
  BillingPlanList,
  BillingUsageHistory,
  BillingQuota,
  CostEstimate,
  BillingInvoiceList,
  WorkspaceBillingBudget,
} from '../types/api';

/**
 * Client for accessing billing and plan information
 */
export class BillingResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/billing');
  }

  /**
   * Get current plan details including limits and features
   *
   * @example
   * ```typescript
   * const result = await client.billing.getCurrentPlan();
   *
   * console.log(`Current plan: ${result.data?.plan}`);
   * console.log(`Approvals enabled: ${result.data?.features.approvals}`);
   * ```
   */
  async getCurrentPlan(): Promise<ApiResponse<PlanDetails>> {
    return this._get<PlanDetails>('/plan');
  }

  /**
   * Get current billing period usage and costs
   *
   * @example
   * ```typescript
   * const result = await client.billing.getCurrentUsage();
   *
   * console.log(`Messages this month: ${result.data?.currentMonthMessages}`);
   * console.log(`Estimated cost: $${result.data?.estimatedCost.toFixed(2)}`);
   * ```
   */
  async getCurrentUsage(): Promise<ApiResponse<BillingUsage>> {
    return this._get<BillingUsage>('/usage/current');
  }

  /**
   * List all available pricing plans
   *
   * @example
   * ```typescript
   * const result = await client.billing.listPlans();
   *
   * console.log(result.data?.plans.production.name);
   * ```
   */
  async listPlans(): Promise<ApiResponse<BillingPlanList>> {
    return this._get<BillingPlanList>('/plans');
  }

  /**
   * Get historical usage data
   *
   * @param params - Query parameters
   * @param params.days - Number of days to look back (1-90, default: 30)
   *
   * @example
   * ```typescript
   * const result = await client.billing.getUsageHistory({ days: 60 });
   *
   * result.data?.history.forEach(entry => {
   *   console.log(`${entry.date}: ${entry.messagesPublished} messages`);
   * });
   * ```
   */
  async getUsageHistory(
    params?: { days?: number }
  ): Promise<ApiResponse<BillingUsageHistory>> {
    return this._get<BillingUsageHistory>('/usage/history', params);
  }

  /**
   * Get cost estimate for the current billing period
   *
   * @example
   * ```typescript
   * const result = await client.billing.getCostEstimate();
   *
   * console.log(`Estimated cost: $${result.data?.currentMonth.estimatedCost.toFixed(2)}`);
   * ```
   */
  async getCostEstimate(): Promise<ApiResponse<CostEstimate>> {
    return this._get<CostEstimate>('/cost-estimate');
  }

  /**
   * List invoices for the workspace
   *
   * @param params - Query parameters
   * @param params.limit - Maximum number of invoices to return (1-100, default: 10)
   *
   * @example
   * ```typescript
   * const result = await client.billing.listInvoices({ limit: 20 });
   *
   * result.data?.invoices.forEach(invoice => {
   *   console.log(`${invoice.periodStart}: $${invoice.amount} - ${invoice.status}`);
   * });
   * ```
   */
  async listInvoices(
    params?: { limit?: number }
  ): Promise<ApiResponse<BillingInvoiceList>> {
    return this._get<BillingInvoiceList>('/invoices', params);
  }

  async getQuota(): Promise<ApiResponse<BillingQuota>> {
    return this._get<BillingQuota>('/quota');
  }

  /** Read the workspace's alert-only overage target. This is not a spending cap. */
  async getWorkspaceBudget(): Promise<ApiResponse<WorkspaceBillingBudget>> {
    return this._get<WorkspaceBillingBudget>('/budget');
  }
}
