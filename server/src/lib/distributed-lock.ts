import { redis, RedisKeys } from "./redis.ts";
import { createLogger } from "./logger.ts";

const logger = createLogger({ module: "distributed-lock" });

export class DistributedLock {
  private lockKey: string;
  private lockId: string;
  private ttlMs: number;
  private renewInterval: NodeJS.Timeout | null = null;

  constructor(name: string, ttlMs: number = 30000, lockKey?: string) {
    this.lockKey = lockKey ?? RedisKeys.workerLock(name);
    this.lockId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.ttlMs = ttlMs;
  }

  async acquire(): Promise<boolean> {
    const result = await redis.set(this.lockKey, this.lockId, "PX", this.ttlMs, "NX");

    if (result === "OK") {
      logger.info({ lockKey: this.lockKey, lockId: this.lockId }, "Lock acquired");
      this.startRenewal();
      return true;
    }

    return false;
  }

  async release(): Promise<boolean> {
    this.stopRenewal();

    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    const result = await redis.eval(script, 1, this.lockKey, this.lockId);

    if (result === 1) {
      logger.info({ lockKey: this.lockKey }, "Lock released");
      return true;
    }

    logger.warn({ lockKey: this.lockKey }, "Lock not owned, cannot release");
    return false;
  }

  async extend(additionalMs?: number): Promise<boolean> {
    const newTtl = additionalMs || this.ttlMs;

    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    const result = await redis.eval(script, 1, this.lockKey, this.lockId, newTtl);

    return result === 1;
  }

  async isHeld(): Promise<boolean> {
    const value = await redis.get(this.lockKey);
    return value === this.lockId;
  }

  private startRenewal(): void {
    const renewIntervalMs = Math.floor(this.ttlMs / 3);

    this.renewInterval = setInterval(async () => {
      const extended = await this.extend();
      if (!extended) {
        logger.warn({ lockKey: this.lockKey }, "Failed to extend lock, may have lost ownership");
        this.stopRenewal();
      }
    }, renewIntervalMs);
  }

  private stopRenewal(): void {
    if (this.renewInterval) {
      clearInterval(this.renewInterval);
      this.renewInterval = null;
    }
  }
}

export async function withLock<T>(
  lockName: string,
  fn: () => Promise<T>,
  options: { ttlMs?: number; waitMs?: number; retryIntervalMs?: number } = {}
): Promise<T | null> {
  const { ttlMs = 30000, waitMs = 0, retryIntervalMs = 100 } = options;
  const lock = new DistributedLock(lockName, ttlMs);

  const startTime = Date.now();

  while (true) {
    if (await lock.acquire()) {
      try {
        return await fn();
      } finally {
        await lock.release();
      }
    }

    if (waitMs > 0 && Date.now() - startTime < waitMs) {
      await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
    } else {
      return null;
    }
  }
}

export class LeaderElection {
  private lock: DistributedLock;
  private isLeader = false;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(
    private name: string,
    private ttlMs: number = 30000,
    private onBecomeLeader?: () => void,
    private onLoseLeadership?: () => void
  ) {
    this.lock = new DistributedLock(`leader:${name}`, ttlMs);
  }

  async start(): Promise<void> {
    await this.tryBecomeLeader();

    const checkIntervalMs = Math.floor(this.ttlMs / 2);
    this.checkInterval = setInterval(() => this.tryBecomeLeader(), checkIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    if (this.isLeader) {
      await this.lock.release();
      this.isLeader = false;
      this.onLoseLeadership?.();
    }
  }

  isCurrentLeader(): boolean {
    return this.isLeader;
  }

  private async tryBecomeLeader(): Promise<void> {
    if (this.isLeader) {
      const stillLeader = await this.lock.extend();
      if (!stillLeader) {
        this.isLeader = false;
        logger.warn({ name: this.name }, "Lost leadership");
        this.onLoseLeadership?.();
      }
    } else {
      const acquired = await this.lock.acquire();
      if (acquired) {
        this.isLeader = true;
        logger.info({ name: this.name }, "Became leader");
        this.onBecomeLeader?.();
      }
    }
  }
}
