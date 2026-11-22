import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { db, pool } from "../src/db/index.ts";
import { eq, and, gte } from "drizzle-orm";
import { workspaces } from "../src/db/schema/workspaces.ts";
import { environments } from "../src/db/schema/environments.ts";
import { user } from "../src/db/schema/user.ts";
import { messages } from "../src/db/schema/messages.ts";
import { usageLogs } from "../src/db/schema/billing.ts";
import { messageExecutionLogs } from "../src/db/schema/execution-logs.ts";
import { agents, agentVersions } from "../src/db/schema/agents.ts";
import { runs, spans } from "../src/db/schema/runs.ts";
import { runFeedback } from "../src/db/schema/run-feedback.ts";
import { eventTopics, eventSubscriptions, events } from "../src/db/schema/events.ts";
import { approvals, approvalPolicies, approvalDecisions } from "../src/db/schema/approvals.ts";
import { workspaceSecrets, actions, actionInvocations } from "../src/db/schema/actions.ts";
import { notifications } from "../src/db/schema/notifications.ts";
import {
  generateMessageId,
  generateAgentId,
  generateAgentVersionId,
  generateRunId,
  generateSpanId,
  generateFeedbackId,
  generateEventId,
  generateTopicId,
  generateSubscriptionId,
  generateApprovalId,
  generateSecretId,
  generateActionId,
  generateInvocationId,
  encryptSecret,
} from "../src/utils/crypto.ts";

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
  "https://api.segment.io/v1/batch",
];

const HTTP_METHODS = ["POST", "GET", "PUT", "PATCH"] as const;

const ERROR_MESSAGES = [
  "Connection timeout after 30000ms",
  "HTTP 503 Service Unavailable",
  "HTTP 429 Too Many Requests",
  "DNS resolution failed",
  "SSL handshake failed",
  "HTTP 500 Internal Server Error",
];

const AGENT_FIXTURES = [
  {
    name: "support-triage",
    description: "Classifies inbound support tickets and drafts first replies",
  },
  {
    name: "order-copilot",
    description: "Answers order status questions and handles refund requests",
  },
  {
    name: "docs-researcher",
    description: "Retrieval-augmented answers over the product documentation",
  },
];

const RUN_QUESTIONS = [
  { query: "What is your refund policy?", answer: "Refunds are available within 30 days of purchase." },
  { query: "How do I reset my password?", answer: "Use the reset link on the sign-in page." },
  { query: "Where is my order?", answer: "Your order shipped and arrives in 2-3 business days." },
] as const;

const MODELS = [
  { model: "claude-haiku-4-5", provider: "anthropic" },
  { model: "claude-sonnet-5", provider: "anthropic" },
  { model: "gpt-5-mini", provider: "openai" },
];

const ACTION_FIXTURES = [
  {
    name: "send-slack-alert",
    description: "Posts an alert message to the #ops Slack channel",
    method: "POST" as const,
    urlTemplate: "https://hooks.slack.com/services/{{secret:SLACK_HOOK_PATH}}",
    requiresApproval: false,
  },
  {
    name: "issue-refund",
    description: "Issues a refund through the payments API",
    method: "POST" as const,
    urlTemplate: "https://api.acme.com/payments/{{input.paymentId}}/refund",
    requiresApproval: true,
  },
  {
    name: "lookup-order",
    description: "Fetches order details by id",
    method: "GET" as const,
    urlTemplate: "https://api.acme.com/orders/{{input.orderId}}",
    requiresApproval: false,
  },
  {
    name: "update-crm-contact",
    description: "Updates a contact record in the CRM",
    method: "PATCH" as const,
    urlTemplate: "https://api.crm.example.com/contacts/{{input.contactId}}",
    requiresApproval: false,
  },
];

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

function minutesAfter(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

const MASTER_KEY = process.env.DELIVERY_SECRET_MASTER_KEY || "seed-fake-data-master-key";

async function getContext(workspaceId: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) {
    console.error(`❌ Workspace ${workspaceId} not found`);
    process.exit(1);
  }
  const [environment] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.workspaceId, workspaceId), eq(environments.isDefault, true)));
  if (!environment) {
    console.error("❌ Workspace default environment not found");
    process.exit(1);
  }
  const [anyUser] = await db.select({ id: user.id }).from(user).limit(1);
  console.log(`✅ Workspace: ${ws.name} (${ws.slug}, plan=${ws.plan})`);
  return { workspace: ws, environmentId: environment.id, userId: anyUser?.id ?? null };
}

async function cleanSeededData(workspaceId: string): Promise<void> {
  console.log("🧹 Cleaning previously seeded data for workspace…");
  const thirty = daysAgo(31);
  await db.delete(messageExecutionLogs).where(
    and(eq(messageExecutionLogs.workspaceId, workspaceId), gte(messageExecutionLogs.timestamp, thirty))
  );
  await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
  await db.delete(agents).where(eq(agents.workspaceId, workspaceId));
  await db.delete(eventTopics).where(eq(eventTopics.workspaceId, workspaceId));
  await db.delete(approvals).where(eq(approvals.workspaceId, workspaceId));
  await db.delete(approvalPolicies).where(eq(approvalPolicies.workspaceId, workspaceId));
  await db.delete(actions).where(eq(actions.workspaceId, workspaceId));
  await db.delete(workspaceSecrets).where(eq(workspaceSecrets.workspaceId, workspaceId));
  await db.delete(notifications).where(eq(notifications.workspaceId, workspaceId));
  await db.delete(messages).where(eq(messages.workspaceId, workspaceId));
  await db.delete(usageLogs).where(eq(usageLogs.workspaceId, workspaceId));
  console.log("   done.");
}

async function seedMessages(workspaceId: string, count: number) {
  console.log(`📥 ${count} messages + execution logs (30 days)…`);
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
      status === "delivered" ? pick([200, 200, 200, 201, 204])
      : status === "failed" ? pick([500, 503, 429, 408])
      : null;
    const deliveredAt = status === "delivered" ? new Date(createdAt.getTime() + randomInt(100, 5000)) : null;
    const failedAt = status === "failed" ? new Date(createdAt.getTime() + randomInt(500, 30000)) : null;

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
        status:
          a === logAttempts && status === "delivered" ? "SUCCESS"
          : status === "failed" && a === logAttempts ? "ERROR"
          : "RETRY",
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
  console.log(`   ${messageRows.length} messages, ${logRows.length} log entries`);
}

async function seedUsageLogs(workspaceId: string) {
  console.log("📥 Daily usage logs (30 days)…");
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

  const month = new Date().toISOString().slice(0, 7);
  const currentMonthMessages = rows.filter((r) => r.date.startsWith(month)).reduce((s, r) => s + r.messagesPublished, 0);
  const currentMonthBandwidth = rows.filter((r) => r.date.startsWith(month)).reduce((s, r) => s + r.bandwidthBytes, 0);
  await db
    .update(workspaces)
    .set({ currentMonthMessages, currentMonthBandwidth, updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId));
  console.log(`   ${rows.length} days`);
}

async function seedAgents(workspaceId: string, environmentId: string) {
  console.log("📥 Agents + versions…");
  const out: Array<{ agentId: string; versionId: string }> = [];
  for (const fixture of AGENT_FIXTURES) {
    const [agent] = await db
      .insert(agents)
      .values({
        workspaceId,
        environmentId,
        agentId: generateAgentId(),
        name: fixture.name,
        description: fixture.description,
        createdAt: daysAgo(randomInt(15, 60)),
      })
      .returning();

    let currentVersionUuid: string | null = null;
    let currentVersionPublicId = "";
    const versionCount = randomInt(1, 3);
    for (let v = 1; v <= versionCount; v++) {
      const { model, provider } = pick(MODELS);
      const [version] = await db
        .insert(agentVersions)
        .values({
          workspaceId,
          environmentId,
          agentId: agent.id,
          agentVersionId: generateAgentVersionId(),
          version: v,
          config: {
            model,
            provider,
            temperature: 0.2,
            tools: ["lookup-order", "send-slack-alert"],
            memory: { collection: "default", recallTopK: 5 },
            budgets: { maxTokensPerRun: 8000, maxCostPerDayUsd: 5 },
          },
          createdBy: "seed-script",
          createdAt: daysAgo(randomInt(1, 14)),
        })
        .returning();
      currentVersionUuid = version.id;
      currentVersionPublicId = version.agentVersionId;
    }
    await db.update(agents).set({ currentVersionId: currentVersionUuid }).where(eq(agents.id, agent.id));
    out.push({ agentId: agent.agentId, versionId: currentVersionPublicId });
  }
  console.log(`   ${out.length} agents`);
  return out;
}

async function seedRuns(
  workspaceId: string,
  environmentId: string,
  agentsList: Array<{ agentId: string; versionId: string }>,
  count: number
) {
  console.log(`📥 ${count} agent runs + spans…`);
  const insertedRuns: Array<{ id: string; runId: string }> = [];
  for (let i = 0; i < count; i++) {
    const agent = pick(agentsList);
    const startedAt = daysAgo(randomInt(0, 14));
    const roll = Math.random();
    const status = roll < 0.8 ? "succeeded" : roll < 0.92 ? "failed" : roll < 0.97 ? "running" : "cancelled";
    const durationMs = randomInt(800, 45_000);
    const endedAt = status === "running" ? null : new Date(startedAt.getTime() + durationMs);
    const tokens = randomInt(300, 4000);
    const { model, provider } = pick(MODELS);

    const question = pick(RUN_QUESTIONS);
    const [run] = await db
      .insert(runs)
      .values({
        workspaceId,
        environmentId,
        agentId: agent.agentId,
        agentVersionId: agent.versionId,
        runId: generateRunId(),
        name: pick(["triage-ticket", "answer-question", "process-refund", "sync-order"]),
        status: status as any,
        userId: `usr_${randomInt(100, 999)}`,
        application: pick(["dashboard", "api", "slack-bot"]),
        input: { query: question.query },
        output: status === "succeeded" ? { answer: question.answer } : null,
        error: status === "failed" ? { message: pick(ERROR_MESSAGES) } : null,
        tokens,
        cost: (tokens * 0.000002).toFixed(6),
        tags: [pick(["prod", "staging"]), pick(["support", "billing", "orders"])],
        startedAt,
        endedAt,
        durationMs: endedAt ? durationMs : null,
        createdAt: startedAt,
        updatedAt: endedAt ?? startedAt,
      })
      .returning();
    insertedRuns.push({ id: run.id, runId: run.runId });

    const rootSpanId = generateSpanId();
    const spanRows: any[] = [
      {
        workspaceId, environmentId, runId: run.id,
        spanId: rootSpanId, parentSpanId: null,
        name: "agent-loop", type: "custom",
        status: status === "failed" ? "failed" : status === "running" ? "running" : "succeeded",
        startedAt, endedAt, durationMs: endedAt ? durationMs : null,
      },
      {
        workspaceId, environmentId, runId: run.id,
        spanId: generateSpanId(), parentSpanId: rootSpanId,
        name: "context-assembly", type: "context_assembly", status: "succeeded",
        startedAt, endedAt: minutesAfter(startedAt, 0.02), durationMs: randomInt(20, 200),
      },
      {
        workspaceId, environmentId, runId: run.id,
        spanId: generateSpanId(), parentSpanId: rootSpanId,
        name: "memory-recall", type: "memory_recall", status: "succeeded",
        attributes: { topK: 5, matches: randomInt(0, 5) },
        startedAt, endedAt: minutesAfter(startedAt, 0.05), durationMs: randomInt(30, 400),
      },
      {
        workspaceId, environmentId, runId: run.id,
        spanId: generateSpanId(), parentSpanId: rootSpanId,
        name: "llm-completion", type: "model_call",
        status: status === "failed" ? "failed" : "succeeded",
        model, provider,
        tokens: { prompt: Math.floor(tokens * 0.7), completion: Math.floor(tokens * 0.3), total: tokens },
        cost: (tokens * 0.000002).toFixed(6),
        error: status === "failed" ? { message: pick(ERROR_MESSAGES) } : null,
        startedAt: minutesAfter(startedAt, 0.05),
        endedAt: minutesAfter(startedAt, 0.3),
        durationMs: randomInt(400, 6000),
      },
    ];
    if (Math.random() < 0.5) {
      spanRows.push({
        workspaceId, environmentId, runId: run.id,
        spanId: generateSpanId(), parentSpanId: rootSpanId,
        name: pick(["lookup-order", "send-slack-alert"]), type: "tool_call", status: "succeeded",
        attributes: { httpStatus: 200 },
        startedAt: minutesAfter(startedAt, 0.3),
        endedAt: minutesAfter(startedAt, 0.4),
        durationMs: randomInt(80, 1500),
      });
    }
    await db.insert(spans).values(spanRows);
  }
  console.log(`   ${insertedRuns.length} runs`);
  return insertedRuns;
}

async function seedRunFeedback(
  workspaceId: string,
  environmentId: string,
  runsList: Array<{ id: string }>
) {
  console.log("📥 Run feedback…");
  const sample = runsList.slice(0, Math.min(10, runsList.length));
  const rows = sample.map((r, i) => ({
    workspaceId,
    environmentId,
    runId: r.id,
    feedbackId: generateFeedbackId(),
    source: pick(["user", "user", "model", "code"] as const),
    label: pick(["thumbs_up", "thumbs_down", "correctness", "helpfulness"]),
    rating: (Math.random() > 0.25 ? 1 : -1).toString(),
    comment: i % 3 === 0 ? pick(["Great answer!", "Missed the actual question.", "Fast and accurate.", "Had to rephrase twice."]) : null,
    createdBy: "seed-script",
  }));
  await db.insert(runFeedback).values(rows);
  console.log(`   ${rows.length} entries`);
}

async function seedEvents(workspaceId: string, environmentId: string) {
  console.log("📥 Event topics + subscriptions + events…");
  const topicFixtures = [
    { name: "orders", description: "Order lifecycle events", types: ["order.created", "order.paid", "order.shipped"] },
    { name: "billing", description: "Billing and invoice events", types: ["invoice.created", "invoice.paid", "payment.failed"] },
    { name: "agents", description: "Agent activity events", types: ["run.completed", "run.failed", "approval.requested"] },
  ];
  const eventRows: any[] = [];
  for (const t of topicFixtures) {
    const [topic] = await db
      .insert(eventTopics)
      .values({
        workspaceId,
        environmentId,
        topicId: generateTopicId(),
        name: t.name,
        description: t.description,
        createdAt: daysAgo(randomInt(15, 45)),
      })
      .returning();

    await db.insert(eventSubscriptions).values(
      Array.from({ length: randomInt(1, 2) }, () => ({
        workspaceId,
        environmentId,
        topicId: topic.id,
        subscriptionId: generateSubscriptionId(),
        url: pick(DEMO_ENDPOINTS),
        eventTypes: [pick(["*", `${t.name}.*`])],
        enabled: Math.random() > 0.15,
        createdAt: daysAgo(randomInt(5, 30)),
      }))
    );

    for (let i = 0; i < randomInt(8, 15); i++) {
      const subs = randomInt(0, 2);
      eventRows.push({
        workspaceId,
        environmentId,
        topicId: topic.id,
        eventId: generateEventId(),
        type: pick(t.types),
        data: { id: `obj_${randomInt(1000, 9999)}`, amount: randomInt(10, 900) },
        status: subs === 0 ? "no_subscribers" : "fanned_out",
        subscriptionCount: subs,
        createdAt: daysAgo(randomInt(0, 14)),
      });
    }
  }
  await db.insert(events).values(eventRows);
  console.log(`   ${topicFixtures.length} topics, ${eventRows.length} events`);
}

async function seedApprovals(workspaceId: string, environmentId: string, userId: string | null) {
  console.log("📥 Approval policies + approvals + decisions…");
  await db.insert(approvalPolicies).values([
    {
      workspaceId, environmentId,
      policyId: `pol_${nanoid(21)}`,
      name: "Refunds over $500 need a human",
      priority: 10,
      matchKind: "action",
      matchActionName: "issue-refund",
      minAmount: "500",
      effect: "require_approval",
      requiredApprovals: 1,
    },
    {
      workspaceId, environmentId,
      policyId: `pol_${nanoid(21)}`,
      name: "Auto-approve read-only lookups",
      priority: 50,
      matchKind: "action",
      matchActionName: "lookup-order",
      effect: "auto_approve",
    },
  ]);

  const statuses = ["pending", "pending", "approved", "approved", "approved", "denied", "expired"] as const;
  for (let i = 0; i < statuses.length; i++) {
    const status = statuses[i];
    const createdAt = daysAgo(randomInt(0, 10));
    const decided = status === "approved" || status === "denied";
    const [approval] = await db
      .insert(approvals)
      .values({
        workspaceId,
        environmentId,
        approvalId: generateApprovalId(),
        kind: i % 2 === 0 ? "action" : "custom",
        status,
        title: pick([
          "Refund $742.50 for order #4821",
          "Send apology credit to enterprise customer",
          "Delete 1,200 stale contact records",
          "Escalate incident to on-call",
          "Issue refund for duplicate charge",
        ]),
        description: "Requested by the support-triage agent during ticket handling.",
        payload: { actionName: "issue-refund", input: { paymentId: `pay_${randomInt(1000, 9999)}`, amount: randomInt(500, 900) } },
        decidedByUserId: decided ? userId : null,
        decisionNote: status === "denied" ? "Customer already refunded last week." : null,
        approvedCount: status === "approved" ? 1 : 0,
        expiresAt: status === "expired" ? hoursAgo(randomInt(1, 24)) : new Date(Date.now() + 72 * 3600_000),
        decidedAt: decided ? minutesAfter(createdAt, randomInt(10, 240)) : null,
        createdAt,
      })
      .returning();
    if (decided) {
      await db.insert(approvalDecisions).values({
        approvalId: approval.id,
        deciderUserId: userId,
        decision: status === "approved" ? "approve" : "deny",
        note: status === "denied" ? "Customer already refunded last week." : null,
        decidedAt: minutesAfter(createdAt, randomInt(10, 240)),
      });
    }
  }
  console.log(`   2 policies, ${statuses.length} approvals`);
}

async function seedActionsAndSecrets(workspaceId: string, environmentId: string) {
  console.log("📥 Secrets + actions + invocations…");
  await db.insert(workspaceSecrets).values(
    ["SLACK_HOOK_PATH", "PAYMENTS_API_KEY", "CRM_TOKEN"].map((name) => ({
      workspaceId,
      environmentId,
      secretId: generateSecretId(),
      name,
      valueEncrypted: encryptSecret(`fake-${name.toLowerCase()}-${nanoid(12)}`, MASTER_KEY, {
        store: "vault",
        workspaceId,
        environmentId,
        name,
      }),
      description: `Seeded fake secret (${name})`,
      lastUsedAt: Math.random() > 0.4 ? hoursAgo(randomInt(1, 96)) : null,
      createdAt: daysAgo(randomInt(10, 40)),
    }))
  );

  const invocationRows: any[] = [];
  for (const fixture of ACTION_FIXTURES) {
    const [action] = await db
      .insert(actions)
      .values({
        workspaceId,
        environmentId,
        actionId: generateActionId(),
        name: fixture.name,
        description: fixture.description,
        method: fixture.method,
        urlTemplate: fixture.urlTemplate,
        headers: { authorization: "Bearer {{secret:PAYMENTS_API_KEY}}" },
        inputSchema: { type: "object", properties: { orderId: { type: "string" } } },
        requiresApproval: fixture.requiresApproval,
        createdAt: daysAgo(randomInt(10, 40)),
      })
      .returning();

    for (let i = 0; i < randomInt(3, 6); i++) {
      const createdAt = daysAgo(randomInt(0, 10));
      const roll = Math.random();
      const status = fixture.requiresApproval && roll < 0.3
        ? "pending_approval"
        : roll < 0.8 ? "succeeded" : roll < 0.95 ? "failed" : "denied";
      invocationRows.push({
        workspaceId,
        environmentId,
        actionId: action.id,
        invocationId: generateInvocationId(),
        status: status as any,
        input: { orderId: `ord_${randomInt(1000, 9999)}` },
        responseStatus: status === "succeeded" ? 200 : status === "failed" ? pick([500, 502, 429]) : null,
        responseBody: status === "succeeded" ? '{"ok":true}' : null,
        errorMessage: status === "failed" ? pick(ERROR_MESSAGES) : null,
        durationMs: ["succeeded", "failed"].includes(status) ? randomInt(90, 4000) : null,
        createdAt,
        completedAt: ["succeeded", "failed"].includes(status) ? minutesAfter(createdAt, 1) : null,
      });
    }
  }
  await db.insert(actionInvocations).values(invocationRows);
  console.log(`   3 secrets, ${ACTION_FIXTURES.length} actions, ${invocationRows.length} invocations`);
}

async function seedNotifications(workspaceId: string, userId: string | null) {
  console.log("📥 Notifications…");
  const fixtures = [
    { type: "quota_warning", priority: "medium", title: "75% of monthly message quota used", message: "Your workspace has used 75% of its monthly message quota. Consider upgrading to avoid interruptions.", actionUrl: "/settings/billing", actionLabel: "View usage" },
    { type: "approval_requested", priority: "high", title: "Approval needed: refund $742.50", message: "The support-triage agent requested approval for a refund on order #4821.", actionUrl: "/approvals", actionLabel: "Review" },
    { type: "delivery_failure_spike", priority: "high", title: "Delivery failures spiking on webhooks-prod", message: "18% of deliveries to api.shopify.com failed in the last hour (429 Too Many Requests).", actionUrl: "/logs-explorer", actionLabel: "Inspect deliveries" },
    { type: "budget_alert", priority: "medium", title: "Agent order-copilot at 80% of daily budget", message: "The order-copilot agent has used $4.02 of its $5.00 daily cost budget.", actionUrl: "/agents", actionLabel: "View agent" },
    { type: "api_key_expiring", priority: "low", title: "API key expiring in 7 days", message: "The key anlyon_live_x4… expires on the 25th. Rotate it to avoid downtime.", actionUrl: "/settings/api-keys", actionLabel: "Rotate key" },
    { type: "plan_upgraded", priority: "low", title: "Workspace upgraded to Pro", message: "Your workspace is now on the Pro plan.", actionUrl: null, actionLabel: null },
    { type: "security_alert", priority: "critical", title: "New login from unrecognized device", message: "A new dashboard login was detected from Berlin, DE. If this wasn't you, rotate your credentials.", actionUrl: "/settings/security", actionLabel: "Review activity" },
    { type: "system_alert", priority: "medium", title: "Scheduled maintenance Sunday 02:00 UTC", message: "The platform will undergo maintenance for ~15 minutes. Deliveries will queue and drain automatically.", actionUrl: null, actionLabel: null },
  ] as const;
  const rows = fixtures.map((n, i) => {
    const createdAt = daysAgo(randomInt(0, 12));
    const isRead = i > 2 && Math.random() > 0.4;
    return {
      workspaceId,
      userId: i % 2 === 0 ? userId : null,
      type: n.type,
      priority: n.priority,
      title: n.title,
      message: n.message,
      actionUrl: n.actionUrl,
      actionLabel: n.actionLabel,
      isRead,
      readAt: isRead ? minutesAfter(createdAt, randomInt(30, 600)) : null,
      createdAt,
    };
  });
  await db.insert(notifications).values(rows);
  console.log(`   ${rows.length} notifications`);
}

async function main() {
  const args = process.argv.slice(2);
  const workspaceId = args.find((a) => !a.startsWith("--"));
  const shouldClean = args.includes("--clean");
  const messageCount = parseInt(args.find((a) => a.startsWith("--messages="))?.split("=")[1] || "500", 10);
  const runCount = parseInt(args.find((a) => a.startsWith("--runs="))?.split("=")[1] || "24", 10);

  if (!workspaceId) {
    console.error("Usage: tsx scripts/seed-fake-data.ts <workspaceId> [--clean] [--messages=N] [--runs=N]");
    process.exit(1);
  }

  console.log(`🌱 Seeding full-platform fake data for workspace ${workspaceId}`);
  console.log("   (no AI/embedding APIs are called  everything is faked locally)\n");

  try {
    const { environmentId, userId } = await getContext(workspaceId);
    if (shouldClean) await cleanSeededData(workspaceId);

    await seedMessages(workspaceId, messageCount);
    await seedUsageLogs(workspaceId);

    const agentsList = await seedAgents(workspaceId, environmentId);
    const runsList = await seedRuns(workspaceId, environmentId, agentsList, runCount);
    await seedRunFeedback(workspaceId, environmentId, runsList);
    await seedEvents(workspaceId, environmentId);
    await seedApprovals(workspaceId, environmentId, userId);
    await seedActionsAndSecrets(workspaceId, environmentId);
    await seedNotifications(workspaceId, userId);

    console.log("\n✨ Done! Reload the dashboard  every page should have data now.");
    console.log("   Re-running? Use --clean first (several tables have unique names).");
  } catch (err) {
    console.error("\n❌ Seeding failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
