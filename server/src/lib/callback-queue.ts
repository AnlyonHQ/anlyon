import { redis, RedisKeys } from "./redis.ts";
import { createLogger } from "./logger.ts";
import { safeFetch, SsrfBlockedError } from "./safe-http.ts";
import { signDeliveryForWorkspace } from "../core/auth/delivery-secrets.ts";
import { urlValidationCache } from "./url-cache.ts";
import { isEnvironmentHalted } from "../core/environments/halt.ts";
import { MetricsCollector } from "./metrics.ts";

const logger = createLogger({ module: "callback-queue" });

export const callbackMetrics = new MetricsCollector("callback_queue");

const CALLBACK_QUEUE_KEY = "callback_queue:pending";
const CALLBACK_PROCESSING_KEY = "callback_queue:processing";

interface CallbackTask {
  id: string;
  workspaceId: string;
  environmentId?: string;
  url: string;
  data: CallbackData;
  attempt: number;
  addedAt: number;
  notBefore?: number;
}

interface CallbackData {
  messageId: string;
  status: string;
  responseStatus?: number;
  attempts?: number;
  errorMessage?: string;
  deliveredAt?: string;
  failedAt?: string;
}

const MAX_CALLBACK_ATTEMPTS = 3;
const HALT_DEFER_MS = 30_000;
const CALLBACK_TIMEOUT = 10000;
const MAX_QUEUE_SIZE = 10000;
const PERSIST_INTERVAL_MS = 500;

export class CallbackQueue {
  private queue: CallbackTask[] = [];
  private processing = false;
  private isRunning = false;
  private readonly concurrency: number;
  private inFlight = 0;
  private inFlightTasks: Map<string, CallbackTask> = new Map();
  private persistInterval: NodeJS.Timeout | null = null;
  private instanceId: string;

  constructor(concurrency: number = 5) {
    this.concurrency = concurrency;
    this.instanceId = `${process.pid}-${Date.now()}`;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    await this.recoverPendingCallbacks();

    callbackMetrics.start();

    this.persistInterval = setInterval(() => {
      this.persistQueue().catch((error) => {
        logger.error({ error }, "Error persisting callback queue");
      });
      if (this.queue.length > 0 && !this.processing) this.processQueue();
    }, PERSIST_INTERVAL_MS);

    this.processQueue();
  }

  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.persistInterval) {
      clearInterval(this.persistInterval);
      this.persistInterval = null;
    }

    const timeout = Date.now() + 30000;
    while (this.inFlight > 0 && Date.now() < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await this.persistQueue();

    await callbackMetrics.stop();
  }

  private async recoverPendingCallbacks(): Promise<void> {
    try {
      const pendingData = await redis.get(CALLBACK_QUEUE_KEY);
      if (pendingData) {
        const pendingTasks = JSON.parse(pendingData) as CallbackTask[];
        if (pendingTasks.length > 0) {
          this.queue.push(...pendingTasks);
          logger.info({ count: pendingTasks.length }, "Recovered pending callbacks from Redis");
          callbackMetrics.increment("callbacks_recovered", pendingTasks.length);
        }
        await redis.del(CALLBACK_QUEUE_KEY);
      }

      const processingData = await redis.get(CALLBACK_PROCESSING_KEY);
      if (processingData) {
        const processingTasks = JSON.parse(processingData) as CallbackTask[];
        if (processingTasks.length > 0) {
          this.queue.push(...processingTasks);
          logger.info({ count: processingTasks.length }, "Recovered in-flight callbacks from Redis");
          callbackMetrics.increment("callbacks_recovered_inflight", processingTasks.length);
        }
        await redis.del(CALLBACK_PROCESSING_KEY);
      }
    } catch (error) {
      logger.error({ error }, "Error recovering pending callbacks");
    }
  }

  private async persistQueue(): Promise<void> {
    try {
      if (this.queue.length > 0) {
        await redis.set(CALLBACK_QUEUE_KEY, JSON.stringify(this.queue), "EX", 300);
      } else {
        await redis.del(CALLBACK_QUEUE_KEY);
      }

      if (this.inFlightTasks.size > 0) {
        const inFlightArray = Array.from(this.inFlightTasks.values());
        await redis.set(CALLBACK_PROCESSING_KEY, JSON.stringify(inFlightArray), "EX", 300);
      } else {
        await redis.del(CALLBACK_PROCESSING_KEY);
      }
    } catch (error) {
      logger.error({ error }, "Error persisting callback queue");
    }
  }

  private generateTaskId(): string {
    return `${this.instanceId}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  enqueue(workspaceId: string, url: string, data: CallbackData, environmentId?: string): void {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      logger.warn({ url }, "Callback queue full, dropping callback");
      callbackMetrics.increment("callbacks_dropped");
      return;
    }

    const task: CallbackTask = {
      id: this.generateTaskId(),
      workspaceId,
      environmentId,
      url,
      data,
      attempt: 1,
      addedAt: Date.now(),
    };

    this.queue.push(task);
    callbackMetrics.increment("callbacks_enqueued");
    callbackMetrics.setGauge("queue_size", this.queue.length);

    if (!this.processing && this.isRunning) {
      this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing || !this.isRunning) return;
    this.processing = true;

    try {
      while (this.queue.length > 0 && this.isRunning) {
        while (this.inFlight >= this.concurrency && this.isRunning) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          callbackMetrics.increment("capacity_waits");
        }

        const index = this.queue.findIndex((queued) => !this.isDeferred(queued));
        if (index === -1) break;
        const [task] = this.queue.splice(index, 1);
        if (!task) continue;

        this.inFlightTasks.set(task.id, task);
        this.inFlight++;
        callbackMetrics.setGauge("in_flight", this.inFlight);
        callbackMetrics.setGauge("queue_size", this.queue.length);

        this.executeCallback(task).finally(() => {
          this.inFlightTasks.delete(task.id);
          this.inFlight--;
          callbackMetrics.setGauge("in_flight", this.inFlight);

          if (this.queue.length > 0 && !this.processing && this.isRunning) {
            this.processQueue();
          }
        });
      }
    } finally {
      this.processing = false;
    }
  }

  private isDeferred(task: CallbackTask): boolean {
    return task.notBefore !== undefined && task.notBefore > Date.now();
  }

  private deferForHalt(task: CallbackTask): void {
    this.queue.push({ ...task, notBefore: Date.now() + HALT_DEFER_MS });
    callbackMetrics.increment("callbacks_deferred_halt");
    callbackMetrics.setGauge("queue_size", this.queue.length);
  }

  private async executeCallback(task: CallbackTask): Promise<void> {
    const { workspaceId, url, data, attempt } = task;

    try {
      if (task.environmentId && (await isEnvironmentHalted(task.environmentId))) {
        logger.info(
          { url, messageId: data.messageId, environmentId: task.environmentId },
          "Callback deferred: environment halted",
        );
        this.deferForHalt(task);
        return;
      }

      const cachedNeg = urlValidationCache.get(url);
      if (cachedNeg && !cachedNeg.valid) {
        logger.warn({ url, error: cachedNeg.error }, "Invalid callback URL, skipping");
        callbackMetrics.increment("callbacks_invalid_url");
        return;
      }

      const bodyString = JSON.stringify(data);
      const signResult = await signDeliveryForWorkspace(workspaceId, bodyString, task.environmentId);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Callback-Attempt": attempt.toString(),
        "X-Idempotency-Key": `${data.messageId}:${data.status}`,
      };

      if (signResult) {
        headers["Anlyon-Signature"] = signResult.signature;
        headers["Anlyon-Timestamp"] = signResult.timestamp.toString();
        headers["X-Anlyon-Workspace-Id"] = workspaceId;
        if (task.environmentId) headers["X-Anlyon-Environment-Id"] = task.environmentId;
      }

      let response: Response;
      try {
        response = await safeFetch(url, {
          method: "POST",
          headers,
          body: bodyString,
          signal: AbortSignal.timeout(CALLBACK_TIMEOUT),
        });
      } catch (err) {
        if (err instanceof SsrfBlockedError) {
          urlValidationCache.set(url, false, err.message);
          logger.warn({ url, error: err.message }, "Invalid callback URL, skipping");
          callbackMetrics.increment("callbacks_invalid_url");
          return;
        }
        throw err;
      }

      if (response.ok) {
        callbackMetrics.increment("callbacks_success");
      } else if (attempt < MAX_CALLBACK_ATTEMPTS) {
        callbackMetrics.increment("callbacks_retry");
        await this.scheduleRetry(task);
      } else {
        logger.warn(
          { url, messageId: data.messageId, attempts: attempt, status: response.status },
          "Callback failed after max attempts"
        );
        callbackMetrics.increment("callbacks_failed");
        await this.recordFailedCallback(workspaceId, url, data, response.status);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      if (attempt < MAX_CALLBACK_ATTEMPTS) {
        callbackMetrics.increment("callbacks_retry");
        await this.scheduleRetry(task);
      } else {
        logger.error(
          { url, messageId: data.messageId, error: errorMessage },
          "Callback execution failed after max attempts"
        );
        callbackMetrics.increment("callbacks_failed");
        await this.recordFailedCallback(workspaceId, url, data, undefined, errorMessage);
      }
    }
  }

  private async scheduleRetry(task: CallbackTask): Promise<void> {
    const delay = Math.pow(2, task.attempt) * 1000;

    await new Promise((resolve) => setTimeout(resolve, delay));

    const retryTask: CallbackTask = {
      ...task,
      id: this.generateTaskId(),
      attempt: task.attempt + 1,
    };

    this.queue.push(retryTask);
    callbackMetrics.setGauge("queue_size", this.queue.length);

    if (!this.processing && this.isRunning) {
      this.processQueue();
    }
  }

  private async recordFailedCallback(
    workspaceId: string,
    url: string,
    data: CallbackData,
    status?: number,
    error?: string
  ): Promise<void> {
    try {
      const key = `workspace:${workspaceId}:failed_callbacks`;
      const value = JSON.stringify({
        url,
        messageId: data.messageId,
        status,
        error,
        failedAt: new Date().toISOString(),
      });

      await redis.lpush(key, value);
      await redis.ltrim(key, 0, 99);
      await redis.expire(key, 86400);
    } catch (e) {
      logger.error({ error: e }, "Failed to record callback failure");
    }
  }

  getStats(): { queued: number; inFlight: number; metrics?: ReturnType<typeof callbackMetrics.getAll> } {
    return {
      queued: this.queue.length,
      inFlight: this.inFlight,
      metrics: callbackMetrics.getAll(),
    };
  }
}

export const callbackQueue = new CallbackQueue();
