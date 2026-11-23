import { standardWebhookKey } from "../../utils/crypto.ts";
import { createHmac, timingSafeEqual } from "crypto";
import { logger } from "../../lib/logger.ts";
import type { notifications } from "../../db/schema/notifications.ts";
import { safeFetch, SsrfBlockedError } from "../../lib/safe-http.ts";
import { readBodyLimited } from "../../lib/read-body.ts";
import { ValidationError } from "../../utils/errors.ts";

interface WebhookPayload {
  event: string;
  timestamp: string;
  workspaceId: string;
  data: {
    notificationId: string;
    type: string;
    priority: string;
    title: string;
    message: string;
    metadata?: any;
  };
}

export async function sendWebhookNotification(
  notification: typeof notifications.$inferSelect,
  webhookUrl: string,
  secret?: string
): Promise<void> {

  const payload: WebhookPayload = {
    event: `notification.${notification.type}`,
    timestamp: new Date().toISOString(),
    workspaceId: notification.workspaceId,
    data: {
      notificationId: notification.id,
      type: notification.type,
      priority: notification.priority || "medium",
      title: notification.title,
      message: notification.message,
      metadata: notification.metadata,
    },
  };

  const payloadString = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Anlyon-Scheduler/1.0",
    "X-Anlyon-Event": payload.event,
    "X-Anlyon-Timestamp": payload.timestamp,
  };

  if (secret) {
    const signature = generateSignature(payloadString, secret);
    headers["X-Anlyon-Signature"] = signature;
    const timestamp = Math.floor(Date.now() / 1000);
    headers["webhook-id"] = notification.id;
    headers["webhook-timestamp"] = String(timestamp);
    headers["webhook-signature"] = signStandardWebhookWithSecret(notification.id, timestamp, payloadString, secret);
  }

  try {
    const response = await safeFetch(webhookUrl, {
      method: "POST",
      headers,
      body: payloadString,
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(
        `Webhook request failed with status ${response.status}: ${(await readBodyLimited(response, 2048)).text}`
      );
    }

    logger.info({
      notificationId: notification.id,
      webhookHost: webhookHost(webhookUrl),
      status: response.status,
    }, "Webhook notification sent");
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      throw new ValidationError(`Invalid webhook URL: ${error.message}`);
    }
    logger.error({
      notificationId: notification.id,
      webhookHost: webhookHost(webhookUrl),
      error: error instanceof Error ? error.message : "Unknown error",
    }, "Failed to send webhook notification");
    throw error;
  }
}

function signStandardWebhookWithSecret(id: string, timestamp: number, body: string, secret: string): string {
  let key: Buffer;
  try {
    key = standardWebhookKey(secret);
  } catch {
    key = Buffer.from(secret, "utf8");
  }
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

function webhookHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

function generateSignature(payload: string, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(payload);
  return `sha256=${hmac.digest("hex")}`;
}

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = generateSignature(payload, secret);
  
  try {
    const receivedSig = signature.replace(/^sha256=/, "");
    const expectedSig = expectedSignature.replace(/^sha256=/, "");
    
    if (receivedSig.length !== expectedSig.length) {
      return false;
    }
    
    return timingSafeEqual(
      Buffer.from(receivedSig, "hex"),
      Buffer.from(expectedSig, "hex")
    );
  } catch {
    return false;
  }
}

export async function sendTestWebhook(webhookUrl: string, secret?: string): Promise<boolean> {
  const testPayload: WebhookPayload = {
    event: "notification.test",
    timestamp: new Date().toISOString(),
    workspaceId: "test",
    data: {
      notificationId: "test",
      type: "system_alert",
      priority: "low",
      title: "Test Notification",
      message: "This is a test webhook notification from Anlyon.",
    },
  };

  const payloadString = JSON.stringify(testPayload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Anlyon-Scheduler/1.0",
    "X-Anlyon-Event": testPayload.event,
    "X-Anlyon-Timestamp": testPayload.timestamp,
  };

  if (secret) {
    const signature = generateSignature(payloadString, secret);
    headers["X-Anlyon-Signature"] = signature;
  }

  try {
    const response = await safeFetch(webhookUrl, {
      method: "POST",
      headers,
      body: payloadString,
      signal: AbortSignal.timeout(10000),
    });

    logger.info({
      webhookHost: webhookHost(webhookUrl),
      status: response.status,
      success: response.ok,
    }, "Test webhook sent");

    return response.ok;
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      logger.warn({ webhookHost: webhookHost(webhookUrl), error: error.message }, "Invalid test webhook URL");
      return false;
    }
    logger.error({
      webhookHost: webhookHost(webhookUrl),
      error: error instanceof Error ? error.message : "Unknown error",
    }, "Test webhook failed");
    return false;
  }
}
