import { db } from "../../db/index.ts";
import { queues } from "../../db/schema/queues.ts";
import { and, eq, sql } from "drizzle-orm";
import { redis } from "../../lib/redis.ts";

const QUEUE_CACHE_TTL = 300;

export interface QueueLookup {
  id: string;
  queueId: string;
  isPaused: boolean;
  parallelism: number;
}

export async function getQueueCached(
  workspaceId: string,
  name: string,
  environmentId: string
): Promise<QueueLookup | null> {
  const cacheKey = `cache:queue:${workspaceId}:${environmentId}:${name}`;
  const cached = await redis.get(cacheKey);

  if (cached) {
    return JSON.parse(cached);
  }

  const [queue] = await db
    .select({
      id: queues.id,
      queueId: queues.queueId,
      isPaused: queues.isPaused,
      parallelism: queues.parallelism,
    })
    .from(queues)
    .where(
      and(
        eq(queues.workspaceId, workspaceId),
        eq(queues.environmentId, environmentId),
        eq(queues.name, name),
        sql`${queues.status} != 'deleted'`
      )
    );

  if (!queue) {
    return null;
  }

  const data: QueueLookup = {
    id: queue.id,
    queueId: queue.queueId,
    isPaused: queue.isPaused,
    parallelism: queue.parallelism,
  };

  await redis.set(cacheKey, JSON.stringify(data), "EX", QUEUE_CACHE_TTL);

  return data;
}
