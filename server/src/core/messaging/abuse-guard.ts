import { eq, isNotNull } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { redis, RedisKeys } from "../../lib/redis.ts";
import { createLogger } from "../../lib/logger.ts";

const logger = createLogger({ module: "abuse-guard" });

const MIN_DELIVERIES_TO_JUDGE = 500;
const FAILURE_RATE_TRIP = 0.8;
const DISTINCT_HOST_TRIP = 100;
const CHECK_EVERY = 50;

function hourKey(): string {
  return new Date().toISOString().slice(0, 13);
}

export async function trackDeliveryOutcome(
  workspaceId: string,
  url: string,
  ok: boolean,
): Promise<void> {
  try {
    const hour = hourKey();
    const statsKey = RedisKeys.abuseStats(workspaceId, hour);
    const hostsKey = RedisKeys.abuseHosts(workspaceId, hour);

    const pipeline = redis.pipeline();
    pipeline.hincrby(statsKey, "total", 1);
    if (!ok) pipeline.hincrby(statsKey, "failed", 1);
    try {
      pipeline.pfadd(hostsKey, new URL(url).hostname);
    } catch {
    }
    pipeline.expire(statsKey, 2 * 3600);
    pipeline.expire(hostsKey, 2 * 3600);
    const results = await pipeline.exec();

    const total = Number(results?.[0]?.[1] ?? 0);
    if (total < MIN_DELIVERIES_TO_JUDGE || total % CHECK_EVERY !== 0) return;

    const [failedRaw, hostCount] = await Promise.all([
      redis.hget(statsKey, "failed"),
      redis.pfcount(hostsKey),
    ]);
    const failed = Number(failedRaw ?? 0);
    const failureRate = failed / total;

    if (failureRate >= FAILURE_RATE_TRIP && hostCount >= DISTINCT_HOST_TRIP) {
      await suspendWorkspaceDeliveries(
        workspaceId,
        `auto: ${Math.round(failureRate * 100)}% failures across ${hostCount} hosts (${total} deliveries this hour)`,
      );
    }
  } catch (error) {
    logger.warn({ workspaceId, error }, "Abuse tracking failed");
  }
}

export async function isWorkspaceSuspended(workspaceId: string): Promise<boolean> {
  try {
    return (await redis.exists(RedisKeys.workspaceSuspended(workspaceId))) === 1;
  } catch {
    try {
      const [row] = await db
        .select({ suspendedAt: workspaces.deliverySuspendedAt })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      return row?.suspendedAt != null;
    } catch {
      return false;
    }
  }
}

export async function suspendWorkspaceDeliveries(workspaceId: string, reason: string): Promise<void> {
  const first = await redis.set(RedisKeys.workspaceSuspended(workspaceId), "1", "NX");
  await db
    .update(workspaces)
    .set({ deliverySuspendedAt: new Date(), deliverySuspendedReason: reason })
    .where(eq(workspaces.id, workspaceId));
  if (first !== "OK") return;

  logger.warn({ workspaceId, reason }, "Workspace deliveries suspended (abuse profile)");
  try {
    const { createAndSendNotification } = await import("../notifications/notification-service.ts");
    await createAndSendNotification(
      {
        workspaceId,
        type: "security_alert",
        priority: "critical",
        title: "Deliveries paused for review",
        message:
          "This workspace's delivery pattern tripped our abuse protection. Deliveries are deferred (nothing is lost) while we review. If this is a mistake, contact support and we'll lift it quickly.",
        metadata: { reason },
      },
      { forceDelivery: true },
    );
  } catch (error) {
    logger.warn({ workspaceId, error }, "Failed to send suspension alert");
  }
}

export async function resumeWorkspaceDeliveries(workspaceId: string): Promise<void> {
  await db
    .update(workspaces)
    .set({ deliverySuspendedAt: null, deliverySuspendedReason: null })
    .where(eq(workspaces.id, workspaceId));
  await redis.del(RedisKeys.workspaceSuspended(workspaceId));
  logger.info({ workspaceId }, "Workspace deliveries resumed");
}

export async function syncSuspendedWorkspaces(): Promise<number> {
  const suspended = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(isNotNull(workspaces.deliverySuspendedAt));
  if (suspended.length === 0) return 0;
  const pipeline = redis.pipeline();
  for (const ws of suspended) pipeline.set(RedisKeys.workspaceSuspended(ws.id), "1");
  await pipeline.exec();
  logger.info({ count: suspended.length }, "Re-synced workspace suspension flags");
  return suspended.length;
}
