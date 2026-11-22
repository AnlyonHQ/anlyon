import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import {
  impactLimitPeriods,
  impactLimits,
  impactReservations,
  type ImpactLimit,
  type ImpactReservation,
  type LimitPeriod,
  type PartialEffect,
} from "../../db/schema/effects.ts";
import { ConflictError, NotFoundError, ValidationError } from "../../utils/errors.ts";
import type { ImpactQuantity } from "./adapter.ts";
import { DECLARED_UNIT } from "./declarations.ts";
import { generateLimitId } from "../../utils/crypto.ts";
import { endUserCounterTag } from "../end-users/identity.ts";
import type { LimitScope } from "../../db/schema/effects.ts";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Tx | typeof db;

export class EffectRejection extends Error {
  constructor(readonly reason: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "EffectRejection";
  }
}

export function periodKeyFor(period: LimitPeriod, now: Date): string {
  const iso = now.toISOString();
  if (period === "day") return `day:${iso.slice(0, 10)}`;
  if (period === "month") return `month:${iso.slice(0, 7)}`;
  return "total";
}

export function bucketKeyFor(limit: Pick<ImpactLimit, "period" | "scope">, now: Date, endUserId: string | null | undefined): string {
  const base = periodKeyFor(limit.period, now);
  return limit.scope === "end_user" && endUserId ? `${base}|${endUserCounterTag(endUserId)}` : base;
}

function bucketRows(limitId: string, endUserId: string | null | undefined) {
  return and(
    eq(impactLimitPeriods.limitId, limitId),
    endUserId
      ? sql`${impactLimitPeriods.periodKey} like ${`%|${endUserCounterTag(endUserId)}`}`
      : sql`position('|' in ${impactLimitPeriods.periodKey}) = 0`,
  );
}

async function bucketOutstanding(executor: Executor, limitId: string, endUserId: string | null | undefined): Promise<number> {
  const [row] = await executor.select({ total: sql<string>`coalesce(sum(${impactLimitPeriods.reserved}), 0)` })
    .from(impactLimitPeriods).where(bucketRows(limitId, endUserId));
  return Number(row?.total ?? 0);
}

export interface LimitInput {
  name: string;
  dimension: string;
  currency?: string | null;
  unit?: string | null;
  actionName?: string | null;
  resourcePrefix?: string | null;
  scope?: LimitScope;
  period: LimitPeriod;
  amount: number;
}

export interface LimitView {
  id: string;
  name: string;
  dimension: string;
  currency: string | null;
  unit: string;
  scope: { environmentId: string; actionName: string | null; resourcePrefix: string | null; kind: LimitScope };
  period: LimitPeriod;
  limit: number;
  currentPeriod: string;
  consumed: number;
  reserved: number;
  unknownExposure: number;
  available: number;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function checkLimitInput(input: LimitInput): string | null {
  if (!Number.isInteger(input.amount) || input.amount < 0) throw new ValidationError("amount must be a non-negative integer.");
  if (!DECLARED_UNIT.test(input.dimension)) {
    throw new ValidationError("dimension must be money, resource_mutations, or a unit of lowercase letters, digits and underscores (at most 32 characters).");
  }
  if (input.dimension === "money") {
    const currency = input.currency ?? input.unit;
    if (!currency || !/^[a-z]{3}$/.test(currency) || (input.unit && input.unit !== currency)) {
      throw new ValidationError("A money limit needs one lowercase ISO currency, e.g. usd.");
    }
    return currency;
  }
  if (input.currency) throw new ValidationError("Only a money limit has a currency.");
  if (input.unit && input.unit !== input.dimension) {
    throw new ValidationError(`The unit of a ${input.dimension} limit is ${input.dimension}.`);
  }
  return null;
}

const bucketOf = (periodKey: string) => {
  const at = periodKey.indexOf("|");
  return at === -1 ? "" : periodKey.slice(at + 1);
};

async function currentPeriodRows(
  limits: ImpactLimit[], keys: Map<string, string>, endUserId: string | null | undefined,
): Promise<Map<string, { consumed: number; unknown: number; reserved: number }>> {
  if (!limits.length) return new Map();
  const rows = await db.select().from(impactLimitPeriods).where(inArray(impactLimitPeriods.limitId, limits.map((l) => l.id)));
  const byId = new Map(limits.map((l) => [l.id, l]));
  const out = new Map<string, { consumed: number; unknown: number; reserved: number }>();
  for (const limit of limits) out.set(limit.id, { consumed: 0, unknown: 0, reserved: 0 });
  for (const row of rows) {
    const limit = byId.get(row.limitId)!;
    const entry = out.get(row.limitId)!;
    if (limit.scope === "end_user" && bucketOf(row.periodKey) !== (endUserId ? endUserCounterTag(endUserId) : "")) continue;
    entry.unknown += Number(row.unknownExposure);
    entry.reserved += Number(row.reserved);
    if (keys.get(row.limitId) === row.periodKey) entry.consumed = Number(row.consumed);
  }
  return out;
}

export async function toLimitViews(rows: ImpactLimit[], now = new Date(), endUserId?: string | null): Promise<LimitView[]> {
  const keys = new Map(rows.map((row) => [row.id, bucketKeyFor(row, now, endUserId)]));
  const periods = await currentPeriodRows(rows, keys, endUserId);
  return rows.map((row) => {
    const p = periods.get(row.id) ?? { consumed: 0, unknown: 0, reserved: 0 };
    const reserved = row.scope === "end_user" ? p.reserved : Number(row.outstandingReserved);
    return {
      id: row.limitId,
      name: row.name,
      dimension: row.dimension,
      currency: row.currency,
      unit: row.currency ?? row.dimension,
      scope: { environmentId: row.environmentId, actionName: row.actionName, resourcePrefix: row.resourcePrefix, kind: row.scope },
      period: row.period,
      limit: Number(row.amount),
      currentPeriod: periodKeyFor(row.period, now),
      consumed: p.consumed,
      reserved,
      unknownExposure: p.unknown,
      available: Math.max(Number(row.amount) - p.consumed - reserved, 0),
      archived: row.archivedAt !== null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}

async function limitRow(workspaceId: string, environmentId: string, limitId: string): Promise<ImpactLimit> {
  const [row] = await db.select().from(impactLimits).where(and(
    eq(impactLimits.workspaceId, workspaceId), eq(impactLimits.environmentId, environmentId), eq(impactLimits.limitId, limitId),
  ));
  if (!row) throw new NotFoundError("Impact limit");
  return row;
}

export async function createLimit(workspaceId: string, environmentId: string, input: LimitInput): Promise<LimitView> {
  const currency = checkLimitInput(input);
  const [row] = await db.insert(impactLimits).values({
    workspaceId,
    environmentId,
    limitId: generateLimitId(),
    name: input.name,
    dimension: input.dimension,
    currency,
    actionName: input.actionName ?? null,
    resourcePrefix: input.resourcePrefix ?? null,
    scope: input.scope ?? "environment",
    period: input.period,
    amount: input.amount,
  }).returning();
  return (await toLimitViews([row]))[0];
}

export async function updateLimit(
  workspaceId: string, environmentId: string, limitId: string, input: { name?: string; amount?: number },
): Promise<LimitView> {
  const row = await limitRow(workspaceId, environmentId, limitId);
  if (row.archivedAt) throw new ConflictError("This impact limit is archived.");
  if (input.amount !== undefined && (!Number.isInteger(input.amount) || input.amount < 0)) {
    throw new ValidationError("amount must be a non-negative integer.");
  }
  const [updated] = await db.update(impactLimits).set({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.amount !== undefined ? { amount: input.amount } : {}),
    updatedAt: new Date(),
  }).where(eq(impactLimits.id, row.id)).returning();
  return (await toLimitViews([updated]))[0];
}

export async function archiveLimit(workspaceId: string, environmentId: string, limitId: string): Promise<LimitView> {
  const row = await limitRow(workspaceId, environmentId, limitId);
  const [updated] = await db.update(impactLimits).set({ archivedAt: row.archivedAt ?? new Date(), updatedAt: new Date() })
    .where(eq(impactLimits.id, row.id)).returning();
  return (await toLimitViews([updated]))[0];
}

export async function listLimits(
  workspaceId: string, environmentId: string, opts: { includeArchived?: boolean; endUserId?: string | null } = {},
) {
  const rows = await db.select().from(impactLimits).where(and(
    eq(impactLimits.workspaceId, workspaceId),
    eq(impactLimits.environmentId, environmentId),
    ...(opts.includeArchived ? [] : [isNull(impactLimits.archivedAt)]),
  )).orderBy(asc(impactLimits.createdAt));
  return toLimitViews(rows, new Date(), opts.endUserId);
}

export async function getLimit(workspaceId: string, environmentId: string, limitId: string, endUserId?: string | null): Promise<LimitView> {
  return (await toLimitViews([await limitRow(workspaceId, environmentId, limitId)], new Date(), endUserId))[0];
}

export interface ImpactSubject {
  workspaceId: string;
  environmentId: string;
  actionName: string;
  resourceKey: string;
  impact: ImpactQuantity[];
  dimensions: string[];
  endUserId?: string | null;
}

export function quantityFor(limit: Pick<ImpactLimit, "dimension" | "currency">, subject: Pick<ImpactSubject, "impact" | "dimensions">): number | null | undefined {
  if (limit.dimension === "money") {
    const money = subject.impact.filter((q) => q.dimension === "money");
    const match = money.find((q) => q.dimension === "money" && q.currency === limit.currency);
    if (match) return match.amount;
    if (money.length > 0) return undefined;
    return subject.dimensions.includes("money") ? null : undefined;
  }
  const count = subject.impact.find((q) => q.dimension === limit.dimension);
  if (count) return count.amount;
  return subject.dimensions.includes(limit.dimension) ? null : undefined;
}

function scopeMatches(limit: ImpactLimit, subject: ImpactSubject): boolean {
  if (limit.actionName !== null && limit.actionName !== subject.actionName) return false;
  if (limit.resourcePrefix !== null && !subject.resourceKey.startsWith(limit.resourcePrefix)) return false;
  return true;
}

async function applicableLimits(executor: Executor, subject: ImpactSubject, lock: boolean) {
  const base = executor.select().from(impactLimits).where(and(
    eq(impactLimits.workspaceId, subject.workspaceId),
    eq(impactLimits.environmentId, subject.environmentId),
    isNull(impactLimits.archivedAt),
  )).orderBy(asc(impactLimits.id));
  const rows = lock ? await base.for("update") : await base;
  const applicable: Array<{ limit: ImpactLimit; amount: number }> = [];
  for (const limit of rows) {
    if (!scopeMatches(limit, subject)) continue;
    const amount = quantityFor(limit, subject);
    if (amount === undefined) continue;
    if (amount === null) {
      throw new EffectRejection(
        "impact_unbounded",
        `Limit ${limit.limitId} (${limit.name}) caps ${limit.dimension}, and this operation gives no exact quantity or upper bound for it.`,
        { limitId: limit.limitId },
      );
    }
    applicable.push({ limit, amount });
  }
  return applicable;
}

export async function describeAllowances(subject: ImpactSubject): Promise<Array<Record<string, unknown>>> {
  let applicable: Array<{ limit: ImpactLimit; amount: number }>;
  try {
    applicable = await applicableLimits(db, subject, false);
  } catch (error) {
    if (error instanceof EffectRejection) return [{ blocked: true, reason: error.reason, message: error.message }];
    throw error;
  }
  const views = await toLimitViews(applicable.map((a) => a.limit), new Date(), subject.endUserId);
  return views.map((view, i) => ({
    limitId: view.id, name: view.name, dimension: view.dimension, currency: view.currency, unit: view.unit, period: view.period,
    limit: view.limit, consumed: view.consumed, reserved: view.reserved, unknownExposure: view.unknownExposure,
    available: view.available, requested: applicable[i].amount, sufficient: view.available >= applicable[i].amount,
  }));
}

async function periodRow(tx: Tx, limitId: string, periodKey: string) {
  await tx.insert(impactLimitPeriods).values({ limitId, periodKey }).onConflictDoNothing();
  const [row] = await tx.select().from(impactLimitPeriods)
    .where(and(eq(impactLimitPeriods.limitId, limitId), eq(impactLimitPeriods.periodKey, periodKey))).for("update");
  return row;
}

export async function reserveImpactIn(
  tx: Tx, effectRowId: string, subject: ImpactSubject, now: Date,
): Promise<Array<{ limitId: string; amount: number }>> {
  const existing = await tx.select().from(impactReservations).where(eq(impactReservations.effectId, effectRowId));
  if (existing.length) return existing.map((row) => ({ limitId: row.limitId, amount: Number(row.amount) }));

  const applicable = await applicableLimits(tx, subject, true);
  const shortfalls: Array<Record<string, unknown>> = [];
  const periods = new Map<string, Awaited<ReturnType<typeof periodRow>>>();
  for (const { limit, amount } of applicable) {
    const key = bucketKeyFor(limit, now, subject.endUserId);
    const period = await periodRow(tx, limit.id, key);
    periods.set(limit.id, period);
    const outstanding = limit.scope === "end_user"
      ? await bucketOutstanding(tx, limit.id, subject.endUserId)
      : Number(limit.outstandingReserved);
    const available = Number(limit.amount) - Number(period.consumed) - outstanding;
    if (amount > available) {
      shortfalls.push({ limitId: limit.limitId, name: limit.name, requested: amount, available: Math.max(available, 0) });
    }
  }
  if (shortfalls.length) {
    throw new EffectRejection(
      "impact_limit_exceeded",
      `Not enough allowance: ${shortfalls.map((s) => `${s.name} needs ${s.requested}, has ${s.available}`).join("; ")}.`,
      { shortfalls },
    );
  }
  for (const { limit, amount } of applicable) {
    const period = periods.get(limit.id)!;
    await tx.insert(impactReservations).values({
      workspaceId: subject.workspaceId,
      environmentId: subject.environmentId,
      effectId: effectRowId,
      limitId: limit.id,
      periodKey: period.periodKey,
      dimension: limit.dimension,
      currency: limit.currency,
      amount,
      exposure: "dispatching",
    });
    await tx.update(impactLimitPeriods).set({ reserved: sql`${impactLimitPeriods.reserved} + ${amount}`, updatedAt: now })
      .where(and(eq(impactLimitPeriods.limitId, limit.id), eq(impactLimitPeriods.periodKey, period.periodKey)));
    await tx.update(impactLimits).set({ outstandingReserved: sql`${impactLimits.outstandingReserved} + ${amount}` })
      .where(eq(impactLimits.id, limit.id));
  }
  return applicable.map(({ limit, amount }) => ({ limitId: limit.limitId, amount }));
}

const COUNTS_AS_UNKNOWN = new Set(["unknown", "partial"]);

export function assertActualImpactMatches(declared: ImpactQuantity[], actual: ImpactQuantity[]): void {
  const seen = new Set<string>();
  for (const q of actual) {
    const own = declared.find((d) => d.dimension === q.dimension);
    if (!own) {
      throw new ValidationError(`actualImpact names ${q.dimension}, which this effect does not declare (it declares ${declared.map((d) => d.dimension).join(", ") || "nothing"}).`);
    }
    if (own.dimension === "money" && q.dimension === "money" && q.currency !== own.currency) {
      throw new ValidationError(`actualImpact states money in ${q.currency}; this effect's money is in ${own.currency}.`);
    }
    if (seen.has(q.dimension)) throw new ValidationError(`actualImpact states ${q.dimension} more than once.`);
    seen.add(q.dimension);
  }
}

function actualFor(reservation: ImpactReservation, actual: ImpactQuantity[] | undefined): number | undefined {
  if (!actual) return undefined;
  const q = actual.find((item) => item.dimension === reservation.dimension &&
    (item.dimension !== "money" || item.currency === reservation.currency));
  return q ? q.amount : undefined;
}

export async function applyOutcomeToImpactIn(
  tx: Tx,
  effectRowId: string,
  outcome: "pending" | "succeeded" | "failed" | "unknown",
  partialEffect: PartialEffect,
  actualImpact?: ImpactQuantity[],
): Promise<void> {
  const open = await tx.select({ reservation: impactReservations }).from(impactReservations)
    .where(and(eq(impactReservations.effectId, effectRowId), eq(impactReservations.state, "reserved")));
  if (!open.length) return;
  const limitIds = [...new Set(open.map((row) => row.reservation.limitId))].sort();
  await tx.select({ id: impactLimits.id }).from(impactLimits).where(inArray(impactLimits.id, limitIds))
    .orderBy(asc(impactLimits.id)).for("update");
  const reservations = await tx.select().from(impactReservations)
    .where(and(eq(impactReservations.effectId, effectRowId), eq(impactReservations.state, "reserved")))
    .orderBy(asc(impactReservations.limitId)).for("update");

  for (const r of reservations) {
    const amount = Number(r.amount);
    const wasUnknown = r.exposure !== null && COUNTS_AS_UNKNOWN.has(r.exposure);
    const periodWhere = and(eq(impactLimitPeriods.limitId, r.limitId), eq(impactLimitPeriods.periodKey, r.periodKey));

    let settle: number | null = null;
    let exposure: ImpactReservation["exposure"] = r.exposure;
    if (outcome === "succeeded") {
      settle = Math.min(actualFor(r, actualImpact) ?? amount, amount);
    } else if (outcome === "failed" && partialEffect === "none") {
      settle = 0;
    } else if (outcome === "failed" && partialEffect === "confirmed" && actualImpact) {
      settle = Math.min(actualFor(r, actualImpact) ?? amount, amount);
    } else if (outcome === "failed") {
      exposure = "partial";
    } else if (outcome === "pending") {
      exposure = "pending";
    } else {
      exposure = "unknown";
    }

    if (settle === null) {
      const nowUnknown = exposure !== null && COUNTS_AS_UNKNOWN.has(exposure);
      if (exposure !== r.exposure) {
        await tx.update(impactReservations).set({ exposure }).where(eq(impactReservations.id, r.id));
        if (nowUnknown !== wasUnknown) {
          await tx.update(impactLimitPeriods).set({
            unknownExposure: nowUnknown ? sql`${impactLimitPeriods.unknownExposure} + ${amount}` : sql`${impactLimitPeriods.unknownExposure} - ${amount}`,
            updatedAt: new Date(),
          }).where(periodWhere);
        }
      }
      continue;
    }

    await tx.update(impactReservations).set({
      state: settle > 0 ? "settled" : "released",
      exposure: null,
      settledAmount: settle,
      releasedAmount: amount - settle,
      finishedAt: new Date(),
    }).where(eq(impactReservations.id, r.id));
    await tx.update(impactLimitPeriods).set({
      consumed: sql`${impactLimitPeriods.consumed} + ${settle}`,
      reserved: sql`${impactLimitPeriods.reserved} - ${amount}`,
      ...(wasUnknown ? { unknownExposure: sql`${impactLimitPeriods.unknownExposure} - ${amount}` } : {}),
      updatedAt: new Date(),
    }).where(periodWhere);
    await tx.update(impactLimits).set({ outstandingReserved: sql`${impactLimits.outstandingReserved} - ${amount}` })
      .where(eq(impactLimits.id, r.limitId));
  }
}

export async function releaseUndispatchedIn(tx: Tx, effectRowId: string): Promise<void> {
  await applyOutcomeToImpactIn(tx, effectRowId, "failed", "none");
}

export async function reservationsFor(effectRowId: string) {
  const rows = await db.select({ reservation: impactReservations, limitId: impactLimits.limitId, name: impactLimits.name })
    .from(impactReservations)
    .innerJoin(impactLimits, eq(impactLimits.id, impactReservations.limitId))
    .where(eq(impactReservations.effectId, effectRowId))
    .orderBy(asc(impactLimits.limitId));
  return rows.map(({ reservation: r, limitId, name }) => ({
    limitId, name, dimension: r.dimension, currency: r.currency, period: r.periodKey, amount: Number(r.amount),
    state: r.state, exposure: r.exposure, settled: Number(r.settledAmount), released: Number(r.releasedAmount),
    createdAt: r.createdAt, finishedAt: r.finishedAt,
  }));
}

