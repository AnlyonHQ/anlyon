import { redis, RedisKeys } from "./redis.ts";
import { createLogger } from "./logger.ts";

const logger = createLogger({ module: "worker-health" });

const HEARTBEAT_INTERVAL = 5000;
const HEARTBEAT_TTL = 15;

interface WorkerInfo {
  workerId: string;
  workerType: string;
  startedAt: string;
  lastHeartbeat: string;
  messagesProcessed: number;
  errors: number;
  isLeader?: boolean;
}

export class WorkerHealth {
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private messagesProcessed = 0;
  private errors = 0;
  private startedAt: Date;

  constructor(
    private workerType: string,
    private workerId: string
  ) {
    this.startedAt = new Date();
  }

  async start(): Promise<void> {
    await this.sendHeartbeat();

    await redis.sadd(RedisKeys.activeWorkers(this.workerType), this.workerId);

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch((error) => {
        logger.error({ error }, "Failed to send heartbeat");
      });
    }, HEARTBEAT_INTERVAL);

    logger.info(
      { workerType: this.workerType, workerId: this.workerId },
      "Worker health monitoring started"
    );
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    await redis.srem(RedisKeys.activeWorkers(this.workerType), this.workerId);

    await redis.del(RedisKeys.workerHeartbeat(this.workerType, this.workerId));

    logger.info(
      { workerType: this.workerType, workerId: this.workerId },
      "Worker health monitoring stopped"
    );
  }

  recordProcessed(): void {
    this.messagesProcessed++;
  }

  recordError(): void {
    this.errors++;
  }

  private async sendHeartbeat(isLeader?: boolean): Promise<void> {
    const info: WorkerInfo = {
      workerId: this.workerId,
      workerType: this.workerType,
      startedAt: this.startedAt.toISOString(),
      lastHeartbeat: new Date().toISOString(),
      messagesProcessed: this.messagesProcessed,
      errors: this.errors,
      isLeader,
    };

    await redis.set(
      RedisKeys.workerHeartbeat(this.workerType, this.workerId),
      JSON.stringify(info),
      "EX",
      HEARTBEAT_TTL
    );
  }

  async setLeaderStatus(isLeader: boolean): Promise<void> {
    await this.sendHeartbeat(isLeader);
  }
}

export async function getWorkerHealth(
  workerType: string
): Promise<WorkerInfo[]> {
  const workerIds = await redis.smembers(RedisKeys.activeWorkers(workerType));
  const workers: WorkerInfo[] = [];

  for (const workerId of workerIds) {
    const data = await redis.get(
      RedisKeys.workerHeartbeat(workerType, workerId)
    );

    if (data) {
      workers.push(JSON.parse(data));
    } else {
      await redis.srem(RedisKeys.activeWorkers(workerType), workerId);
    }
  }

  return workers;
}

export async function getSystemHealth(): Promise<{
  healthy: boolean;
  workers: Record<string, WorkerInfo[]>;
  issues: string[];
}> {
  const workerTypes = ["consumer", "scheduler", "retry"];
  const workers: Record<string, WorkerInfo[]> = {};
  const issues: string[] = [];

  for (const type of workerTypes) {
    workers[type] = await getWorkerHealth(type);
  }

  if (workers.consumer.length === 0) {
    issues.push("No consumer workers running");
  }

  if (workers.scheduler.length === 0) {
    issues.push("No scheduler worker running");
  }

  if (workers.retry.length === 0) {
    issues.push("No retry worker running");
  }

  const now = Date.now();
  for (const [type, workerList] of Object.entries(workers)) {
    for (const worker of workerList) {
      const lastHeartbeat = new Date(worker.lastHeartbeat).getTime();
      if (now - lastHeartbeat > HEARTBEAT_TTL * 1000) {
        issues.push(`Worker ${type}:${worker.workerId} has stale heartbeat`);
      }
    }
  }

  return {
    healthy: issues.length === 0,
    workers,
    issues,
  };
}

export async function cleanupStaleWorkers(): Promise<number> {
  const workerTypes = ["consumer", "scheduler", "retry"];
  let cleaned = 0;

  for (const type of workerTypes) {
    const workerIds = await redis.smembers(RedisKeys.activeWorkers(type));

    for (const workerId of workerIds) {
      const exists = await redis.exists(
        RedisKeys.workerHeartbeat(type, workerId)
      );

      if (!exists) {
        await redis.srem(RedisKeys.activeWorkers(type), workerId);
        cleaned++;
        logger.info({ workerType: type, workerId }, "Cleaned up stale worker");
      }
    }
  }

  return cleaned;
}
