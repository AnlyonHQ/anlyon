import { Redis } from "ioredis";
import { redis, RedisKeys } from "./redis.ts";
import { createLogger } from "./logger.ts";

const logger = createLogger({ module: "workspace-index-cache" });

const CHANNELS = {
  PENDING: "workspace:index:pending:changed",
  SCHEDULED: "workspace:index:scheduled:changed",
  PROCESSING: "workspace:index:processing:changed",
} as const;

type IndexType = "pending" | "scheduled" | "processing";

export class WorkspaceIndexCache {
  private cache: Map<IndexType, Set<string>> = new Map();
  private lastFetch: Map<IndexType, number> = new Map();
  private subscriber: Redis | null = null;
  private isSubscribed = false;
  private readonly cacheMaxAge = 30000;

  constructor() {
    this.cache.set("pending", new Set());
    this.cache.set("scheduled", new Set());
    this.cache.set("processing", new Set());
  }

  async start(): Promise<void> {
    if (this.isSubscribed) return;

    const redisUrl = process.env.REDIS_URL;
    this.subscriber = new Redis(redisUrl as string, {
      maxRetriesPerRequest: null,
    });

    await this.subscriber.subscribe(
      CHANNELS.PENDING,
      CHANNELS.SCHEDULED,
      CHANNELS.PROCESSING
    );

    this.subscriber.on("message", (channel: string, message: string) => {
      this.handleMessage(channel, message);
    });

    this.isSubscribed = true;
    logger.info("Workspace index cache started with pub/sub");
  }

  async stop(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.unsubscribe();
      await this.subscriber.quit();
      this.subscriber = null;
    }
    this.isSubscribed = false;
    this.cache.clear();
    this.lastFetch.clear();
    logger.info("Workspace index cache stopped");
  }

  private handleMessage(channel: string, message: string): void {
    try {
      const data = JSON.parse(message) as { action: "add" | "remove"; workspaceId: string };
      let indexType: IndexType | null = null;

      switch (channel) {
        case CHANNELS.PENDING:
          indexType = "pending";
          break;
        case CHANNELS.SCHEDULED:
          indexType = "scheduled";
          break;
        case CHANNELS.PROCESSING:
          indexType = "processing";
          break;
      }

      if (!indexType) return;

      const cache = this.cache.get(indexType);
      if (!cache) return;

      if (data.action === "add") {
        cache.add(data.workspaceId);
      } else if (data.action === "remove") {
        cache.delete(data.workspaceId);
      }

      logger.debug({ indexType, action: data.action, workspaceId: data.workspaceId }, "Cache updated via pub/sub");
    } catch (error) {
      logger.error({ error, channel, message }, "Failed to handle pub/sub message");
    }
  }

  async getWorkspaceIds(indexType: IndexType): Promise<string[]> {
    const cache = this.cache.get(indexType);
    const lastFetch = this.lastFetch.get(indexType) || 0;
    const now = Date.now();

    if (cache && cache.size > 0 && now - lastFetch < this.cacheMaxAge) {
      return Array.from(cache);
    }

    const key = this.getRedisKey(indexType);
    const workspaceIds = await redis.smembers(key);

    this.cache.set(indexType, new Set(workspaceIds));
    this.lastFetch.set(indexType, now);

    return workspaceIds;
  }

  async hasWorkspaces(indexType: IndexType): Promise<boolean> {
    const cache = this.cache.get(indexType);
    const lastFetch = this.lastFetch.get(indexType) || 0;
    const now = Date.now();

    if (now - lastFetch < this.cacheMaxAge) {
      return cache ? cache.size > 0 : false;
    }

    const key = this.getRedisKey(indexType);
    const count = await redis.scard(key);
    return count > 0;
  }

  async refresh(indexType: IndexType): Promise<string[]> {
    this.lastFetch.delete(indexType);
    return this.getWorkspaceIds(indexType);
  }

  private getRedisKey(indexType: IndexType): string {
    switch (indexType) {
      case "pending":
        return RedisKeys.activeWorkspacesPending();
      case "scheduled":
        return RedisKeys.activeWorkspacesScheduled();
      case "processing":
        return RedisKeys.activeWorkspacesProcessing();
    }
  }
}

export async function notifyWorkspaceIndexChange(
  indexType: IndexType,
  action: "add" | "remove",
  workspaceId: string
): Promise<void> {
  const channel = {
    pending: CHANNELS.PENDING,
    scheduled: CHANNELS.SCHEDULED,
    processing: CHANNELS.PROCESSING,
  }[indexType];

  await redis.publish(channel, JSON.stringify({ action, workspaceId }));
}

export async function addToWorkspaceIndex(
  indexType: IndexType,
  workspaceId: string
): Promise<void> {
  const key = {
    pending: RedisKeys.activeWorkspacesPending(),
    scheduled: RedisKeys.activeWorkspacesScheduled(),
    processing: RedisKeys.activeWorkspacesProcessing(),
  }[indexType];

  const added = await redis.sadd(key, workspaceId);
  if (added > 0) {
    await notifyWorkspaceIndexChange(indexType, "add", workspaceId);
  }
}

export async function removeFromWorkspaceIndex(
  indexType: IndexType,
  workspaceId: string
): Promise<void> {
  const key = {
    pending: RedisKeys.activeWorkspacesPending(),
    scheduled: RedisKeys.activeWorkspacesScheduled(),
    processing: RedisKeys.activeWorkspacesProcessing(),
  }[indexType];

  const removed = await redis.srem(key, workspaceId);
  if (removed > 0) {
    await notifyWorkspaceIndexChange(indexType, "remove", workspaceId);
  }
}

export const workspaceIndexCache = new WorkspaceIndexCache();
