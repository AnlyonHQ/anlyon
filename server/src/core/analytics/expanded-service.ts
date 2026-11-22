import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { actionInvocations, actions } from "../../db/schema/actions.ts";
import { agents } from "../../db/schema/agents.ts";
import { approvalPolicies, approvals } from "../../db/schema/approvals.ts";
import { runs } from "../../db/schema/runs.ts";
import { usageLogs } from "../../db/schema/billing.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { getPlanLimits } from "../plans/limits.ts";
import {
  getErrorDistribution,
  getMessageAnalytics,
  getMessageTimeSeries,
  getTopURLs,
} from "./service.ts";
import type {
  AgentAnalytics,
  AnalyticsGranularity,
  AnalyticsMetadata,
  DeliveryAnalytics,
  OverviewAnalytics,
  ProductUsagePoint,
  TrustControlAnalytics,
} from "./types.ts";

const FORMATS = {
  hour: `'YYYY-MM-DD HH24:00:00'`,
  day: `'YYYY-MM-DD'`,
  week: `'IYYY-"W"IW'`,
  month: `'YYYY-MM'`,
} as const;

const n = (value: unknown): number => Number(value ?? 0);
const rate = (value: number, total: number): number =>
  total > 0 ? Math.round((value / total) * 10_000) / 100 : 0;

function metadata(
  workspaceId: string,
  environmentId: string | undefined,
  startDate: Date,
  endDate: Date,
  granularity: AnalyticsGranularity,
): AnalyticsMetadata {
  return {
    range: {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      granularity,
      truncated: false,
      retentionDays: null,
    },
    scope: { workspaceId, environmentId: environmentId ?? null },
  };
}

export async function getEffectiveAnalyticsRange(
  workspaceId: string,
  requestedStart: Date,
  requestedEnd: Date,
) {
  const [workspace] = await db
    .select({ plan: workspaces.plan })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const configured = workspace
    ? getPlanLimits(workspace.plan).analyticsRetentionDays
    : 14;
  if (configured === "unlimited") {
    return {
      startDate: requestedStart,
      endDate: requestedEnd,
      retentionDays: null,
      truncated: false,
    };
  }
  const floor = new Date(Date.now() - configured * 86_400_000);
  const startDate = requestedStart < floor ? floor : requestedStart;
  const endDate = requestedEnd < floor ? floor : requestedEnd;
  return {
    startDate,
    endDate,
    retentionDays: configured,
    truncated:
      startDate.getTime() !== requestedStart.getTime() ||
      endDate.getTime() !== requestedEnd.getTime(),
  };
}

async function productUsageHistory(
  workspaceId: string,
  startDate: Date,
  endDate: Date,
): Promise<ProductUsagePoint[]> {
  const rows = await db
    .select()
    .from(usageLogs)
    .where(
      and(
        eq(usageLogs.workspaceId, workspaceId),
        gte(sql`${usageLogs.date}::date`, startDate),
        lte(sql`${usageLogs.date}::date`, endDate),
      ),
    )
    .orderBy(usageLogs.date);
  return rows.map((row) => ({
    date: row.date,
    messagesPublished: n(row.messagesPublished),
    messagesDelivered: n(row.messagesDelivered),
    messagesFailed: n(row.messagesFailed),
    bandwidthBytes: n(row.bandwidthBytes),
    eventPublishes: n(row.eventPublishes),
    actionInvokes: n(row.actionInvokes),
  }));
}

export async function getAgentAnalytics(
  workspaceId: string,
  startDate: Date,
  endDate: Date,
  granularity: AnalyticsGranularity,
  limit: number,
  environmentId?: string,
): Promise<AgentAnalytics> {
  const where = and(
    eq(runs.workspaceId, workspaceId),
    environmentId ? eq(runs.environmentId, environmentId) : undefined,
    gte(runs.startedAt, startDate),
    lte(runs.startedAt, endDate),
  );
  const period = sql<string>`to_char(${runs.startedAt}, ${sql.raw(FORMATS[granularity])})`;
  const [summaryRows, seriesRows, agentRows, versionRows] = await Promise.all([
    db.select({
      total: sql<number>`count(*)`,
      running: sql<number>`count(*) filter (where ${runs.status} = 'running')`,
      succeeded: sql<number>`count(*) filter (where ${runs.status} = 'succeeded')`,
      failed: sql<number>`count(*) filter (where ${runs.status} = 'failed')`,
      cancelled: sql<number>`count(*) filter (where ${runs.status} = 'cancelled')`,
      p50: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${runs.durationMs}) filter (where ${runs.durationMs} is not null), 0)`,
      p95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${runs.durationMs}) filter (where ${runs.durationMs} is not null), 0)`,
      tokens: sql<number>`coalesce(sum(${runs.tokens}), 0)`,
      cost: sql<number>`coalesce(sum(${runs.cost}), 0)`,
    }).from(runs).where(where),
    db.select({
      period,
      total: sql<number>`count(*)`,
      running: sql<number>`count(*) filter (where ${runs.status} = 'running')`,
      succeeded: sql<number>`count(*) filter (where ${runs.status} = 'succeeded')`,
      failed: sql<number>`count(*) filter (where ${runs.status} = 'failed')`,
      cancelled: sql<number>`count(*) filter (where ${runs.status} = 'cancelled')`,
    }).from(runs).where(where).groupBy(period).orderBy(period),
    db.select({
      agentId: runs.agentId,
      name: agents.name,
      total: sql<number>`count(*)`,
      succeeded: sql<number>`count(*) filter (where ${runs.status} = 'succeeded')`,
      failed: sql<number>`count(*) filter (where ${runs.status} = 'failed')`,
      tokens: sql<number>`coalesce(sum(${runs.tokens}), 0)`,
      cost: sql<number>`coalesce(sum(${runs.cost}), 0)`,
    }).from(runs)
      .leftJoin(agents, and(eq(runs.agentId, agents.agentId), eq(runs.workspaceId, agents.workspaceId)))
      .where(where).groupBy(runs.agentId, agents.name)
      .orderBy(desc(sql`count(*)`)).limit(limit),
    db.select({
      agentVersionId: runs.agentVersionId,
      total: sql<number>`count(*)`,
      succeeded: sql<number>`count(*) filter (where ${runs.status} = 'succeeded')`,
      failed: sql<number>`count(*) filter (where ${runs.status} = 'failed')`,
    }).from(runs).where(and(where, sql`${runs.agentVersionId} is not null`))
      .groupBy(runs.agentVersionId).orderBy(desc(sql`count(*)`)).limit(limit),
  ]);
  const summary = summaryRows[0];
  const total = n(summary?.total);
  const succeeded = n(summary?.succeeded);
  return {
    ...metadata(workspaceId, environmentId, startDate, endDate, granularity),
    summary: {
      totalRuns: total,
      runningRuns: n(summary?.running),
      succeededRuns: succeeded,
      failedRuns: n(summary?.failed),
      cancelledRuns: n(summary?.cancelled),
      successRate: rate(succeeded, total),
      p50DurationMs: Math.round(n(summary?.p50)),
      p95DurationMs: Math.round(n(summary?.p95)),
      totalTokens: n(summary?.tokens),
      totalCost: n(summary?.cost),
    },
    series: seriesRows.map((row) => ({
      period: row.period,
      total: n(row.total),
      running: n(row.running),
      succeeded: n(row.succeeded),
      failed: n(row.failed),
      cancelled: n(row.cancelled),
    })),
    topAgents: agentRows.map((row) => ({
      agentId: row.agentId,
      name: row.name ?? row.agentId ?? "Unattributed",
      totalRuns: n(row.total),
      failedRuns: n(row.failed),
      successRate: rate(n(row.succeeded), n(row.total)),
      totalTokens: n(row.tokens),
      totalCost: n(row.cost),
    })),
    topVersions: versionRows
      .filter((row): row is typeof row & { agentVersionId: string } => row.agentVersionId !== null)
      .map((row) => ({
        agentVersionId: row.agentVersionId,
        totalRuns: n(row.total),
        failedRuns: n(row.failed),
        successRate: rate(n(row.succeeded), n(row.total)),
      })),
  };
}

export async function getTrustControlAnalytics(
  workspaceId: string,
  startDate: Date,
  endDate: Date,
  granularity: AnalyticsGranularity,
  limit: number,
  environmentId?: string,
): Promise<TrustControlAnalytics> {
  const actionWhere = and(
    eq(actionInvocations.workspaceId, workspaceId),
    environmentId ? eq(actionInvocations.environmentId, environmentId) : undefined,
    gte(actionInvocations.createdAt, startDate),
    lte(actionInvocations.createdAt, endDate),
  );
  const approvalWhere = and(
    eq(approvals.workspaceId, workspaceId),
    environmentId ? eq(approvals.environmentId, environmentId) : undefined,
    gte(approvals.createdAt, startDate),
    lte(approvals.createdAt, endDate),
  );
  const actionPeriod = sql<string>`to_char(${actionInvocations.createdAt}, ${sql.raw(FORMATS[granularity])})`;
  const approvalPeriod = sql<string>`to_char(${approvals.createdAt}, ${sql.raw(FORMATS[granularity])})`;
  const [aSummaryRows, aSeriesRows, topActionRows, pSummaryRows, pendingRows, pSeriesRows, policyRows] =
    await Promise.all([
      db.select({
        total: sql<number>`count(*)`,
        succeeded: sql<number>`count(*) filter (where ${actionInvocations.status} = 'succeeded')`,
        failed: sql<number>`count(*) filter (where ${actionInvocations.status} = 'failed')`,
        denied: sql<number>`count(*) filter (where ${actionInvocations.status} in ('denied', 'expired'))`,
        pending: sql<number>`count(*) filter (where ${actionInvocations.status} in ('pending_approval', 'running'))`,
        gated: sql<number>`count(*) filter (where ${actionInvocations.approvalId} is not null)`,
        p50: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${actionInvocations.durationMs}) filter (where ${actionInvocations.durationMs} is not null), 0)`,
        p95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${actionInvocations.durationMs}) filter (where ${actionInvocations.durationMs} is not null), 0)`,
      }).from(actionInvocations).where(actionWhere),
      db.select({
        period: actionPeriod,
        total: sql<number>`count(*)`,
        succeeded: sql<number>`count(*) filter (where ${actionInvocations.status} = 'succeeded')`,
        failed: sql<number>`count(*) filter (where ${actionInvocations.status} = 'failed')`,
        denied: sql<number>`count(*) filter (where ${actionInvocations.status} in ('denied', 'expired'))`,
        pending: sql<number>`count(*) filter (where ${actionInvocations.status} in ('pending_approval', 'running'))`,
      }).from(actionInvocations).where(actionWhere).groupBy(actionPeriod).orderBy(actionPeriod),
      db.select({
        actionId: actions.actionId,
        name: actions.name,
        total: sql<number>`count(*)`,
        succeeded: sql<number>`count(*) filter (where ${actionInvocations.status} = 'succeeded')`,
        failed: sql<number>`count(*) filter (where ${actionInvocations.status} = 'failed')`,
        p95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${actionInvocations.durationMs}) filter (where ${actionInvocations.durationMs} is not null), 0)`,
      }).from(actionInvocations).innerJoin(actions, eq(actionInvocations.actionId, actions.id))
        .where(actionWhere).groupBy(actions.actionId, actions.name)
        .orderBy(desc(sql`count(*)`)).limit(limit),
      db.select({
        total: sql<number>`count(*)`,
        approved: sql<number>`count(*) filter (where ${approvals.status} = 'approved')`,
        denied: sql<number>`count(*) filter (where ${approvals.status} = 'denied')`,
        expired: sql<number>`count(*) filter (where ${approvals.status} = 'expired')`,
        p50: sql<number>`coalesce(percentile_cont(0.5) within group (order by extract(epoch from (${approvals.decidedAt} - ${approvals.createdAt})) * 1000) filter (where ${approvals.decidedAt} is not null), 0)`,
        p95: sql<number>`coalesce(percentile_cont(0.95) within group (order by extract(epoch from (${approvals.decidedAt} - ${approvals.createdAt})) * 1000) filter (where ${approvals.decidedAt} is not null), 0)`,
      }).from(approvals).where(approvalWhere),
      db.select({
        total: sql<number>`count(*)`,
        oldest: sql<number>`coalesce(max(extract(epoch from (now() - ${approvals.createdAt})) * 1000), 0)`,
      }).from(approvals).where(and(
        eq(approvals.workspaceId, workspaceId),
        environmentId ? eq(approvals.environmentId, environmentId) : undefined,
        eq(approvals.status, "pending"),
      )),
      db.select({
        period: approvalPeriod,
        total: sql<number>`count(*)`,
        approved: sql<number>`count(*) filter (where ${approvals.status} = 'approved')`,
        denied: sql<number>`count(*) filter (where ${approvals.status} = 'denied')`,
        expired: sql<number>`count(*) filter (where ${approvals.status} = 'expired')`,
        pending: sql<number>`count(*) filter (where ${approvals.status} = 'pending')`,
      }).from(approvals).where(approvalWhere).groupBy(approvalPeriod).orderBy(approvalPeriod),
      db.select({
        policyId: approvals.matchedPolicyId,
        name: approvalPolicies.name,
        total: sql<number>`count(*)`,
        approved: sql<number>`count(*) filter (where ${approvals.status} = 'approved')`,
        denied: sql<number>`count(*) filter (where ${approvals.status} = 'denied')`,
        expired: sql<number>`count(*) filter (where ${approvals.status} = 'expired')`,
      }).from(approvals)
        .leftJoin(approvalPolicies, and(
          eq(approvals.matchedPolicyId, approvalPolicies.policyId),
          eq(approvals.workspaceId, approvalPolicies.workspaceId),
        ))
        .where(approvalWhere).groupBy(approvals.matchedPolicyId, approvalPolicies.name)
        .orderBy(desc(sql`count(*)`)).limit(limit),
    ]);
  const a = aSummaryRows[0];
  const p = pSummaryRows[0];
  const pending = pendingRows[0];
  return {
    ...metadata(workspaceId, environmentId, startDate, endDate, granularity),
    actions: {
      summary: {
        totalInvocations: n(a?.total),
        succeededInvocations: n(a?.succeeded),
        failedInvocations: n(a?.failed),
        deniedInvocations: n(a?.denied),
        pendingInvocations: n(a?.pending),
        successRate: rate(n(a?.succeeded), n(a?.total)),
        p50DurationMs: Math.round(n(a?.p50)),
        p95DurationMs: Math.round(n(a?.p95)),
        approvalGatedRate: rate(n(a?.gated), n(a?.total)),
      },
      series: aSeriesRows.map((row) => ({
        period: row.period,
        total: n(row.total),
        pending: n(row.pending),
        succeeded: n(row.succeeded),
        failed: n(row.failed),
        denied: n(row.denied),
      })),
      topActions: topActionRows.map((row) => ({
        actionId: row.actionId,
        name: row.name,
        totalInvocations: n(row.total),
        failedInvocations: n(row.failed),
        successRate: rate(n(row.succeeded), n(row.total)),
        p95DurationMs: Math.round(n(row.p95)),
      })),
    },
    approvals: {
      summary: {
        totalRequests: n(p?.total),
        pendingRequests: n(pending?.total),
        approvedRequests: n(p?.approved),
        deniedRequests: n(p?.denied),
        expiredRequests: n(p?.expired),
        approvalRate: rate(n(p?.approved), n(p?.total)),
        p50DecisionMs: Math.round(n(p?.p50)),
        p95DecisionMs: Math.round(n(p?.p95)),
        oldestPendingMs: Math.round(n(pending?.oldest)),
      },
      series: pSeriesRows.map((row) => ({
        period: row.period,
        total: n(row.total),
        pending: n(row.pending),
        approved: n(row.approved),
        denied: n(row.denied),
        expired: n(row.expired),
      })),
      topPolicies: policyRows.map((row) => ({
        policyId: row.policyId,
        name: row.name ?? row.policyId ?? "No matched policy",
        totalRequests: n(row.total),
        approvedRequests: n(row.approved),
        deniedRequests: n(row.denied),
        expiredRequests: n(row.expired),
      })),
    },
  };
}

export async function getDeliveryAnalytics(
  workspaceId: string,
  startDate: Date,
  endDate: Date,
  granularity: AnalyticsGranularity,
  limit: number,
  environmentId?: string,
): Promise<DeliveryAnalytics> {
  const [messageStats, messageSeries, topUrls, errors, usage] = await Promise.all([
    getMessageAnalytics(workspaceId, startDate, endDate, environmentId),
    getMessageTimeSeries(workspaceId, startDate, endDate, granularity, environmentId),
    getTopURLs(workspaceId, startDate, endDate, limit, environmentId),
    getErrorDistribution(workspaceId, startDate, endDate, limit, environmentId),
    productUsageHistory(workspaceId, startDate, endDate),
  ]);
  return {
    ...metadata(workspaceId, environmentId, startDate, endDate, granularity),
    messages: messageStats,
    messageSeries,
    bandwidthBytes: usage.at(-1)?.bandwidthBytes ?? 0,
    topUrls,
    errors,
  };
}

export async function getOverviewAnalytics(
  workspaceId: string,
  startDate: Date,
  endDate: Date,
  granularity: AnalyticsGranularity,
  limit: number,
  environmentId?: string,
): Promise<OverviewAnalytics> {
  const [agent, trust, delivery, usage] = await Promise.all([
    getAgentAnalytics(workspaceId, startDate, endDate, granularity, limit, environmentId),
    getTrustControlAnalytics(workspaceId, startDate, endDate, granularity, limit, environmentId),
    getDeliveryAnalytics(workspaceId, startDate, endDate, granularity, limit, environmentId),
    productUsageHistory(workspaceId, startDate, endDate),
  ]);
  const latest = usage.at(-1);
  const counters: OverviewAnalytics["usage"]["counters"] = {
    messagesPublished: usage.reduce((sum, point) => sum + point.messagesPublished, 0),
    messagesDelivered: usage.reduce((sum, point) => sum + point.messagesDelivered, 0),
    messagesFailed: usage.reduce((sum, point) => sum + point.messagesFailed, 0),
    bandwidthBytes: latest?.bandwidthBytes ?? 0,
    eventPublishes: latest?.eventPublishes ?? 0,
    actionInvokes: latest?.actionInvokes ?? 0,
  };
  const attentionCandidates: OverviewAnalytics["attention"] = [
    { product: "agents", label: "Failed agent runs", count: agent.summary.failedRuns, href: "/recent-runs" },
    { product: "delivery", label: "Failed messages", count: delivery.messages.failed, href: "/logs-explorer" },
    { product: "actions", label: "Failed action invocations", count: trust.actions.summary.failedInvocations, href: "/actions" },
    { product: "approvals", label: "Pending approvals", count: trust.approvals.summary.pendingRequests, href: "/approvals" },
  ];
  return {
    ...metadata(workspaceId, environmentId, startDate, endDate, granularity),
    summary: {
      agentRuns: agent.summary.totalRuns,
      agentRunSuccessRate: agent.summary.successRate,
      messagesDelivered: delivery.messages.delivered,
      messageSuccessRate: delivery.messages.successRate,
      actionInvocations: trust.actions.summary.totalInvocations,
      actionSuccessRate: trust.actions.summary.successRate,
      pendingApprovals: trust.approvals.summary.pendingRequests,
    },
    usage: {
      counters,
      scope: "workspace",
    },
    series: usage,
    deliverySeries: delivery.messageSeries,
    attention: attentionCandidates.filter((item) => item.count > 0),
  };
}
