import { db } from "../../db/index.ts";
import { messages } from "../../db/schema/messages.ts";
import { and, eq } from "drizzle-orm";
import { redis, RedisKeys, execPipelineChecked, USAGE_COUNTER_TTL_SECONDS } from "../../lib/redis.ts";
import { getTimestamp, calculateNextRetry } from "../../utils/time.ts";
import { createLogger } from "../../lib/logger.ts";
import { safeFetch, SsrfBlockedError } from "../../lib/safe-http.ts";
import { ValidationError } from "../../utils/errors.ts";
import { signDeliveryForWorkspace } from "../auth/delivery-secrets.ts";
import { signDeliveryPayload, signDeliveryPayloadForEnvironment, signStandardWebhook } from "../../utils/crypto.ts";
import { getSubscriptionSigningByInternalId } from "../events/service.ts";
import { MCP_SUBSCRIPTION_HEADER } from "../mcp-events/catalog.ts";
import { emitEvent } from "../events/emitter.ts";
import { CircuitBreaker } from "../../lib/circuit-breaker.ts";
import { queueMessageUpdate } from "../../lib/batch-writer.ts";
import { callbackQueue } from "../../lib/callback-queue.ts";
import { urlValidationCache, messageDataCache } from "../../lib/url-cache.ts";
import { logMessageExecution } from "../logging/execution-logger.ts";
import { isEnvironmentHalted } from "../environments/halt.ts";
import { extractSecretNames, interpolateObject, redactSecrets } from "../actions/template.ts";
import { assertSecretsMayReachHost, resolveSecrets } from "../actions/secrets.ts";
import { isWorkspaceSuspended, trackDeliveryOutcome } from "./abuse-guard.ts";
import { getRunWithTree, ingestSpans } from "../runs/service.ts";

const MAX_DLQ_ENTRIES = 10_000;

const logger = createLogger({ module: "consumer" });
const MAX_RESPONSE_BODY_BYTES = 64 * 1024;
const RESERVED_DELIVERY_HEADERS = new Set([
  "content-type",
  "anlyon-message-id",
  "x-idempotency-key",
  "x-delivery-attempt",
  "anlyon-signature",
  "anlyon-timestamp",
  "x-anlyon-workspace-id",
  "x-anlyon-environment-id",
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
]);

const MCP_FINAL_STATUSES = new Set([410, 413]);

export interface MessageData {
  messageId: string;
  workspaceId: string;
  environmentId?: string;
  url: string;
  method: string;
  headers: string;
  body: string;
  maxRetries: string | number;
  attempts: string | number;
  callbackUrl?: string;
  failureCallbackUrl?: string;
  queueId?: string;
  eventId?: string;
  eventSubscriptionId?: string;
  traceRunId?: string;
  traceParentSpanId?: string;
  traceStartedAt?: string;
}

async function lookupMessageEnvironment(
  workspaceId: string,
  messageId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ environmentId: messages.environmentId })
    .from(messages)
    .where(and(eq(messages.workspaceId, workspaceId), eq(messages.messageId, messageId)))
    .limit(1);
  if (!row?.environmentId) return undefined;

  await redis
    .hset(RedisKeys.message(workspaceId, messageId), "environmentId", row.environmentId)
    .catch(() => {});
  return row.environmentId;
}

export async function deliverMessage(messageData: MessageData): Promise<void> {
  let deliverySecrets = new Map<string, string>();

  const { messageId, workspaceId, url, method } = messageData;
  const attempts = parseInt(messageData.attempts as string) + 1;
  const startTime = Date.now();

  try {
    const environmentId =
      messageData.environmentId ?? (await lookupMessageEnvironment(workspaceId, messageId));
    if (!environmentId) {
      logger.warn({ messageId, workspaceId }, "Message deferred: environment not resolvable");
      await scheduleRetryWithoutAttempt(messageData);
      return;
    }
    if (await isEnvironmentHalted(environmentId)) {
      logger.info({ messageId, environmentId }, "Message deferred: environment halted");
      await scheduleRetryWithoutAttempt(messageData);
      return;
    }

    if (await isWorkspaceSuspended(workspaceId)) {
      logger.info({ messageId, workspaceId }, "Message deferred: workspace suspended");
      await scheduleRetryWithoutAttempt(messageData);
      return;
    }

    logger.info({ messageId, url, method, attempt: attempts }, "Delivering message");

    await logMessageExecution({
      messageId,
      workspaceId,
      attemptNumber: attempts,
      status: "ACTIVE",
      requestUrl: url,
      requestMethod: method || "POST",
    });

    const circuitCheck = await CircuitBreaker.canRequest(url, workspaceId);
    if (!circuitCheck.allowed) {
      logger.warn({ messageId, url, reason: circuitCheck.reason }, "Circuit breaker open");
      await scheduleRetryWithoutAttempt(messageData);
      return;
    }

    const cachedNeg = urlValidationCache.get(url);
    if (cachedNeg && !cachedNeg.valid) {
      throw new ValidationError(`Invalid URL: ${cachedNeg.error}`);
    }

    let parsedData = messageDataCache.get(messageId);
    let headers: Record<string, string>;
    let body: any;

    if (parsedData) {
      headers = parsedData.headers;
      body = parsedData.body;
    } else {
      headers = sanitizeDeliveryHeaders(JSON.parse(messageData.headers || "{}"));
      body = messageData.body ? JSON.parse(messageData.body) : undefined;
      messageDataCache.set(messageId, headers, body);
    }

    const bodyString = body ? JSON.stringify(body) : "";
    let signResult: { signature: string; timestamp: number } | null = null;
    let standardWebhookHeaders: Record<string, string> | null = null;
    if (messageData.eventSubscriptionId) {
      const signing = await getSubscriptionSigningByInternalId(messageData.eventSubscriptionId);
      const markedMcp = Object.keys(headers).some((name) => name.toLowerCase() === MCP_SUBSCRIPTION_HEADER.toLowerCase());
      if (signing?.format === "mcp" || (!signing && markedMcp)) {
        if (!signing?.secret || !signing.expiresAt || signing.expiresAt.getTime() <= Date.now()) {
          logger.info({ messageId }, "MCP event delivery dropped: subscription expired or removed");
          await handleFailure(messageData, Number(messageData.maxRetries), undefined, undefined, "MCP Events subscription expired or removed");
          return;
        }
        const timestamp = Math.floor(Date.now() / 1000);
        const webhookId = String((body as { eventId?: unknown } | undefined)?.eventId ?? messageId);
        standardWebhookHeaders = {
          "webhook-id": webhookId,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signStandardWebhook(webhookId, timestamp, bodyString, signing.secret),
        };
      } else if (signing?.secret) {
        const timestamp = Math.floor(Date.now() / 1000);
        signResult = {
          signature: messageData.environmentId
            ? signDeliveryPayloadForEnvironment(bodyString, signing.secret, messageData.environmentId, timestamp)
            : signDeliveryPayload(bodyString, signing.secret, timestamp),
          timestamp,
        };
      }
    }
    if (!signResult && !standardWebhookHeaders) {
      signResult = await signDeliveryForWorkspace(workspaceId, bodyString, messageData.environmentId);
    }

    const requestHeaders: Record<string, string> = {
      ...headers,
      "Content-Type": "application/json",
      "Anlyon-Message-Id": messageId,
      "X-Idempotency-Key": messageId,
      "X-Delivery-Attempt": attempts.toString(),
    };

    if (standardWebhookHeaders) Object.assign(requestHeaders, standardWebhookHeaders);
    if (signResult) {
      requestHeaders["Anlyon-Signature"] = signResult.signature;
      requestHeaders["Anlyon-Timestamp"] = signResult.timestamp.toString();
      requestHeaders["X-Anlyon-Workspace-Id"] = workspaceId;
      if (messageData.environmentId) requestHeaders["X-Anlyon-Environment-Id"] = messageData.environmentId;
    }

    const secretNames = extractSecretNames(requestHeaders);
    if (secretNames.length > 0) {
      await assertSecretsMayReachHost(workspaceId, secretNames, url, messageData.environmentId);
      deliverySecrets = await resolveSecrets(workspaceId, secretNames, messageData.environmentId);
    }

    await logMessageExecution({
      messageId,
      workspaceId,
      attemptNumber: attempts,
      status: "PROCESSING",
      requestUrl: url,
      requestMethod: method || "POST",
      requestHeaders,
      requestBody: body,
    });

    const requestStartTime = Date.now();
    let response: Response;
    try {
      response = await safeFetch(url, {
        method: method || "POST",
        headers:
          secretNames.length > 0
            ? (interpolateObject(requestHeaders, {}, deliverySecrets) as Record<string, string>)
            : requestHeaders,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        urlValidationCache.set(url, false, err.message);
        throw new ValidationError(`Invalid URL: ${err.message}`);
      }
      throw err;
    }

    const responseBody = redactSecrets(
      await readResponseBodyLimited(response, MAX_RESPONSE_BODY_BYTES),
      deliverySecrets,
    );
    const requestDuration = Date.now() - requestStartTime;

    if (response.ok) {
      await CircuitBreaker.recordSuccess(url, workspaceId);
      void trackDeliveryOutcome(workspaceId, url, true);
      
      await logMessageExecution({
        messageId,
        workspaceId,
        attemptNumber: attempts,
        status: "SUCCESS",
        requestUrl: url,
        requestMethod: method || "POST",
        responseStatus: response.status,
        responseBody: responseBody.substring(0, 5000),
        duration: requestDuration,
      });
      
      await handleSuccess(messageData, response.status, responseBody);
    } else {
      if (CircuitBreaker.isFailureStatus(response.status)) await CircuitBreaker.recordFailure(url, workspaceId);
      else await CircuitBreaker.recordSuccess(url, workspaceId);
      void trackDeliveryOutcome(workspaceId, url, false);

      await logMessageExecution({
        messageId,
        workspaceId,
        attemptNumber: attempts,
        status: "ERROR",
        requestUrl: url,
        requestMethod: method || "POST",
        responseStatus: response.status,
        responseBody: responseBody.substring(0, 5000),
        errorMessage: `HTTP ${response.status}: ${response.statusText}`,
        errorCode: `HTTP_${response.status}`,
        duration: requestDuration,
      });
      
      await handleFailure(
        messageData,
        standardWebhookHeaders && MCP_FINAL_STATUSES.has(response.status)
          ? Math.max(attempts, Number(messageData.maxRetries))
          : attempts,
        response.status,
        responseBody,
        `HTTP ${response.status}: ${response.statusText}`
      );
    }
  } catch (error) {
    const errorMessage = redactSecrets(
      error instanceof Error ? error.message : "Unknown error",
      deliverySecrets,
    );
    const errorCode = error instanceof ValidationError ? "VALIDATION_ERROR" : 
                     error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : 
                     "UNKNOWN_ERROR";
    const duration = Date.now() - startTime;
    
    await CircuitBreaker.recordFailure(url, workspaceId);
    void trackDeliveryOutcome(workspaceId, url, false);
    logger.error({ messageId, error: errorMessage }, "Message delivery failed");
    
    await logMessageExecution({
      messageId,
      workspaceId,
      attemptNumber: attempts,
      status: "ERROR",
      requestUrl: url,
      requestMethod: method || "POST",
      errorMessage,
      errorCode,
      duration,
    });
    
    await handleFailure(messageData, attempts, undefined, undefined, errorMessage);
  }
}

function sanitizeDeliveryHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (RESERVED_DELIVERY_HEADERS.has(name.toLowerCase())) {
      logger.warn({ header: name }, "Ignored reserved delivery header override");
      continue;
    }
    sanitized[name] = value;
  }
  return sanitized;
}

async function readResponseBodyLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;

  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;

      const remaining = maxBytes - bytesRead;
      const chunk = value.length > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      bytesRead += chunk.length;

      if (value.length > remaining) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function scheduleRetryWithoutAttempt(messageData: MessageData): Promise<void> {
  const { messageId, workspaceId } = messageData;
  const retryTimestamp = getTimestamp(new Date(Date.now() + 30000));

  const pipeline = redis.pipeline();
  pipeline.zadd(RedisKeys.processingSet(workspaceId), retryTimestamp, messageId);
  pipeline.sadd(RedisKeys.activeWorkspacesProcessing(), workspaceId);
  await execPipelineChecked(pipeline, "scheduleRetryWithoutAttempt");

  logger.info({ messageId }, "Message deferred due to circuit breaker");
}

async function handleSuccess(
  messageData: MessageData,
  responseStatus: number,
  responseBody: string
): Promise<void> {
  const { messageId, workspaceId, callbackUrl } = messageData;
  const usageDate = new Date().toISOString().split("T")[0];

  messageDataCache.remove(messageId);

  await queueMessageUpdate(messageId, {
    status: "delivered",
    responseStatus,
    responseBody: responseBody.substring(0, 1000),
    deliveredAt: new Date(),
    attempts: parseInt(messageData.attempts as string) + 1,
  });

  const deliveredKey = RedisKeys.usageCounter(workspaceId, usageDate, "messages_delivered");
  const pipeline = redis.pipeline();
  pipeline.del(RedisKeys.message(workspaceId, messageId));
  pipeline.incr(deliveredKey);
  pipeline.expire(deliveredKey, USAGE_COUNTER_TTL_SECONDS);
  await execPipelineChecked(pipeline, "handleSuccess");

  logger.info({ messageId, responseStatus }, "Message delivered successfully");
  await recordQueueDeliverySpan(messageData, {
    status: "succeeded",
    responseStatus,
    responseBody,
    attempts: parseInt(messageData.attempts as string) + 1,
  });

  if (!messageData.eventId) {
    emitEvent(workspaceId, "message.delivered", { messageId, responseStatus });
  }

  if (callbackUrl) {
    callbackQueue.enqueue(workspaceId, callbackUrl, {
      messageId,
      status: "delivered",
      responseStatus,
      deliveredAt: new Date().toISOString(),
    }, messageData.environmentId);
  }
}

async function handleFailure(
  messageData: MessageData,
  attempts: number,
  responseStatus?: number,
  responseBody?: string,
  errorMessage?: string
): Promise<void> {
  const { messageId, workspaceId, maxRetries, failureCallbackUrl } = messageData;
  const maxRetriesNum = parseInt(maxRetries as string);

  if (attempts >= maxRetriesNum) {
    logger.warn({ messageId, attempts }, "Message moved to DLQ");

    messageDataCache.remove(messageId);

    const usageDate = new Date().toISOString().split("T")[0];

    await queueMessageUpdate(messageId, {
      status: "failed",
      responseStatus,
      responseBody: responseBody?.substring(0, 1000),
      errorMessage: errorMessage?.substring(0, 500),
      failedAt: new Date(),
      attempts,
    });

    const failedKey = RedisKeys.usageCounter(workspaceId, usageDate, "messages_failed");
    const dlqKey = RedisKeys.dlqSet(workspaceId);
    const pipeline = redis.pipeline();
    pipeline.zadd(dlqKey, getTimestamp(), messageId);
    pipeline.zremrangebyrank(dlqKey, 0, -(MAX_DLQ_ENTRIES + 1));
    pipeline.incr(failedKey);
    pipeline.expire(failedKey, USAGE_COUNTER_TTL_SECONDS);
    pipeline.del(RedisKeys.message(workspaceId, messageId));
    await execPipelineChecked(pipeline, "handleFailure-dlq");
    await recordQueueDeliverySpan(messageData, {
      status: "failed",
      responseStatus,
      responseBody,
      errorMessage,
      attempts,
    });

    if (!messageData.eventId) {
      emitEvent(workspaceId, "message.failed", { messageId, attempts, errorMessage });
    }

    if (failureCallbackUrl) {
      callbackQueue.enqueue(workspaceId, failureCallbackUrl, {
        messageId,
        status: "failed",
        attempts,
        errorMessage,
        failedAt: new Date().toISOString(),
      }, messageData.environmentId);
    }
  } else {
    const nextRetry = calculateNextRetry(attempts);
    const retryTimestamp = getTimestamp(nextRetry);

    logger.info({ messageId, attempts, nextRetry }, "Scheduling retry");

    await logMessageExecution({
      messageId,
      workspaceId,
      attemptNumber: attempts,
      status: "RETRY",
      requestUrl: messageData.url,
      requestMethod: messageData.method || "POST",
      errorMessage: errorMessage?.substring(0, 1000),
      errorCode: responseStatus ? `HTTP_${responseStatus}` : undefined,
    });

    await queueMessageUpdate(messageId, {
      status: "processing",
      attempts,
      errorMessage: errorMessage?.substring(0, 500),
    });

    const pipeline = redis.pipeline();
    pipeline.hset(RedisKeys.message(workspaceId, messageId), "attempts", attempts.toString());
    pipeline.zadd(RedisKeys.processingSet(workspaceId), retryTimestamp, messageId);
    pipeline.sadd(RedisKeys.activeWorkspacesProcessing(), workspaceId);
    await execPipelineChecked(pipeline, "handleFailure-retry");
    await recordQueueDeliverySpan(messageData, {
      status: "running",
      responseStatus,
      responseBody,
      errorMessage,
      attempts,
    });
  }
}

async function recordQueueDeliverySpan(
  messageData: MessageData,
  result: {
    status: "running" | "succeeded" | "failed";
    responseStatus?: number;
    responseBody?: string;
    errorMessage?: string;
    attempts: number;
  },
): Promise<void> {
  if (!messageData.traceRunId) return;
  try {
    const { run } = await getRunWithTree({ workspaceId: messageData.workspaceId }, messageData.traceRunId);
    const endedAt = new Date().toISOString();
    await ingestSpans({ workspaceId: messageData.workspaceId, environmentId: run.environmentId }, messageData.traceRunId, [{
      id: `queue_${messageData.messageId}`,
      ...(messageData.traceParentSpanId ? { parentId: messageData.traceParentSpanId } : {}),
      name: messageData.url,
      type: "queue_delivery",
      status: result.status,
      startedAt: messageData.traceStartedAt ?? endedAt,
      ...(result.status === "running" ? {} : { endedAt }),
      ...(result.responseBody !== undefined ? { output: { status: result.responseStatus, body: result.responseBody } } : {}),
      ...(result.errorMessage ? { error: { message: result.errorMessage, status: result.responseStatus } } : {}),
      attributes: {
        messageId: messageData.messageId,
        queueId: messageData.queueId ?? null,
        attempt: result.attempts,
        eventId: messageData.eventId ?? null,
      },
    }]);
  } catch {
  }
}
