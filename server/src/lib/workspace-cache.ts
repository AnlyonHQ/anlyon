import { redis, RedisKeys } from "./redis.ts";
import { db } from "../db/index.ts";
import { workspaces } from "../db/schema/workspaces.ts";
import { eq } from "drizzle-orm";
import { getPlanLimits, normalizePlan, planLimitsEpoch, type PlanType } from "../core/plans/limits.ts";
import { createLogger } from "./logger.ts";

const logger = createLogger({ module: "workspace-cache" });

const CACHE_TTL = 300;
export const WORKSPACE_CACHE_VERSION = 2;

export interface CachedWorkspace {
  version: number;
  policyEpoch: number;
  createdAt: string;
  id: string;
  plan: PlanType;
  maxRetries: number;
  maxMessagesPerDay: number | "unlimited";
  maxMonthlyMessages: number | "unlimited";
  maxMessageSize: number;
  maxMonthlyBandwidth: number;
}

export async function getWorkspaceCached(workspaceId: string): Promise<CachedWorkspace | null> {
  const cacheKey = RedisKeys.workspaceCache(workspaceId);

  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      const workspace = JSON.parse(cached) as CachedWorkspace | null;
      if (workspace?.version === WORKSPACE_CACHE_VERSION && workspace.policyEpoch === planLimitsEpoch()) return workspace;
    } catch {
    }
  }

  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));

  if (!workspace) {
    return null;
  }

  const plan = normalizePlan(workspace.plan);
  const limits = getPlanLimits(plan, workspace);

  const cachedData: CachedWorkspace = {
    version: WORKSPACE_CACHE_VERSION,
    policyEpoch: planLimitsEpoch(),
    createdAt: workspace.createdAt.toISOString(),
    id: workspace.id,
    plan,
    maxRetries: limits.maxRetries,
    maxMessagesPerDay: limits.maxMessagesPerDay,
    maxMonthlyMessages: limits.maxMonthlyMessages,
    maxMessageSize: limits.maxMessageSize,
    maxMonthlyBandwidth: limits.maxMonthlyBandwidth,
  };

  await redis.set(cacheKey, JSON.stringify(cachedData), "EX", CACHE_TTL);

  logger.debug({ workspaceId, plan }, "Workspace cached");

  return cachedData;
}

export async function invalidateWorkspaceCache(workspaceId: string): Promise<void> {
  await redis.del(RedisKeys.workspaceCache(workspaceId));
  logger.debug({ workspaceId }, "Workspace cache invalidated");
}

export function getTodayKey(): string {
  return new Date().toISOString().split("T")[0];
}

export function getMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

export interface QuotaDecision {
  reservationId?: string;
  allowed: boolean;
  reason?: string;
  rejectedDimension?: "message_size" | "messages_daily" | "messages_monthly" | "bandwidth";
  dailyUsage: number;
  monthlyUsage: number;
  bandwidthUsage: number;
  dailyCap: number | null;
  monthlyCap: number | null;
  bandwidthCap: number | null;
  messageSizeCap: number;
}

export async function reservePlanQuota(workspaceId: string, messageCount = 1, messageSize = 0,
  _cachedWorkspace?: CachedWorkspace | null): Promise<QuotaDecision> {
  const { reserveMessageQuota } = await import("../core/billing/message-accounting.ts");
  return reserveMessageQuota(workspaceId, messageCount, messageSize);
}

export async function releasePlanQuota(workspaceId: string, _messageCount = 1, _messageSize = 0, reservationId?: string): Promise<void> {
  if (!reservationId) throw new Error("A durable reservation ID is required for quota release");
  const { finishMessageQuota } = await import("../core/billing/message-accounting.ts");
  await finishMessageQuota(workspaceId, reservationId, "released");
}

export async function incrementQuotaFast(
  workspaceId: string,
  messageCount: number = 1,
  messageSize: number = 0
): Promise<void> {
  const today = getTodayKey();
  const month = getMonthKey();

  const pipeline = redis.pipeline();

  const dailyKey = RedisKeys.quotaDaily(workspaceId, today);
  pipeline.incrby(dailyKey, messageCount);
  pipeline.expire(dailyKey, 90000);

  const monthlyKey = RedisKeys.quotaMonthly(workspaceId, month);
  pipeline.incrby(monthlyKey, messageCount);
  pipeline.expire(monthlyKey, 2678400);

  if (messageSize > 0) {
    const bandwidthKey = RedisKeys.quotaBandwidth(workspaceId, month);
    pipeline.incrby(bandwidthKey, messageSize * messageCount);
    pipeline.expire(bandwidthKey, 2678400);
  }

  await pipeline.exec();
}

export async function incrementEventPublishesFast(
  workspaceId: string,
  count: number = 1
): Promise<void> {
  if (count <= 0) return;
  const key = RedisKeys.quotaEventPublishes(workspaceId, getMonthKey());
  const pipeline = redis.pipeline();
  pipeline.incrby(key, count);
  pipeline.expire(key, 2678400);
  await pipeline.exec();
}

export async function getMonthlyEventPublishes(workspaceId: string): Promise<number> {
  const value = await redis.get(RedisKeys.quotaEventPublishes(workspaceId, getMonthKey()));
  return parseInt(value || "0", 10);
}

export async function incrementActionInvokesFast(
  workspaceId: string,
  count: number = 1
): Promise<void> {
  if (count <= 0) return;
  const key = RedisKeys.quotaActionInvokes(workspaceId, getMonthKey());
  const pipeline = redis.pipeline();
  pipeline.incrby(key, count);
  pipeline.expire(key, 2678400);
  await pipeline.exec();
}

export async function getMonthlyActionInvokes(workspaceId: string): Promise<number> {
  const value = await redis.get(RedisKeys.quotaActionInvokes(workspaceId, getMonthKey()));
  return parseInt(value || "0", 10);
}
