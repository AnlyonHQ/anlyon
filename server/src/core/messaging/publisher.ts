import { db } from "../../db/index.ts";
import { messages, messageEnqueueOutbox } from "../../db/schema/messages.ts";
import { captureMilestoneOnce } from "../../lib/product-events.ts";
import { redis, RedisKeys } from "../../lib/redis.ts";
import { generateMessageId, generateContentHash } from "../../utils/crypto.ts";
import { getTimestamp, timestampToDate } from "../../utils/time.ts";
import { ConflictError, ValidationError } from "../../utils/errors.ts";
import { createLogger } from "../../lib/logger.ts";
import type { PublishMessageRequest } from "../../types/api.ts";
import {
  QuotaExceededError,
  checkCustomHeadersQuota,
  checkWebhooksQuota,
} from "../billing/usage-enforcement.ts";
import { validateUrl } from "../../utils/url-validation.ts";
import {
  getWorkspaceCached,
  reservePlanQuota,
  releasePlanQuota,
} from "../../lib/workspace-cache.ts";
import { getQueueCached } from "./queue-lookup.ts";
import { logMessageExecution } from "../logging/execution-logger.ts";
import { recordPlanQuotaDecision } from "../billing/budget-tracing.ts";
import { finishMessageQuota } from "../billing/message-accounting.ts";
import { dispatchMessageOutbox } from "./enqueue-outbox.ts";

const logger = createLogger({ module: "publisher" });

export interface PublishOptions extends PublishMessageRequest {
  workspaceId: string;
  environmentId: string;
  eventId?: string;
  eventSubscriptionId?: string;
  traceRunId?: string;
  traceParentSpanId?: string;
  quotaTraceId?: string;
}

export interface PublishResult {
  messageId: string;
  status: "pending" | "scheduled";
  scheduledFor?: Date;
  queue?: string;
}

export async function publishMessage(options: PublishOptions): Promise<PublishResult> {
  const startTime = Date.now();
  const timings: Record<string, number> = {};

  const {
    workspaceId,
    url,
    method = "POST",
    headers,
    body,
    queue,
    executeAt,
    scheduledFor,
    maxRetries,
    contentId,
    callbackUrl,
    failureCallbackUrl,
    eventId,
    eventSubscriptionId,
    traceRunId: suppliedTraceRunId,
    traceParentSpanId: suppliedTraceParentSpanId,
    environmentId,
    quotaTraceId,
  } = options;
  const traceRunId = suppliedTraceRunId ?? options.runId;
  const traceParentSpanId = suppliedTraceParentSpanId ?? options.parentSpanId;

  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    throw new ValidationError(`Invalid URL: ${urlValidation.error}`);
  }

  if (callbackUrl) {
    const callbackValidation = validateUrl(callbackUrl);
    if (!callbackValidation.valid) {
      throw new ValidationError(`Invalid callback URL: ${callbackValidation.error}`);
    }
  }
  if (failureCallbackUrl) {
    const failureCallbackValidation = validateUrl(failureCallbackUrl);
    if (!failureCallbackValidation.valid) {
      throw new ValidationError(`Invalid failure callback URL: ${failureCallbackValidation.error}`);
    }
  }

  if (headers && Object.keys(headers).length > 0 && !eventId) {
    await checkCustomHeadersQuota(workspaceId);
  }

  if (callbackUrl || failureCallbackUrl) {
    await checkWebhooksQuota(workspaceId);
  }

  const messageSize = new TextEncoder().encode(
    JSON.stringify({ url, method, headers, body })
  ).length;

  timings.validation = Date.now() - startTime;

  const cacheStart = Date.now();
  const workspace = await getWorkspaceCached(workspaceId);
  if (!workspace) throw new ValidationError("Workspace not found");
  const quotaCheck = await reservePlanQuota(workspaceId, 1, messageSize);
  timings.cacheAndQuota = Date.now() - cacheStart;

  if (!workspace) {
    throw new ValidationError("Workspace not found");
  }
  const plan = workspace;

  try {
  await recordPlanQuotaDecision(
    workspaceId,
    traceRunId ? { runId: traceRunId, environmentId, parentSpanId: traceParentSpanId } : undefined,
    {
      id: quotaTraceId ?? `plan_quota_message_${traceRunId ?? "untraced"}`,
      allowed: quotaCheck.allowed,
      startedAt: new Date(startTime),
      messageCount: 1,
      messageSize,
      dailyUsage: quotaCheck.dailyUsage,
      monthlyUsage: quotaCheck.monthlyUsage,
      bandwidthUsage: quotaCheck.bandwidthUsage,
      dailyCap: quotaCheck.dailyCap,
      monthlyCap: quotaCheck.monthlyCap,
      bandwidthCap: quotaCheck.bandwidthCap,
      messageSizeCap: quotaCheck.messageSizeCap,
      rejectedDimension: quotaCheck.rejectedDimension,
    }
  );

  if (!quotaCheck.allowed) {
    throw new QuotaExceededError(quotaCheck.reason || "Quota exceeded");
  }

    return await publishReservedMessage();
  } catch (error) {
    if (quotaCheck.reservationId) await releasePlanQuota(workspaceId, 1, messageSize, quotaCheck.reservationId).catch((releaseError: unknown) =>
      logger.error(
        { releaseError: releaseError as unknown, workspaceId },
        "Failed to release a plan-quota reservation; manual reconciliation required"
      )
    );
    throw error;
  }

  async function publishReservedMessage(): Promise<PublishResult> {

    let queueInfo: { id: string; queueId: string; isPaused: boolean; parallelism: number } | null = null;
    if (queue) {
      queueInfo = await getQueueCached(workspaceId, queue, environmentId);
      if (!queueInfo) {
        throw new ValidationError(`Queue "${queue}" not found`);
      }
    }

    const effectiveMaxRetries = maxRetries !== undefined
      ? Math.min(maxRetries, plan.maxRetries)
      : plan.maxRetries;

    if (contentId) {
      const hash = generateContentHash({ url, method, body, contentId });
      const dedupKey = RedisKeys.contentHash(workspaceId, hash);
      const exists = await redis.get(dedupKey);

      if (exists) {
        throw new ConflictError("Message with this content already exists");
      }
    }

    const messageId = generateMessageId();
    const traceStartedAt = traceRunId ? new Date() : null;

    let scheduledDate: Date | undefined;
    let scheduledTimestamp: number | undefined;
    let status: "pending" | "scheduled" = "pending";

    if (executeAt) {
      scheduledTimestamp = executeAt;
      scheduledDate = timestampToDate(executeAt);
      status = "scheduled";
    } else if (scheduledFor) {
      scheduledDate = new Date(scheduledFor);
      scheduledTimestamp = getTimestamp(scheduledDate);
      status = "scheduled";
    }

    const messageData: Record<string, string | number> = {
      messageId,
      workspaceId,
      environmentId,
      url,
      method,
      headers: JSON.stringify(headers || {}),
      body: JSON.stringify(body) ?? "",
      maxRetries: effectiveMaxRetries,
      attempts: 0,
      callbackUrl: callbackUrl || "",
      failureCallbackUrl: failureCallbackUrl || "",
    };

    if (queueInfo) {
      messageData.queueId = queueInfo.queueId;
      messageData.queueName = queue!;
    }

    if (eventId) {
      messageData.eventId = eventId;
      if (eventSubscriptionId) {
        messageData.eventSubscriptionId = eventSubscriptionId;
      }
    }
    if (traceRunId && traceStartedAt) {
      messageData.traceRunId = traceRunId;
      if (traceParentSpanId) messageData.traceParentSpanId = traceParentSpanId;
      messageData.traceStartedAt = traceStartedAt.toISOString();
    }

    captureMilestoneOnce(workspaceId, "first_publish");

    const commands: Array<Array<string | number>> = [];
    commands.push(["hset", RedisKeys.message(workspaceId, messageId),
      ...Object.entries(messageData).flatMap(([key, value]) => [key, value])]);
    commands.push(["expire", RedisKeys.message(workspaceId, messageId), 604800]);
    if (contentId) {
      const hash = generateContentHash({ url, method, body, contentId });
      commands.push(["set", RedisKeys.contentHash(workspaceId, hash), messageId, "EX", 86400]);
    }
    if (status === "scheduled" && scheduledTimestamp !== undefined) {
      const key = queueInfo
        ? RedisKeys.queueScheduledSet(workspaceId, queueInfo.queueId)
        : RedisKeys.scheduledSet(workspaceId);
      commands.push(["zadd", key, scheduledTimestamp, messageId]);
      commands.push(["sadd", RedisKeys.activeWorkspacesScheduled(), workspaceId]);
    } else if (queueInfo) {
      commands.push(["xadd", RedisKeys.queuePendingStream(workspaceId, queueInfo.queueId), "*", "messageId", messageId]);
      commands.push(["sadd", RedisKeys.activeQueuesPending(), `${workspaceId}:${queueInfo.queueId}`]);
    } else {
      commands.push(["xadd", RedisKeys.pendingStream(workspaceId), "*", "messageId", messageId]);
      commands.push(["sadd", RedisKeys.activeWorkspacesPending(), workspaceId]);
    }
    if (queueInfo) commands.push(["sadd", RedisKeys.activeQueues(workspaceId), queueInfo.queueId]);

    const storageStart = Date.now();

    const dbData = {
      messageId,
      workspaceId,
      environmentId,
      queueId: queueInfo?.id || null,
      url,
      method,
      headers: headers as any,
      body: body as any,
      scheduledFor: scheduledDate,
      status,
      maxRetries: effectiveMaxRetries,
      callbackUrl,
      failureCallbackUrl,
      eventId: eventId || null,
      eventSubscriptionId: eventSubscriptionId || null,
      traceRunId: traceRunId || null,
      traceParentSpanId: traceParentSpanId || null,
      traceStartedAt,
    };

    await db.transaction(async tx => {
      if (!quotaCheck.reservationId) throw new Error("Missing durable message admission");
      await finishMessageQuota(workspaceId, quotaCheck.reservationId, "billed", tx);
      await tx.insert(messages).values(dbData);
      await tx.insert(messageEnqueueOutbox).values({ messageId, commands });
    });
    try {
      await dispatchMessageOutbox(messageId);
    } catch (error) {
      logger.error({ error, workspaceId, messageId }, "Durable message accepted; Redis enqueue needs recovery");
    }

    await logMessageExecution({
      messageId,
      workspaceId,
      attemptNumber: 0,
      status: "CREATED",
      requestUrl: url,
      requestMethod: method || "POST",
      requestHeaders: headers,
      requestBody: body,
    }).catch(error => logger.warn({ error, messageId }, "Accepted message logging failed"));

    timings.storage = Date.now() - storageStart;
    timings.total = Date.now() - startTime;

    logger.info(
      { messageId, workspaceId, timings },
      `Message published in ${timings.total}ms (cache: ${timings.cacheAndQuota}ms, storage: ${timings.storage}ms)`
    );

    if (status === "scheduled" && scheduledDate) {
      logger.info(
        { messageId, workspaceId, scheduledFor: scheduledDate },
        "Message scheduled"
      );
    }

    checkUsageAlertsAsync(workspaceId);

    return {
      messageId,
      status,
      scheduledFor: scheduledDate,
      queue: queue || undefined,
    };
  }

}

async function checkUsageAlertsAsync(workspaceId: string): Promise<void> {
  try {
    const { checkAndSendUsageAlerts } = await import("../notifications/usage-alerts.ts");
    checkAndSendUsageAlerts(workspaceId).catch((error) => {
      logger.error({ workspaceId, error }, "Failed to check usage alerts");
    });
  } catch (error) {
    logger.debug({ workspaceId, error }, "Usage alerts check skipped");
  }
}
