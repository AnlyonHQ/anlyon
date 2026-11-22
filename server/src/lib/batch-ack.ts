import { redis } from "./redis.ts";
import { createLogger } from "./logger.ts";
import { MetricsCollector } from "./metrics.ts";

const logger = createLogger({ module: "batch-ack" });

export const batchAckMetrics = new MetricsCollector("batch_ack");

const PENDING_ACKS_KEY = "batch_ack:pending";

interface PendingAck {
  streamKey: string;
  consumerGroup: string;
  messageId: string;
  addedAt: number;
  retryCount: number;
}

export class BatchAckCollector {
  private pending: Map<string, PendingAck[]> = new Map();
  private flushInterval: NodeJS.Timeout | null = null;
  private persistInterval: NodeJS.Timeout | null = null;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxAge: number;
  private readonly maxRetries: number;
  private readonly instanceId: string;

  constructor(
    batchSize: number = 50,
    flushIntervalMs: number = 100,
    maxAge: number = 1000,
    maxRetries: number = 5
  ) {
    this.batchSize = batchSize;
    this.flushIntervalMs = flushIntervalMs;
    this.maxAge = maxAge;
    this.maxRetries = maxRetries;
    this.instanceId = `${process.pid}-${Date.now()}`;
  }

  async start(): Promise<void> {
    if (this.flushInterval) return;

    await this.recoverPendingAcks();

    batchAckMetrics.start();

    this.flushInterval = setInterval(() => {
      this.flushAll().catch((error) => {
        logger.error({ error }, "Error flushing batch acks");
        batchAckMetrics.increment("flush_errors");
      });
    }, this.flushIntervalMs);

    this.persistInterval = setInterval(() => {
      this.persistPendingAcks().catch((error) => {
        logger.error({ error }, "Error persisting pending acks");
      });
    }, 500);
  }

  async stop(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    if (this.persistInterval) {
      clearInterval(this.persistInterval);
      this.persistInterval = null;
    }

    await this.flushAll();

    await this.persistPendingAcks();

    await batchAckMetrics.stop();
  }

  private async recoverPendingAcks(): Promise<void> {
    try {
      const pendingData = await redis.get(PENDING_ACKS_KEY);
      if (!pendingData) return;

      const allPending = JSON.parse(pendingData) as Record<string, PendingAck[]>;
      let recoveredCount = 0;

      for (const [key, acks] of Object.entries(allPending)) {
        if (acks.length > 0) {
          this.pending.set(key, acks);
          recoveredCount += acks.length;
        }
      }

      if (recoveredCount > 0) {
        logger.info({ recoveredCount }, "Recovered pending acks from Redis");
        batchAckMetrics.increment("acks_recovered", recoveredCount);
      }

      await redis.del(PENDING_ACKS_KEY);
    } catch (error) {
      logger.error({ error }, "Error recovering pending acks");
    }
  }

  private async persistPendingAcks(): Promise<void> {
    if (this.pending.size === 0) {
      await redis.del(PENDING_ACKS_KEY);
      return;
    }

    const pendingData: Record<string, PendingAck[]> = {};
    for (const [key, acks] of this.pending) {
      if (acks.length > 0) {
        pendingData[key] = acks;
      }
    }

    if (Object.keys(pendingData).length === 0) {
      await redis.del(PENDING_ACKS_KEY);
      return;
    }

    await redis.set(PENDING_ACKS_KEY, JSON.stringify(pendingData), "EX", 300);
  }

  async add(
    streamKey: string,
    consumerGroup: string,
    messageId: string
  ): Promise<void> {
    const key = `${streamKey}:${consumerGroup}`;
    let acks = this.pending.get(key);

    if (!acks) {
      acks = [];
      this.pending.set(key, acks);
    }

    acks.push({
      streamKey,
      consumerGroup,
      messageId,
      addedAt: Date.now(),
      retryCount: 0,
    });

    batchAckMetrics.increment("acks_added");

    if (acks.length >= this.batchSize) {
      await this.flushKey(key);
    }
  }

  async flushAll(): Promise<void> {
    const now = Date.now();
    const keysToFlush: string[] = [];

    for (const [key, acks] of this.pending) {
      if (acks.length > 0) {
        const oldestAck = acks[0];
        if (acks.length >= this.batchSize || now - oldestAck.addedAt >= this.maxAge) {
          keysToFlush.push(key);
        }
      }
    }

    await Promise.all(keysToFlush.map((key) => this.flushKey(key)));
  }

  private async flushKey(key: string): Promise<void> {
    const acks = this.pending.get(key);
    if (!acks || acks.length === 0) return;

    const acksToFlush = [...acks];
    const streamKey = acksToFlush[0].streamKey;
    const consumerGroup = acksToFlush[0].consumerGroup;
    const messageIds = acksToFlush.map((a) => a.messageId);

    const remainingAcks = acks.filter(
      (ack) => !messageIds.includes(ack.messageId)
    );
    this.pending.set(key, remainingAcks);

    try {
      await redis.xack(streamKey, consumerGroup, ...messageIds);
      logger.debug({ streamKey, count: messageIds.length }, "Batch ack flushed");
      batchAckMetrics.increment("acks_flushed", messageIds.length);
    } catch (error) {
      logger.error({ error, streamKey, count: messageIds.length }, "Batch ack failed");
      batchAckMetrics.increment("flush_failures");

      const retryAcks: PendingAck[] = [];
      const failedAcks: PendingAck[] = [];

      for (const ack of acksToFlush) {
        if (ack.retryCount < this.maxRetries) {
          retryAcks.push({
            ...ack,
            retryCount: ack.retryCount + 1,
          });
        } else {
          failedAcks.push(ack);
        }
      }

      if (failedAcks.length > 0) {
        logger.error(
          { streamKey, count: failedAcks.length, messageIds: failedAcks.map((a) => a.messageId) },
          "Acks exceeded max retries, will be recovered by recovery worker"
        );
        batchAckMetrics.increment("acks_failed_permanent", failedAcks.length);
      }

      if (retryAcks.length > 0) {
        const currentAcks = this.pending.get(key) || [];
        this.pending.set(key, [...retryAcks, ...currentAcks]);
        batchAckMetrics.increment("acks_retried", retryAcks.length);

        const maxRetryCount = Math.max(...retryAcks.map((a) => a.retryCount));
        const backoffMs = Math.min(1000 * Math.pow(2, maxRetryCount), 30000);

        setTimeout(() => {
          this.flushKey(key).catch((e) => {
            logger.error({ error: e, key }, "Retry flush failed");
          });
        }, backoffMs);
      }
    }
  }

  getPendingCount(): number {
    let count = 0;
    for (const acks of this.pending.values()) {
      count += acks.length;
    }
    return count;
  }

  getStats(): { pending: number; metrics: ReturnType<typeof batchAckMetrics.getAll> } {
    return {
      pending: this.getPendingCount(),
      metrics: batchAckMetrics.getAll(),
    };
  }
}

export const batchAckCollector = new BatchAckCollector();
