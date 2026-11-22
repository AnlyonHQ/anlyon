import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { events, eventSubscriptions, eventTopics } from "../db/schema/events.ts";
import { messages } from "../db/schema/messages.ts";
import { redis, RedisKeys, createBlockingConnection } from "../lib/redis.ts";
import { createLogger } from "../lib/logger.ts";
import { env } from "../config/env.ts";
import { WorkerHealth } from "../lib/worker-health.ts";
import { captureException } from "../lib/sentry.ts";
import { matchEventType } from "../core/events/filters.ts";
import { ensureSystemQueue, SYSTEM_QUEUE_NAME } from "../core/events/service.ts";
import { publishMessage } from "../core/messaging/publisher.ts";
import { getRunWithTree, ingestSpans } from "../core/runs/service.ts";
import { ConflictError } from "../utils/errors.ts";
import { hasActiveConsent } from "../core/auth/oauth-tokens.ts";
import { MCP_SUBSCRIPTION_HEADER, mcpEventData } from "../core/mcp-events/catalog.ts";

const MCP_MAX_PAYLOAD_BYTES = 256 * 1024;

type SubscriptionRow = typeof eventSubscriptions.$inferSelect;
type EventRow = typeof events.$inferSelect;

async function mcpSubscriptionLive(sub: SubscriptionRow, event: EventRow, now: Date): Promise<boolean> {
  const data = (event.data as Record<string, unknown>) ?? {};
  const eventEnvironment = typeof data.environmentId === "string" ? data.environmentId : event.environmentId;
  if (eventEnvironment !== sub.mcpEnvironmentId) return false;
  if (!sub.expiresAt || sub.expiresAt <= now || !sub.mcpPrincipal) return false;
  const separator = sub.mcpPrincipal.lastIndexOf(":");
  return hasActiveConsent(sub.mcpPrincipal.slice(0, separator), sub.mcpPrincipal.slice(separator + 1));
}

const logger = createLogger({ module: "events-worker" });

const CONSUMER_GROUP = "events-fanout";
const BLOCK_TIME_MS = 5000;
const CLAIM_MIN_IDLE_MS = 5 * 60 * 1000;
const WORKER_COUNT = 2;

const MAX_FANOUT_ATTEMPTS = 5;
const FANOUT_ATTEMPTS_TTL_SECONDS = 7 * 24 * 60 * 60;

class PartialFanoutError extends Error {
  constructor(readonly eventId: string, readonly delivered: number, readonly expected: number) {
    super(`Event fan-out reached ${delivered} of ${expected} subscriptions`);
    this.name = "PartialFanoutError";
  }
}

export class EventsFanoutWorker {
  private isRunning = false;
  private consumerId: string;
  private health: WorkerHealth;
  private blocking: ReturnType<typeof createBlockingConnection>;

  constructor(id: number) {
    this.consumerId = `events-fanout-${id}`;
    this.health = new WorkerHealth("events", this.consumerId);
    this.blocking = createBlockingConnection(this.consumerId);
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    await this.health.start();
    await this.ensureConsumerGroup();

    logger.info({ consumerId: this.consumerId }, "Events fan-out worker started");

    this.loop().catch((error) => {
      logger.error({ error, consumerId: this.consumerId }, "Events worker loop crashed");
      captureException(error, { worker: "events", consumerId: this.consumerId });
    });
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    await this.health.stop();
    await this.blocking.quit().catch(() => {});
    logger.info({ consumerId: this.consumerId }, "Events fan-out worker stopped");
  }

  private async ensureConsumerGroup(): Promise<void> {
    try {
      await redis.xgroup(
        "CREATE",
        RedisKeys.eventsIngestStream(),
        CONSUMER_GROUP,
        "0",
        "MKSTREAM"
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("BUSYGROUP")) {
        throw error;
      }
    }
  }

  private async loop(): Promise<void> {
    while (this.isRunning) {
      try {
        const claimed = await this.claimStale();
        if (claimed) continue;

        const result = (await this.blocking.xreadgroup(
          "GROUP",
          CONSUMER_GROUP,
          this.consumerId,
          "COUNT",
          1,
          "BLOCK",
          BLOCK_TIME_MS,
          "STREAMS",
          RedisKeys.eventsIngestStream(),
          ">"
        )) as [string, [string, string[]][]][] | null;

        if (!result) continue;

        for (const [, entries] of result) {
          for (const [streamId, fields] of entries) {
            await this.handleEntry(streamId, fields);
          }
        }
      } catch (error) {
        logger.error({ error, consumerId: this.consumerId }, "Error in events worker loop");
        this.health.recordError();
        captureException(error, { worker: "events", consumerId: this.consumerId });
        await this.sleep(1000);
      }
    }
  }

  private async claimStale(): Promise<boolean> {
    try {
      const res = (await redis.xautoclaim(
        RedisKeys.eventsIngestStream(),
        CONSUMER_GROUP,
        this.consumerId,
        CLAIM_MIN_IDLE_MS,
        "0",
        "COUNT",
        1
      )) as [string, [string, string[]][], string[]] | null;

      const entries = res?.[1] ?? [];
      if (entries.length === 0) return false;

      for (const [streamId, fields] of entries) {
        await this.handleEntry(streamId, fields);
      }
      return true;
    } catch (error) {
      logger.warn({ error }, "xautoclaim failed");
      return false;
    }
  }

  private async handleEntry(streamId: string, fields: string[]): Promise<void> {
    const getField = (name: string) => {
      const idx = fields.indexOf(name);
      return idx >= 0 ? fields[idx + 1] : undefined;
    };
    const eventInternalId = getField("eventId");
    const workspaceId = getField("workspaceId");

    if (!eventInternalId || !workspaceId) {
      logger.error({ streamId, fields }, "Malformed event entry, acking");
      await this.ack(streamId);
      return;
    }

    try {
      await this.fanOut(eventInternalId, workspaceId);
      await this.ack(streamId);
      this.health.recordProcessed();
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : error, eventInternalId },
        "Event fan-out failed, will retry via claim"
      );
      this.health.recordError();
    }
  }

  private async fanOut(eventInternalId: string, workspaceId: string): Promise<void> {
    logger.debug({ eventInternalId, workspaceId }, "Fan-out started");
    const [row] = await db
      .select({ event: events, topicName: eventTopics.name })
      .from(events)
      .innerJoin(eventTopics, eq(events.topicId, eventTopics.id))
      .where(eq(events.id, eventInternalId));
    logger.debug({ eventInternalId, found: !!row }, "Fan-out event loaded");

    if (!row) {
      logger.warn({ eventInternalId }, "Event row not found, skipping fan-out");
      return;
    }
    const { event, topicName } = row;

    if (event.status !== "received") return;

    const subs = await db
      .select()
      .from(eventSubscriptions)
      .where(
        and(
          eq(eventSubscriptions.topicId, event.topicId),
          eq(eventSubscriptions.environmentId, event.environmentId),
          eq(eventSubscriptions.enabled, true)
        )
      );

    const now = new Date();
    const typeMatched = subs.filter((sub) => matchEventType(sub.eventTypes, event.type));
    const live = await Promise.all(
      typeMatched.map((sub) => (sub.deliveryFormat === "mcp" ? mcpSubscriptionLive(sub, event, now) : true)),
    );
    const matching = typeMatched.filter((_, index) => live[index]);
    logger.debug(
      { eventInternalId, subs: subs.length, matching: matching.length },
      "Fan-out subscriptions matched"
    );

    if (matching.length === 0) {
      await db
        .update(events)
        .set({ status: "no_subscribers", subscriptionCount: 0 })
        .where(eq(events.id, event.id));
      await this.recordTraceSpan(event, topicName, 0, "no_subscribers");
      return;
    }

    const priorAttempts = await this.fanoutAttempts(event.id);
    const alreadyDelivered =
      priorAttempts > 0 ? await this.deliveredSubscriptionIds(workspaceId, event.id) : new Set<string>();
    const pending = matching.filter((sub) => !alreadyDelivered.has(sub.id));
    const carriedOver = matching.length - pending.length;

    await ensureSystemQueue(workspaceId, event.environmentId);
    logger.debug({ eventInternalId }, "Fan-out system queue ensured");

    const eventData = (event.data as Record<string, unknown>) ?? {};
    const envelope = {
      id: event.eventId,
      topic: topicName,
      type: event.type,
      timestamp: event.createdAt.toISOString(),
      data: eventData,
    };
    const deliveryFor = (sub: SubscriptionRow) => {
      if (sub.deliveryFormat !== "mcp") {
        return { body: envelope, headers: (sub.headers as Record<string, string> | null) ?? undefined };
      }
      const body = {
        eventId: event.eventId,
        name: sub.mcpEventName,
        timestamp: event.createdAt.toISOString(),
        data: mcpEventData(event.type, eventData),
        cursor: null,
      };
      if (Buffer.byteLength(JSON.stringify(body)) > MCP_MAX_PAYLOAD_BYTES) {
        throw new Error(`MCP event ${event.eventId} exceeds ${MCP_MAX_PAYLOAD_BYTES} bytes`);
      }
      return { body, headers: { [MCP_SUBSCRIPTION_HEADER]: sub.subscriptionId } };
    };

    let delivered = carriedOver;
    const concurrency = env.EVENTS_FANOUT_CONCURRENCY;
    for (let i = 0; i < pending.length; i += concurrency) {
      const batch = pending.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(async (sub) => {
          const delivery = deliveryFor(sub);
          return publishMessage({
            workspaceId,
            environmentId: event.environmentId,
            url: sub.url,
            method: "POST",
            headers: delivery.headers,
            body: delivery.body,
            queue: SYSTEM_QUEUE_NAME,
            contentId: `event:${event.id}:subscription:${sub.id}`,
            eventId: event.id,
            eventSubscriptionId: sub.id,
            traceRunId: event.traceRunId ?? undefined,
            traceParentSpanId: event.traceRunId ? `event_${event.eventId}` : undefined,
          });
        })
      );
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === "fulfilled") {
          delivered++;
        } else if (result.reason instanceof ConflictError) {
          delivered++;
          logger.debug(
            { eventId: event.eventId, subscriptionId: batch[j].subscriptionId },
            "Event delivery already enqueued, skipping duplicate"
          );
        } else {
          logger.warn(
            {
              eventId: event.eventId,
              subscriptionId: batch[j].subscriptionId,
              error: result.reason instanceof Error ? result.reason.message : result.reason,
            },
            "Failed to enqueue event delivery"
          );
        }
      }
    }

    if (delivered < matching.length) {
      const attempt = await this.recordFanoutAttempt(event.id);
      if (attempt < MAX_FANOUT_ATTEMPTS) {
        throw new PartialFanoutError(event.eventId, delivered, matching.length);
      }
      logger.error(
        {
          eventId: event.eventId,
          delivered,
          expected: matching.length,
          attempts: attempt,
        },
        "Fan-out giving up after repeated failures; some subscriptions did not receive this event"
      );
    }

    await this.clearFanoutAttempts(event.id);
    await db
      .update(events)
      .set({ status: "fanned_out", subscriptionCount: delivered })
      .where(eq(events.id, event.id));
    await this.recordTraceSpan(event, topicName, delivered, "fanned_out");
    logger.info({ eventId: event.eventId, delivered }, "Fan-out completed");
  }

  private async fanoutAttempts(eventInternalId: string): Promise<number> {
    const raw = await redis.get(RedisKeys.eventsFanoutAttempts(eventInternalId));
    return raw ? Number.parseInt(raw, 10) || 0 : 0;
  }

  private async deliveredSubscriptionIds(
    workspaceId: string,
    eventInternalId: string,
  ): Promise<Set<string>> {
    const rows = await db
      .select({ subscriptionId: messages.eventSubscriptionId })
      .from(messages)
      .where(and(eq(messages.workspaceId, workspaceId), eq(messages.eventId, eventInternalId)));
    return new Set(rows.map((r) => r.subscriptionId).filter((id): id is string => id !== null));
  }

  private async recordFanoutAttempt(eventInternalId: string): Promise<number> {
    const key = RedisKeys.eventsFanoutAttempts(eventInternalId);
    const attempts = await redis.incr(key);
    await redis.expire(key, FANOUT_ATTEMPTS_TTL_SECONDS);
    return attempts;
  }

  private async clearFanoutAttempts(eventInternalId: string): Promise<void> {
    await redis.del(RedisKeys.eventsFanoutAttempts(eventInternalId));
  }

  private async recordTraceSpan(
    event: typeof events.$inferSelect,
    topic: string,
    deliveryCount: number,
    fanoutStatus: "fanned_out" | "no_subscribers",
  ): Promise<void> {
    if (!event.traceRunId) return;
    try {
      await getRunWithTree({ workspaceId: event.workspaceId, environmentId: event.environmentId }, event.traceRunId);
      const endedAt = new Date().toISOString();
      await ingestSpans({ workspaceId: event.workspaceId, environmentId: event.environmentId }, event.traceRunId, [{
        id: `event_${event.eventId}`,
        ...(event.traceParentSpanId ? { parentId: event.traceParentSpanId } : {}),
        name: event.type,
        type: "event_delivery",
        status: "succeeded",
        startedAt: event.createdAt.toISOString(),
        endedAt,
        output: { deliveryCount, fanoutStatus },
        attributes: {
          eventId: event.eventId,
          topic,
          deliveryCount,
          fanoutStatus,
        },
      }]);
    } catch {
    }
  }

  private async ack(streamId: string): Promise<void> {
    await redis.xack(RedisKeys.eventsIngestStream(), CONSUMER_GROUP, streamId);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export async function startEventsWorkers(
  count: number = WORKER_COUNT
): Promise<EventsFanoutWorker[]> {
  const workers: EventsFanoutWorker[] = [];
  for (let i = 0; i < count; i++) {
    const worker = new EventsFanoutWorker(i);
    await worker.start();
    workers.push(worker);
  }
  logger.info({ count }, "Events fan-out workers started");
  return workers;
}
