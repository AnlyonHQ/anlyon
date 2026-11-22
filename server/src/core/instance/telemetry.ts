import { randomUUID } from "node:crypto";
import { and, count, countDistinct, gte, isNull, isNotNull } from "drizzle-orm";
import { env } from "../../config/env.ts";
import { db } from "../../db/index.ts";
import { actionInvocations, actions } from "../../db/schema/actions.ts";
import { approvals } from "../../db/schema/approvals.ts";
import { actionEffects } from "../../db/schema/effects.ts";
import { workspaceMembers, workspaces } from "../../db/schema/workspaces.ts";
import { createLogger } from "../../lib/logger.ts";
import { currentEdition, isCloudEdition } from "../edition/edition.ts";
import { claimInternal, readInternal, writeInternal } from "./internal.ts";
import { INTERNAL_KEYS } from "./registry.ts";
import { isSetupPending } from "./setup.ts";
import { instanceSetting } from "./settings.ts";

const logger = createLogger({ module: "instance-telemetry" });

const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5_000;

export const EFFECT_GRADES = ["confirmed", "acknowledged", "unknown", "failed", "refused", "denied", "pending"] as const;

export interface TelemetryPayload {
  schema: "anlyon.telemetry.v1";
  instanceId: string;
  version: string;
  edition: string;
  day: string;
  counts: {
    workspaces: number;
    members: number;
    actions: number;
    invocations: number;
    effectsByGrade: Record<(typeof EFFECT_GRADES)[number], number>;
    approvalsRequested: number;
    approvalsDecided: number;
  };
}

export function telemetryEnabled(): boolean {
  return !isCloudEdition() && instanceSetting("telemetry.enabled") !== "false";
}

export async function instanceId(): Promise<string> {
  const existing = await readInternal(INTERNAL_KEYS.instanceId);
  if (existing?.value) return existing.value;
  await claimInternal(INTERNAL_KEYS.instanceId, randomUUID());
  return (await readInternal(INTERNAL_KEYS.instanceId))!.value!;
}

export interface TelemetryCounts {
  workspaces: number;
  members: number;
  actions: number;
  invocations: number;
  effectsByGrade: Record<string, number>;
  approvalsRequested: number;
  approvalsDecided: number;
}

export function buildTelemetryPayload(input: { instanceId: string; version: string; edition: string; now: Date; counts: TelemetryCounts }): TelemetryPayload {
  const effectsByGrade = Object.fromEntries(EFFECT_GRADES.map((grade) => [grade, Number(input.counts.effectsByGrade[grade] ?? 0)])) as TelemetryPayload["counts"]["effectsByGrade"];
  return {
    schema: "anlyon.telemetry.v1",
    instanceId: input.instanceId,
    version: input.version,
    edition: input.edition,
    day: input.now.toISOString().slice(0, 10),
    counts: {
      workspaces: Number(input.counts.workspaces),
      members: Number(input.counts.members),
      actions: Number(input.counts.actions),
      invocations: Number(input.counts.invocations),
      effectsByGrade,
      approvalsRequested: Number(input.counts.approvalsRequested),
      approvalsDecided: Number(input.counts.approvalsDecided),
    },
  };
}

async function collectCounts(now: Date): Promise<TelemetryCounts> {
  const since = new Date(now.getTime() - DAY_MS);
  const [[ws], [members], [acts], [invocations], grades, [requested], [decided]] = await Promise.all([
    db.select({ n: count() }).from(workspaces),
    db.select({ n: countDistinct(workspaceMembers.userId) }).from(workspaceMembers),
    db.select({ n: count() }).from(actions).where(isNull(actions.archivedAt)),
    db.select({ n: count() }).from(actionInvocations).where(gte(actionInvocations.createdAt, since)),
    db.select({ grade: actionEffects.grade, n: count() }).from(actionEffects).where(gte(actionEffects.createdAt, since)).groupBy(actionEffects.grade),
    db.select({ n: count() }).from(approvals).where(gte(approvals.createdAt, since)),
    db.select({ n: count() }).from(approvals).where(and(isNotNull(approvals.decidedAt), gte(approvals.decidedAt, since))),
  ]);
  return {
    workspaces: Number(ws?.n ?? 0),
    members: Number(members?.n ?? 0),
    actions: Number(acts?.n ?? 0),
    invocations: Number(invocations?.n ?? 0),
    effectsByGrade: Object.fromEntries(grades.map((row) => [row.grade, Number(row.n)])),
    approvalsRequested: Number(requested?.n ?? 0),
    approvalsDecided: Number(decided?.n ?? 0),
  };
}

export async function telemetryPreview(now: Date = new Date()): Promise<TelemetryPayload> {
  return buildTelemetryPayload({
    instanceId: await instanceId(),
    version: process.env.BUILD_SHA || "unknown",
    edition: currentEdition(),
    now,
    counts: await collectCounts(now),
  });
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export async function postTelemetry(payload: TelemetryPayload, url: string = env.ANLYON_TELEMETRY_URL, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) logger.debug({ status: response.status }, "Telemetry was not accepted");
    return response.ok;
  } catch (error) {
    logger.debug({ error: error instanceof Error ? error.message : error }, "Telemetry could not be sent");
    return false;
  }
}

export async function reportTelemetryIfDue(now: Date = new Date()): Promise<void> {
  if (!telemetryEnabled()) return;
  if (await isSetupPending()) return;
  const last = await readInternal(INTERNAL_KEYS.telemetryLastSentAt);
  if (last?.value && now.getTime() - new Date(last.value).getTime() < DAY_MS) return;
  await writeInternal(INTERNAL_KEYS.telemetryLastSentAt, now.toISOString());
  await postTelemetry(await telemetryPreview(now));
}
