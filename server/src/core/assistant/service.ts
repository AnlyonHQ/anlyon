import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { approvals, approvalPolicies } from "../../db/schema/approvals.ts";
import { runs } from "../../db/schema/runs.ts";
import { actionEffects } from "../../db/schema/effects.ts";
import {
  approvalAdvice,
  DEFAULT_AUTO_APPROVE,
  workspaceAssistantSettings,
  type AdviceHistory,
  type AssistantAutoApprove,
} from "../../db/schema/assistant.ts";
import { env } from "../../config/env.ts";
import { createLogger } from "../../lib/logger.ts";
import { ConflictError, ValidationError } from "../../utils/errors.ts";
import { limitAdvice } from "../billing/limit-advice.ts";
import { isEnvironmentHalted } from "../environments/halt.ts";
import {
  approveApproval,
  notifyApprovalRequested,
  toApproval,
  type ApprovalNotificationAdvice,
  type ApprovalView,
} from "../approvals/service.ts";
import {
  amountStats,
  ASSISTANT_CONSENT_VERSION,
  buildQuestions,
  buildState,
  RISK_LEVELS,
  toAdvice,
  type AdviceResult,
  type AdviceSubject,
} from "./advice.ts";
import { ENVELOPE_RULE_TEXT, MIN_CONFIDENCE_FLOOR, mayAutoApprove, readAmount } from "./envelope.ts";
import { askSystemOne, isTypeSafeConfigured, worstCaseReviewMs } from "./typesafe-client.ts";
import { publicModelVersion, VIGIL_NAME } from "./brand.ts";
import {
  admitAssistantUsage,
  admitPlatformReview,
  assistantCaps,
  releaseAssistantUsage,
  releasePlatformReview,
} from "./usage.ts";

const logger = createLogger({ module: "approval-assistant" });

type ApprovalRow = typeof approvals.$inferSelect;
type AdviceRow = typeof approvalAdvice.$inferSelect;

const HISTORY_DAYS = 30;
export const STUCK_AFTER_MS = 10_000;
export const CLAIM_LEASE_MS = worstCaseReviewMs() + 30_000;
const MAX_ATTEMPTS = 2;
const SWEEP_BATCH = 20;

export interface AssistantSettingsView {
  available: boolean;
  enabled: boolean;
  consentVersion: string | null;
  currentConsentVersion: string;
  consentedAt: Date | null;
  excludedFields: string[];
  autoApprove: AssistantAutoApprove;
  auditSampleRate: number;
  model: string;
}

export async function getAssistantSettings(workspaceId: string): Promise<AssistantSettingsView> {
  const [row] = await db.select().from(workspaceAssistantSettings).where(eq(workspaceAssistantSettings.workspaceId, workspaceId)).limit(1);
  return {
    available: isTypeSafeConfigured(),
    enabled: Boolean(row?.enabled) && row?.consentVersion === ASSISTANT_CONSENT_VERSION,
    consentVersion: row?.consentVersion ?? null,
    currentConsentVersion: ASSISTANT_CONSENT_VERSION,
    consentedAt: row?.consentedAt ?? null,
    excludedFields: row?.excludedFields ?? [],
    autoApprove: { ...DEFAULT_AUTO_APPROVE, ...(row?.autoApprove ?? {}) },
    auditSampleRate: row?.auditSampleRate ?? 0.1,
    model: publicModelVersion(env.TYPESAFE_MODEL) ?? "vigil",
  };
}

export interface AssistantSettingsPatch {
  enabled?: boolean;
  consentVersion?: string;
  excludedFields?: string[];
  autoApprove?: Partial<AssistantAutoApprove>;
  auditSampleRate?: number;
}

export async function updateAssistantSettings(
  workspaceId: string,
  patch: AssistantSettingsPatch,
  userId: string | null,
): Promise<AssistantSettingsView> {
  if (patch.enabled === true) {
    if (!isTypeSafeConfigured()) {
      throw new ValidationError(`${VIGIL_NAME} is not available on this deployment.`);
    }
    if (patch.consentVersion !== ASSISTANT_CONSENT_VERSION) {
      throw new ValidationError(
        `Turning on ${VIGIL_NAME} requires consent to the current data-sharing terms (consentVersion "${ASSISTANT_CONSENT_VERSION}").`,
      );
    }
  }
  const current = await getAssistantSettings(workspaceId);
  const autoApprove: AssistantAutoApprove = { ...current.autoApprove, ...(patch.autoApprove ?? {}) };
  autoApprove.minConfidence = Math.min(1, Math.max(MIN_CONFIDENCE_FLOOR, autoApprove.minConfidence));
  autoApprove.maxRisk = Math.min(4, Math.max(0, autoApprove.maxRisk));
  autoApprove.minHistory = Math.max(0, Math.floor(autoApprove.minHistory));
  autoApprove.actions = [...new Set(autoApprove.actions)];
  if (autoApprove.enabled && autoApprove.actions.length === 0) {
    throw new ValidationError("Auto-approve needs at least one action on its list.");
  }

  const values = {
    workspaceId,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.enabled === true
      ? { consentVersion: ASSISTANT_CONSENT_VERSION, consentedByUserId: userId, consentedAt: new Date() }
      : {}),
    ...(patch.excludedFields !== undefined ? { excludedFields: [...new Set(patch.excludedFields.map((f) => f.trim()).filter(Boolean))] } : {}),
    autoApprove,
    ...(patch.auditSampleRate !== undefined ? { auditSampleRate: Math.min(1, Math.max(0, patch.auditSampleRate)) } : {}),
    updatedAt: new Date(),
  };
  if (patch.enabled === false) values.autoApprove = { ...autoApprove, enabled: false };

  await db.insert(workspaceAssistantSettings).values(values)
    .onConflictDoUpdate({ target: workspaceAssistantSettings.workspaceId, set: values });
  logger.info({ workspaceId, enabled: patch.enabled, autoApprove: values.autoApprove.enabled }, "Approval assistant settings updated");
  return getAssistantSettings(workspaceId);
}

export async function onApprovalAnnounced(row: ApprovalRow): Promise<boolean> {
  if (!isTypeSafeConfigured() || row.status !== "pending") return false;
  const settings = await getAssistantSettings(row.workspaceId);
  if (!settings.enabled) return false;

  const [created] = await db.insert(approvalAdvice)
    .values({ approvalId: row.id, workspaceId: row.workspaceId, status: "pending" })
    .onConflictDoNothing()
    .returning();
  if (!created) return false;

  void processAdvice(created.id).catch((error) =>
    logger.error({ approvalId: row.approvalId, error }, "Approval assistant review crashed; the sweep will finish it"),
  );
  return true;
}

export async function processAdvice(adviceId: string): Promise<void> {
  const claimed = await claim(adviceId);
  if (!claimed) return;
  const approval = await loadApproval(claimed.approvalId);
  if (!approval) return;

  if (approval.status !== "pending") {
    await finish(claimed.id, { status: "skipped", statusReason: "already_decided" });
    return;
  }

  const settings = await getAssistantSettings(approval.workspaceId);

  if (claimed.recommendation !== null && claimed.risk !== null && claimed.confidence !== null) {
    const subject = await subjectFor(approval);
    const history = claimed.history ?? { approved: 0, denied: 0, maxAmount: null, medianAmount: null };
    await deliver(claimed.id, approval, settings, subject, history, storedAdvice(claimed));
    return;
  }

  if (!settings.enabled) {
    await notifyThenFinish(claimed.id, approval, { status: "skipped", statusReason: "assistant_disabled" });
    return;
  }

  const platformReservation = await admitPlatformReview();
  if (!platformReservation) {
    await notifyThenFinish(claimed.id, approval, { status: "skipped", statusReason: "platform_limit" });
    return;
  }

  const caps = await assistantCaps(approval.workspaceId);
  const reviewReservation = await admitAssistantUsage(approval.workspaceId, "reviews", caps.reviews);
  if (!reviewReservation) {
    await releasePlatformReview(platformReservation);
    await notifyThenFinish(claimed.id, approval, { status: "skipped", statusReason: "quota_exceeded" }, {
      note: `Vigil suggestions paused: this workspace has used its ${String(caps.reviews)} Vigil reviews for the month. ${limitAdvice("monthly")}`,
    });
    return;
  }

  const subject = await subjectFor(approval);
  const history = await historyFor(approval, subject);
  const result = await askSystemOne(
    buildState(subject, history, settings.excludedFields),
    buildQuestions(subject, settings.excludedFields),
  );

  if (!result.ok) {
    if (result.reason === "not_configured" || result.reason === "circuit_open") {
      await releaseAssistantUsage(reviewReservation);
      await releasePlatformReview(platformReservation);
    }
    await notifyThenFinish(claimed.id, approval, { status: "failed", statusReason: result.reason, latencyMs: result.latencyMs, history });
    return;
  }

  const advice = toAdvice(result.response, history);
  if (!advice) {
    await notifyThenFinish(claimed.id, approval, { status: "failed", statusReason: "invalid_answers", latencyMs: result.latencyMs, history });
    return;
  }

  await db.update(approvalAdvice).set({
    model: advice.model,
    recommendation: advice.recommendation,
    risk: advice.risk,
    confidence: advice.confidence,
    flags: advice.flags,
    reasons: advice.reasons,
    history,
    inputTokens: advice.inputTokens,
    latencyMs: result.latencyMs,
  }).where(and(eq(approvalAdvice.id, claimed.id), eq(approvalAdvice.status, "pending")));

  await deliver(claimed.id, approval, settings, subject, history, advice);
}

async function deliver(
  adviceId: string,
  approval: ApprovalRow,
  settings: AssistantSettingsView,
  subject: AdviceSubject,
  history: AdviceHistory,
  advice: AdviceResult,
): Promise<void> {
  const current = await loadApproval(approval.id);
  if (current?.status === "pending") {
    const autoApproved = await maybeAutoApprove(current, settings, subject, history, advice, adviceId);
    if (!autoApproved) {
      const latest = await loadApproval(approval.id);
      if (latest?.status === "pending") {
        await notifyApprovalRequested(latest.workspaceId, latest, { advice: notificationAdvice(advice) });
      }
    }
  }
  await finish(adviceId, { status: "ready" });
}

async function notifyThenFinish(
  adviceId: string,
  approval: ApprovalRow,
  patch: Partial<typeof approvalAdvice.$inferInsert>,
  extra: { note?: string } = {},
): Promise<void> {
  const current = await loadApproval(approval.id);
  if (current?.status === "pending") await notifyApprovalRequested(current.workspaceId, current, extra);
  await finish(adviceId, patch);
}

async function loadApproval(id: string): Promise<ApprovalRow | null> {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
  return row ?? null;
}

function storedAdvice(row: AdviceRow): AdviceResult {
  return {
    model: row.model ?? env.TYPESAFE_MODEL,
    recommendation: row.recommendation as AdviceResult["recommendation"],
    risk: row.risk as number,
    confidence: row.confidence as number,
    flags: row.flags ?? { injectionSuspected: null, consistentWithHistory: null, amountUnusual: null },
    reasons: row.reasons ?? [],
    inputTokens: row.inputTokens,
  };
}

async function claim(adviceId: string): Promise<AdviceRow | null> {
  const now = new Date();
  const [row] = await db.update(approvalAdvice)
    .set({ attempts: sql`${approvalAdvice.attempts} + 1`, claimedAt: now })
    .where(and(
      eq(approvalAdvice.id, adviceId),
      eq(approvalAdvice.status, "pending"),
      lt(approvalAdvice.attempts, MAX_ATTEMPTS),
      or(isNull(approvalAdvice.claimedAt), lt(approvalAdvice.claimedAt, new Date(now.getTime() - CLAIM_LEASE_MS))),
    ))
    .returning();
  return row ?? null;
}

async function finish(adviceId: string, patch: Partial<typeof approvalAdvice.$inferInsert>): Promise<boolean> {
  const updated = await db.update(approvalAdvice).set({ ...patch, completedAt: new Date() })
    .where(and(eq(approvalAdvice.id, adviceId), eq(approvalAdvice.status, "pending")))
    .returning({ id: approvalAdvice.id });
  return updated.length > 0;
}

export async function sweepPendingAdvice(now: Date = new Date()): Promise<number> {
  const leaseLapsed = new Date(now.getTime() - CLAIM_LEASE_MS);
  const stuck = await db.select().from(approvalAdvice)
    .where(and(
      eq(approvalAdvice.status, "pending"),
      lt(approvalAdvice.createdAt, new Date(now.getTime() - STUCK_AFTER_MS)),
      or(isNull(approvalAdvice.claimedAt), lt(approvalAdvice.claimedAt, leaseLapsed)),
    ))
    .limit(SWEEP_BATCH);
  await Promise.allSettled(stuck.map(async (row) => {
    if (row.attempts < MAX_ATTEMPTS) {
      await processAdvice(row.id).catch((error) => logger.warn({ adviceId: row.id, error }, "Assistant retry failed"));
      return;
    }
    const answered = row.recommendation !== null && row.risk !== null && row.confidence !== null;
    const [marked] = await db.update(approvalAdvice)
      .set(answered
        ? { status: "ready", completedAt: new Date() }
        : { status: "failed", statusReason: "gave_up", completedAt: new Date() })
      .where(and(
        eq(approvalAdvice.id, row.id),
        eq(approvalAdvice.status, "pending"),
        or(isNull(approvalAdvice.claimedAt), lt(approvalAdvice.claimedAt, leaseLapsed)),
      ))
      .returning();
    if (!marked) return;
    const approval = await loadApproval(row.approvalId);
    if (approval?.status === "pending") {
      await notifyApprovalRequested(
        approval.workspaceId,
        approval,
        answered ? { advice: notificationAdvice(storedAdvice(marked)) } : {},
      );
    }
  }));
  return stuck.length;
}

async function subjectFor(approval: ApprovalRow): Promise<AdviceSubject> {
  const payload = (approval.payload ?? {}) as Record<string, unknown>;
  const input = approval.kind === "action" ? payload.input : payload;
  let governedMoney = false;
  if (typeof payload.effectId === "string") {
    const [effect] = await db.select({ impact: actionEffects.impact }).from(actionEffects)
      .where(and(eq(actionEffects.effectId, payload.effectId), eq(actionEffects.workspaceId, approval.workspaceId))).limit(1);
    governedMoney = effect ? effect.impact.some((item) => item.dimension === "money") : true;
  }
  const { amount, carriesMoney } = readAmount(input, payload.amount, governedMoney);
  let agentId: string | null = null;
  if (approval.traceRunId) {
    const [run] = await db.select({ agentId: runs.agentId }).from(runs)
      .where(and(eq(runs.runId, approval.traceRunId), eq(runs.workspaceId, approval.workspaceId))).limit(1);
    agentId = run?.agentId ?? null;
  }
  let policyName: string | null = null;
  if (approval.matchedPolicyId) {
    const [policy] = await db.select({ name: approvalPolicies.name }).from(approvalPolicies)
      .where(and(eq(approvalPolicies.policyId, approval.matchedPolicyId), eq(approvalPolicies.workspaceId, approval.workspaceId))).limit(1);
    policyName = policy?.name ?? null;
  }
  return {
    kind: approval.kind,
    title: approval.title,
    description: approval.description,
    actionName: typeof payload.actionName === "string" ? payload.actionName : null,
    method: typeof payload.method === "string" ? payload.method : null,
    urlTemplate: typeof payload.urlTemplate === "string" ? payload.urlTemplate : null,
    input: input ?? null,
    agentId,
    policyName,
    policyExplanation: approval.policyExplanation,
    amount,
    carriesMoney,
  };
}

async function historyFor(approval: ApprovalRow, subject: AdviceSubject): Promise<AdviceHistory> {
  if (!subject.actionName) return { approved: 0, denied: 0, maxAmount: null, medianAmount: null };
  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000);
  const conditions = [
    eq(approvals.workspaceId, approval.workspaceId),
    eq(approvals.environmentId, approval.environmentId),
    eq(approvals.kind, "action"),
    gte(approvals.createdAt, since),
    inArray(approvals.status, ["approved", "denied"]),
    sql`${approvals.payload}->>'actionName' = ${subject.actionName}`,
    sql`${approvals.id} <> ${approval.id}`,
  ];
  if (subject.agentId) {
    conditions.push(sql`exists (select 1 from ${runs} where ${runs.runId} = ${approvals.traceRunId} and ${runs.agentId} = ${subject.agentId})`);
  }
  const rows = await db.select({ status: approvals.status, origin: approvals.decisionOrigin, amount: sql<string | null>`${approvals.payload}->'input'->>'amount'` })
    .from(approvals).where(and(...conditions)).limit(1000);

  let approved = 0;
  let denied = 0;
  const amounts: number[] = [];
  for (const row of rows) {
    if (row.status === "denied") denied++;
    if (row.status === "approved" && row.origin === "human") {
      approved++;
      const amount = Number(row.amount);
      if (row.amount !== null && Number.isFinite(amount)) amounts.push(amount);
    }
  }
  return { approved, denied, ...amountStats(amounts) };
}

async function maybeAutoApprove(
  approval: ApprovalRow,
  settings: AssistantSettingsView,
  subject: AdviceSubject,
  history: AdviceHistory,
  advice: NonNullable<ReturnType<typeof toAdvice>>,
  adviceId: string,
): Promise<boolean> {
  if (!settings.autoApprove.enabled) return false;
  const environmentHalted = await isEnvironmentHalted(approval.environmentId).catch(() => true);
  const verdict = mayAutoApprove({
    platformKillSwitch: env.ASSISTANT_AUTO_APPROVE_DISABLED,
    environmentHalted,
    settings,
    approval,
    actionName: subject.actionName,
    amount: subject.amount,
    carriesMoney: subject.carriesMoney ?? false,
    advice: {
      recommendation: advice.recommendation,
      risk: advice.risk,
      confidence: advice.confidence,
      injectionSuspected: advice.flags.injectionSuspected,
      consistentWithHistory: advice.flags.consistentWithHistory,
    },
    history,
    now: new Date(),
  });
  if (!verdict.ok) {
    await db.update(approvalAdvice)
      .set({ reasons: [...advice.reasons, `Left for a person: ${ENVELOPE_RULE_TEXT[verdict.failed[0]]}`] })
      .where(eq(approvalAdvice.id, adviceId));
    return false;
  }

  const caps = await assistantCaps(approval.workspaceId);
  const autoApprovalReservation = await admitAssistantUsage(approval.workspaceId, "auto_approvals", caps.autoApprovals);
  if (!autoApprovalReservation) {
    await db.update(approvalAdvice)
      .set({ reasons: [...advice.reasons, "Left for a person: the daily Vigil auto-approval limit was reached"] })
      .where(eq(approvalAdvice.id, adviceId));
    return false;
  }

  try {
    await approveApproval(
      approval.workspaceId,
      approval.approvalId,
      {
        assistant: { model: publicModelVersion(advice.model) ?? "vigil" },
        note: `Approved by ${VIGIL_NAME}: ${advice.reasons.slice(0, 2).join("; ")}`,
      },
      approval.environmentId,
    );
  } catch (error) {
    const current = await loadApproval(approval.id);
    if (current?.status === "approved" && current.decisionOrigin === "assistant") return true;
    await releaseAssistantUsage(autoApprovalReservation);
    logger.info({ approvalId: approval.approvalId, error }, "Assistant approval not applied; leaving it to a person");
    return false;
  }

  const audit = Math.random() < settings.auditSampleRate;
  await db.update(approvalAdvice).set({ auditRequested: audit }).where(eq(approvalAdvice.id, adviceId));
  logger.info({ workspaceId: approval.workspaceId, approvalId: approval.approvalId, audit }, "Approved by the AI approval assistant");
  return true;
}

export async function recordAuditVerdict(
  workspaceId: string,
  approvalPublicId: string,
  verdict: "agree" | "disagree",
  userId: string,
): Promise<AdviceView | null> {
  const [approval] = await db.select().from(approvals)
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.approvalId, approvalPublicId))).limit(1);
  if (!approval) return null;
  const [row] = await db.update(approvalAdvice)
    .set({ auditVerdict: verdict, auditedByUserId: userId, auditedAt: new Date() })
    .where(and(
      eq(approvalAdvice.approvalId, approval.id),
      eq(approvalAdvice.workspaceId, workspaceId),
      eq(approvalAdvice.auditRequested, true),
      isNull(approvalAdvice.auditVerdict),
    ))
    .returning();
  if (row) return toAdviceView(row);

  const [existing] = await db.select().from(approvalAdvice)
    .where(and(eq(approvalAdvice.approvalId, approval.id), eq(approvalAdvice.workspaceId, workspaceId)))
    .limit(1);
  if (!existing) return null;
  if (!existing.auditRequested) {
    throw new ConflictError(`This ${VIGIL_NAME} decision was not sampled for audit.`);
  }
  throw new ConflictError(`This ${VIGIL_NAME} decision has already been audited.`);
}

export interface AdviceView {
  status: "pending" | "ready" | "failed" | "skipped";
  statusReason: string | null;
  model: string | null;
  recommendation: "approve" | "deny" | "review" | null;
  risk: number | null;
  riskLevel: (typeof RISK_LEVELS)[number] | null;
  confidence: number | null;
  reasons: string[];
  flags: { injectionSuspected: number | null; consistentWithHistory: number | null; amountUnusual: number | null } | null;
  history: AdviceHistory | null;
  auditRequested: boolean;
  auditVerdict: "agree" | "disagree" | null;
  createdAt: Date;
  completedAt: Date | null;
}

export function toAdviceView(row: AdviceRow): AdviceView {
  const riskLevel = row.risk === null ? null : RISK_LEVELS[Math.min(4, Math.max(0, Math.round(row.risk)))];
  return {
    status: row.status,
    statusReason: row.statusReason,
    model: publicModelVersion(row.model),
    recommendation: row.recommendation,
    risk: row.risk,
    riskLevel,
    confidence: row.confidence,
    reasons: row.reasons ?? [],
    flags: row.flags ?? null,
    history: row.history ?? null,
    auditRequested: row.auditRequested,
    auditVerdict: (row.auditVerdict as "agree" | "disagree" | null) ?? null,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

export async function adviceByPublicId(workspaceId: string, publicIds: string[]): Promise<Map<string, AdviceView>> {
  if (publicIds.length === 0) return new Map();
  const rows = await db.select({ publicId: approvals.approvalId, advice: approvalAdvice })
    .from(approvalAdvice)
    .innerJoin(approvals, eq(approvals.id, approvalAdvice.approvalId))
    .where(and(eq(approvals.workspaceId, workspaceId), inArray(approvals.approvalId, publicIds)));
  return new Map(rows.map((row) => [row.publicId, toAdviceView(row.advice)]));
}

export async function listAuditQueue(workspaceId: string, limit = 50): Promise<Array<ApprovalView & { advice: AdviceView }>> {
  const rows = await db.select({ approval: approvals, advice: approvalAdvice })
    .from(approvalAdvice)
    .innerJoin(approvals, eq(approvals.id, approvalAdvice.approvalId))
    .where(and(
      eq(approvalAdvice.workspaceId, workspaceId),
      eq(approvalAdvice.auditRequested, true),
      isNull(approvalAdvice.auditVerdict),
    ))
    .orderBy(desc(approvals.decidedAt))
    .limit(limit);
  return rows.map((row) => ({ ...toApproval(row.approval), advice: toAdviceView(row.advice) }));
}

export async function adviceForApprovals(approvalIds: string[]): Promise<Map<string, AdviceView>> {
  if (approvalIds.length === 0) return new Map();
  const rows = await db.select().from(approvalAdvice).where(inArray(approvalAdvice.approvalId, approvalIds));
  return new Map(rows.map((row) => [row.approvalId, toAdviceView(row)]));
}

function notificationAdvice(advice: AdviceResult): ApprovalNotificationAdvice {
  return {
    recommendation: advice.recommendation,
    risk: RISK_LEVELS[Math.min(4, Math.max(0, Math.round(advice.risk)))],
    confidence: advice.confidence,
    reasons: advice.reasons.slice(0, 3),
  };
}
