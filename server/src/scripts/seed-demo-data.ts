import { db, pool } from "../db/index.ts";
import { eq, and, gte } from "drizzle-orm";
import { workspaces } from "../db/schema/workspaces.ts";
import { messages } from "../db/schema/messages.ts";
import { usageLogs } from "../db/schema/billing.ts";
import { messageExecutionLogs } from "../db/schema/execution-logs.ts";
import { generateMessageId } from "../utils/crypto.ts";

const DEMO_ENDPOINTS = [
  "https://api.acme.com/webhooks/orders",
  "https://api.acme.com/webhooks/payments",
  "https://hooks.slack.com/services/T00/B00/demo-channel",
  "https://api.stripe.com/v1/events/forward",
  "https://api.sendgrid.com/v3/mail/send",
  "https://api.twilio.com/2010-04-01/Messages.json",
  "https://api.shopify.com/admin/orders/webhook",
  "https://eu-api.intercom.io/events",
  "https://api.mixpanel.com/import",
  "https://hooks.zapier.com/hooks/catch/demo",
  "https://api.openai.com/v1/chat/completions",
  "https://api.segment.io/v1/batch",
];

const HTTP_METHODS = ["POST", "GET", "PUT", "PATCH"] as const;

const MESSAGE_STATUS_DISTRIBUTION: Array<{
  status: "delivered" | "failed" | "pending" | "scheduled" | "processing" | "cancelled";
  weight: number;
}> = [
  { status: "delivered", weight: 82 },
  { status: "failed", weight: 8 },
  { status: "pending", weight: 4 },
  { status: "scheduled", weight: 3 },
  { status: "processing", weight: 2 },
  { status: "cancelled", weight: 1 },
];

const ERROR_MESSAGES = [
  "Connection timeout after 30000ms",
  "HTTP 503 Service Unavailable",
  "HTTP 429 Too Many Requests",
  "DNS resolution failed",
  "SSL handshake failed",
  "HTTP 500 Internal Server Error",
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function weightedPick<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(randomInt(0, 23), randomInt(0, 59), randomInt(0, 59), 0);
  return d;
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3600_000);
}

async function verifyWorkspace(workspaceId: string): Promise<void> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) {
    console.error(`❌ Workspace ${workspaceId} not found`);
    process.exit(1);
  }
  console.log(`✅ Workspace: ${ws.name} (${ws.slug}, plan=${ws.plan})`);
}

async function cleanDemoData(workspaceId: string): Promise<void> {
  console.log("🧹 Cleaning existing demo data for workspace…");
  const thirty = daysAgo(31);
  await db.delete(messageExecutionLogs).where(
    and(eq(messageExecutionLogs.workspaceId, workspaceId), gte(messageExecutionLogs.timestamp, thirty))
  );
  await db.delete(messages).where(eq(messages.workspaceId, workspaceId));
  await db.delete(usageLogs).where(eq(usageLogs.workspaceId, workspaceId));
  console.log("   done.");
}

async function seedMessages(workspaceId: string, count: number) {
  console.log(`📥 Seeding ${count} messages + execution logs (30 days)…`);
  const messageRows: any[] = [];
  const logRows: any[] = [];

  for (let i = 0; i < count; i++) {
    const createdAt = daysAgo(randomInt(0, 29));
    const { status } = weightedPick(MESSAGE_STATUS_DISTRIBUTION);
    const method = pick(HTTP_METHODS);
    const url = pick(DEMO_ENDPOINTS);
    const messageId = generateMessageId();
    const attempts = status === "delivered" ? 1 : status === "failed" ? randomInt(2, 4) : randomInt(0, 2);
    const responseStatus =
      status === "delivered" ? pick([200, 200, 200, 201, 204]) : status === "failed" ? pick([500, 503, 429, 408]) : null;
    const deliveredAt =
      status === "delivered" ? new Date(createdAt.getTime() + randomInt(100, 5000)) : null;
    const failedAt =
      status === "failed" ? new Date(createdAt.getTime() + randomInt(500, 30000)) : null;

    messageRows.push({
      workspaceId,
      queueId: null,
      messageId,
      url,
      method,
      headers: { "content-type": "application/json", "x-demo": "true" },
      body: { event: "demo", idx: i },
      status,
      attempts,
      maxRetries: 3,
      responseStatus,
      responseBody: responseStatus ? (responseStatus < 300 ? '{"ok":true}' : '{"error":"failure"}') : null,
      errorMessage: status === "failed" ? pick(ERROR_MESSAGES) : null,
      deliveredAt,
      failedAt,
      scheduledFor: status === "scheduled" ? new Date(Date.now() + randomInt(60, 3600) * 1000) : null,
      createdAt,
      updatedAt: deliveredAt || failedAt || createdAt,
    });

    const logAttempts = status === "delivered" ? 1 : status === "failed" ? attempts : 0;
    for (let a = 1; a <= logAttempts; a++) {
      const logTs = new Date(createdAt.getTime() + a * randomInt(100, 2000));
      logRows.push({
        messageId,
        workspaceId,
        attemptNumber: a,
        status: a === logAttempts && status === "delivered" ? "SUCCESS" : status === "failed" && a === logAttempts ? "ERROR" : "RETRY",
        requestUrl: url,
        requestMethod: method,
        requestHeaders: { "content-type": "application/json" },
        responseStatus: a === logAttempts ? responseStatus : pick([500, 503, 429]),
        responseBody: a === logAttempts && responseStatus && responseStatus < 300 ? '{"ok":true}' : null,
        errorMessage: status === "failed" && a === logAttempts ? pick(ERROR_MESSAGES) : null,
        duration: randomInt(50, 3000),
        timestamp: logTs,
        createdAt: logTs,
      });
    }
  }

  for (let i = 0; i < messageRows.length; i += 200) {
    await db.insert(messages).values(messageRows.slice(i, i + 200));
  }
  for (let i = 0; i < logRows.length; i += 500) {
    await db.insert(messageExecutionLogs).values(logRows.slice(i, i + 500));
  }
  console.log(`   ${messageRows.length} messages, ${logRows.length} execution logs`);
}

async function seedUsageLogs(workspaceId: string) {
  console.log("📥 Seeding daily usage logs (30 days)…");
  const rows: any[] = [];
  for (let d = 0; d < 30; d++) {
    const date = new Date();
    date.setDate(date.getDate() - d);
    const iso = date.toISOString().slice(0, 10);
    const published = randomInt(800, 3500);
    const delivered = Math.floor(published * (0.85 + Math.random() * 0.1));
    const failed = published - delivered - randomInt(0, 20);
    rows.push({
      workspaceId,
      date: iso,
      messagesPublished: published,
      messagesDelivered: delivered,
      messagesFailed: Math.max(0, failed),
      bandwidthBytes: published * randomInt(1500, 8000),
    });
  }
  await db.insert(usageLogs).values(rows);

  const currentMonthMessages = rows
    .filter((r) => r.date.startsWith(new Date().toISOString().slice(0, 7)))
    .reduce((s, r) => s + r.messagesPublished, 0);
  const currentMonthBandwidth = rows
    .filter((r) => r.date.startsWith(new Date().toISOString().slice(0, 7)))
    .reduce((s, r) => s + r.bandwidthBytes, 0);
  await db
    .update(workspaces)
    .set({
      currentMonthMessages,
      currentMonthBandwidth,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId));
  console.log(`   ${rows.length} days of usage`);
}

async function main() {
  const args = process.argv.slice(2);
  const workspaceId = args.find((a) => !a.startsWith("--"));
  const shouldClean = args.includes("--clean");
  const messageCount = parseInt(args.find((a) => a.startsWith("--messages="))?.split("=")[1] || "600");

  if (!workspaceId) {
    console.error("Usage: tsx src/scripts/seed-demo-data.ts <workspaceId> [--clean] [--messages=N]");
    process.exit(1);
  }

  console.log(`🌱 Seeding demo data for workspace ${workspaceId}\n`);

  try {
    await verifyWorkspace(workspaceId);
    if (shouldClean) await cleanDemoData(workspaceId);

    await seedMessages(workspaceId, messageCount);
    await seedUsageLogs(workspaceId);

    console.log("\n✨ Done! Reload the dashboard and take your screenshots.");
  } catch (err) {
    console.error("\n❌ Seeding failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
