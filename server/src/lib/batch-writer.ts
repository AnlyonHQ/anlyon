import { db } from "../db/index.ts";
import { messages } from "../db/schema/messages.ts";
import { eq } from "drizzle-orm";
import { createLogger } from "./logger.ts";

const logger = createLogger({ module: "batch-writer" });

interface MessageUpdate {
  messageId: string;
  updates: {
    status?: "pending" | "processing" | "delivered" | "failed" | "cancelled";
    attempts?: number;
    responseStatus?: number;
    responseBody?: string;
    errorMessage?: string;
    deliveredAt?: Date;
    failedAt?: Date;
  };
}

export class BatchWriter {
  private buffer: MessageUpdate[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;

  constructor(
    private maxBatchSize: number = 100,
    private flushIntervalMs: number = 100
  ) {}

  async queueUpdate(update: MessageUpdate): Promise<void> {
    this.buffer.push(update);

    if (this.buffer.length >= this.maxBatchSize) {
      await this.flush();
      return;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush().catch((error) => {
          logger.error({ error }, "Batch flush failed");
        });
      }, this.flushIntervalMs);
    }
  }

  async flush(): Promise<void> {
    if (this.flushPromise) {
      await this.flushPromise;
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const updates = this.buffer;
    this.buffer = [];

    if (updates.length === 0) {
      return;
    }

    this.flushPromise = this.executeFlush(updates);
    await this.flushPromise;
    this.flushPromise = null;
  }

  private async executeFlush(updates: MessageUpdate[]): Promise<void> {
    const startTime = Date.now();

    const CONCURRENCY = 10;
    const errors: Array<{ messageId: string; error: Error }> = [];

    for (let i = 0; i < updates.length; i += CONCURRENCY) {
      const batch = updates.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (update) => {
          try {
            await db
              .update(messages)
              .set(update.updates)
              .where(eq(messages.messageId, update.messageId));
          } catch (error) {
            throw { messageId: update.messageId, error };
          }
        })
      );

      for (const result of results) {
        if (result.status === "rejected") {
          errors.push(result.reason);
        }
      }
    }

    const duration = Date.now() - startTime;
    logger.debug(
      {
        count: updates.length,
        errors: errors.length,
        durationMs: duration,
      },
      "Batch flush completed"
    );

    if (errors.length > 0) {
      logger.error({ errors: errors.slice(0, 5) }, "Some batch updates failed");
    }
  }

  async waitForPending(): Promise<void> {
    await this.flush();
  }

  getPendingCount(): number {
    return this.buffer.length;
  }
}

export const messageBatchWriter = new BatchWriter();

export async function queueMessageUpdate(
  messageId: string,
  updates: MessageUpdate["updates"]
): Promise<void> {
  await messageBatchWriter.queueUpdate({ messageId, updates });
}

export async function flushMessageUpdates(): Promise<void> {
  await messageBatchWriter.flush();
}
