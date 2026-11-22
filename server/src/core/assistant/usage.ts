import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { assistantUsage } from "../../db/schema/assistant.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { env } from "../../config/env.ts";
import { getPlanLimits } from "../plans/limits.ts";
import { redis } from "../../lib/redis.ts";

export type AssistantUsageKind = "reviews" | "auto_approvals";

export function usagePeriod(kind: AssistantUsageKind, now: Date = new Date()): string {
  const iso = now.toISOString();
  return kind === "reviews" ? iso.slice(0, 7) : iso.slice(0, 10);
}

export async function assistantCaps(workspaceId: string): Promise<{ reviews: number | "unlimited"; autoApprovals: number | "unlimited" }> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const limits = getPlanLimits(workspace?.plan, workspace);
  return { reviews: limits.maxMonthlyAssistantReviews, autoApprovals: limits.maxDailyAssistantAutoApprovals };
}

export interface AssistantUsageReservation {
  workspaceId: string;
  kind: AssistantUsageKind;
  period: string;
}

export async function admitAssistantUsage(
  workspaceId: string,
  kind: AssistantUsageKind,
  cap: number | "unlimited",
  now: Date = new Date(),
): Promise<AssistantUsageReservation | null> {
  if (cap !== "unlimited" && cap <= 0) return null;
  const period = usagePeriod(kind, now);
  const limit = cap === "unlimited" ? null : cap;
  const rows = await db
    .insert(assistantUsage)
    .values({ workspaceId, period, kind, count: 1 })
    .onConflictDoUpdate({
      target: [assistantUsage.workspaceId, assistantUsage.period, assistantUsage.kind],
      set: { count: sql`${assistantUsage.count} + 1`, updatedAt: new Date() },
      ...(limit === null ? {} : { setWhere: sql`${assistantUsage.count} < ${limit}` }),
    })
    .returning({ count: assistantUsage.count });
  return rows.length > 0 ? { workspaceId, kind, period } : null;
}

export async function releaseAssistantUsage(reservation: AssistantUsageReservation): Promise<void> {
  await db
    .update(assistantUsage)
    .set({ count: sql`greatest(${assistantUsage.count} - 1, 0)`, updatedAt: new Date() })
    .where(and(
      eq(assistantUsage.workspaceId, reservation.workspaceId),
      eq(assistantUsage.period, reservation.period),
      eq(assistantUsage.kind, reservation.kind),
    ));
}

export async function platformReviewsThisMonth(now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${assistantUsage.count}), 0)::int` })
    .from(assistantUsage)
    .where(and(eq(assistantUsage.period, usagePeriod("reviews", now)), eq(assistantUsage.kind, "reviews")));
  return Number(row?.total ?? 0);
}

export async function platformCeilingReached(now: Date = new Date()): Promise<boolean> {
  return (await platformReviewsThisMonth(now)) >= env.ASSISTANT_PLATFORM_MONTHLY_REVIEW_CEILING;
}

const platformKey = (period: string) => `assistant:platform-reviews:${period}`;
const PLATFORM_KEY_TTL_SECONDS = 40 * 86_400;

const ADMIT_PLATFORM_LUA = `
local v = redis.call('GET', KEYS[1])
if not v then
  if ARGV[1] == '' then return -1 end
  v = ARGV[1]
  redis.call('SET', KEYS[1], v, 'EX', ARGV[3], 'NX')
  v = redis.call('GET', KEYS[1])
end
if tonumber(v) >= tonumber(ARGV[2]) then return 0 end
redis.call('INCR', KEYS[1])
return 1`;

export interface PlatformReviewReservation {
  period: string;
}

export async function admitPlatformReview(
  now: Date = new Date(),
  ceiling: number = env.ASSISTANT_PLATFORM_MONTHLY_REVIEW_CEILING,
): Promise<PlatformReviewReservation | null> {
  const period = usagePeriod("reviews", now);
  const key = platformKey(period);
  let admitted: boolean;
  try {
    const run = (seed: string) =>
      redis.eval(ADMIT_PLATFORM_LUA, 1, key, seed, String(ceiling), String(PLATFORM_KEY_TTL_SECONDS)) as Promise<number>;
    let result = Number(await run(""));
    if (result === -1) result = Number(await run(String(await platformReviewsThisMonth(now))));
    admitted = result === 1;
  } catch {
    admitted = (await platformReviewsThisMonth(now)) < ceiling;
  }
  return admitted ? { period } : null;
}

export async function releasePlatformReview(reservation: PlatformReviewReservation): Promise<void> {
  const key = platformKey(reservation.period);
  await redis
    .eval("local v = redis.call('GET', KEYS[1]) if v and tonumber(v) > 0 then return redis.call('DECR', KEYS[1]) end return 0", 1, key)
    .catch(() => {});
}

export interface AssistantUsageView {
  reviews: { used: number; cap: number | "unlimited"; period: string };
  autoApprovals: { used: number; cap: number | "unlimited"; period: string };
}

export async function getAssistantUsage(workspaceId: string, now: Date = new Date()): Promise<AssistantUsageView> {
  const caps = await assistantCaps(workspaceId);
  const read = async (kind: AssistantUsageKind) => {
    const period = usagePeriod(kind, now);
    const [row] = await db
      .select({ count: assistantUsage.count })
      .from(assistantUsage)
      .where(and(eq(assistantUsage.workspaceId, workspaceId), eq(assistantUsage.period, period), eq(assistantUsage.kind, kind)))
      .limit(1);
    return { used: row?.count ?? 0, period };
  };
  const [reviews, autoApprovals] = await Promise.all([read("reviews"), read("auto_approvals")]);
  return {
    reviews: { ...reviews, cap: caps.reviews },
    autoApprovals: { ...autoApprovals, cap: caps.autoApprovals },
  };
}
