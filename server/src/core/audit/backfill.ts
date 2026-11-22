import { and, asc, eq, gt, inArray, isNotNull, ne, type SQL } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { actionInvocations, actions, invocationResolutions } from "../../db/schema/actions.ts";
import { approvalDecisions, approvalPolicyVersions, approvals } from "../../db/schema/approvals.ts";
import { auditEvents } from "../../db/schema/audit.ts";
import { environments } from "../../db/schema/environments.ts";
import { createLogger } from "../../lib/logger.ts";
import { isFeatureEnabled } from "../edition/features.ts";
import { AUDIT_FEATURE, type AuditRecordInput, buildAuditRow } from "./outbox.ts";
import {
  RECORDED_INVOCATION_STATUSES,
  approvalDecidedRecord,
  approvalRequestedRecord,
  approvalVoteRecord,
  haltRecord,
  historicalVoteActor,
  invocationOutcomeRecord,
  policyVersionRecord,
  resolutionRecord,
} from "./records.ts";

const logger = createLogger({ module: "audit-backfill" });

const PAGE = 500;
const BACKFILLED = { backfilled: true } as const;

export interface BackfillOptions {
  workspaceId?: string;
  dryRun?: boolean;
}

export interface BackfillResult {
  sources: Record<string, { built: number; inserted: number }>;
  inserted: number;
}

async function store(records: Array<AuditRecordInput | null>, dryRun: boolean): Promise<{ built: number; inserted: number }> {
  const rows = records.filter((record): record is AuditRecordInput => record !== null).map(buildAuditRow);
  if (rows.length === 0 || dryRun) return { built: rows.length, inserted: 0 };
  const inserted = await db.insert(auditEvents).values(rows).onConflictDoNothing({ target: auditEvents.eventId }).returning({ seq: auditEvents.seq });
  return { built: rows.length, inserted: inserted.length };
}

async function* pages<T extends { id: string }>(fetch: (after: string | null) => Promise<T[]>): AsyncGenerator<T[]> {
  let after: string | null = null;
  for (;;) {
    const rows = await fetch(after);
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < PAGE) return;
    after = rows[rows.length - 1].id;
  }
}

export async function backfillAuditHistory(options: BackfillOptions = {}): Promise<BackfillResult> {
  const result: BackfillResult = { sources: {}, inserted: 0 };
  if (!isFeatureEnabled(AUDIT_FEATURE)) return result;
  const dryRun = options.dryRun === true;
  const tally = (source: string, counts: { built: number; inserted: number }) => {
    const current = result.sources[source] ?? { built: 0, inserted: 0 };
    current.built += counts.built;
    current.inserted += counts.inserted;
    result.sources[source] = current;
    result.inserted += counts.inserted;
  };
  const scope = <C extends { workspaceId: unknown }>(column: C["workspaceId"]) =>
    options.workspaceId ? eq(column as never, options.workspaceId) : undefined;
  const after = (column: unknown, value: string | null): SQL | undefined => (value ? gt(column as never, value) : undefined);

  for await (const rows of pages((cursor) =>
    db.select().from(approvals)
      .where(and(scope(approvals.workspaceId), after(approvals.id, cursor)))
      .orderBy(asc(approvals.id)).limit(PAGE))) {
    tally("approvals", await store(rows.flatMap((row) => [
      approvalRequestedRecord(row, BACKFILLED),
      approvalDecidedRecord(row, BACKFILLED),
    ]), dryRun));
  }

  for await (const rows of pages((cursor) =>
    db.select({ decision: approvalDecisions, approval: approvals, id: approvalDecisions.id })
      .from(approvalDecisions)
      .innerJoin(approvals, eq(approvals.id, approvalDecisions.approvalId))
      .where(and(scope(approvals.workspaceId), after(approvalDecisions.id, cursor)))
      .orderBy(asc(approvalDecisions.id)).limit(PAGE))) {
    tally("votes", await store(rows.map(({ decision, approval }) =>
      approvalVoteRecord(approval, decision, historicalVoteActor(decision), BACKFILLED)), dryRun));
  }

  for await (const rows of pages((cursor) =>
    db.select({ invocation: actionInvocations, actionId: actions.actionId, name: actions.name, id: actionInvocations.id })
      .from(actionInvocations)
      .innerJoin(actions, eq(actions.id, actionInvocations.actionId))
      .where(and(
        scope(actionInvocations.workspaceId),
        inArray(actionInvocations.status, [...RECORDED_INVOCATION_STATUSES]),
        after(actionInvocations.id, cursor),
      ))
      .orderBy(asc(actionInvocations.id)).limit(PAGE))) {
    tally("invocations", await store(rows.map(({ invocation, actionId, name }) =>
      invocationOutcomeRecord(invocation, { actionId, name }, {
        ...BACKFILLED,
        occurredAt: invocation.completedAt ?? invocation.createdAt,
      })), dryRun));
  }

  for await (const rows of pages((cursor) =>
    db.select({ resolution: invocationResolutions, invocationId: actionInvocations.invocationId, name: actions.name, id: invocationResolutions.id })
      .from(invocationResolutions)
      .innerJoin(actionInvocations, eq(actionInvocations.id, invocationResolutions.invocationId))
      .innerJoin(actions, eq(actions.id, actionInvocations.actionId))
      .where(and(scope(invocationResolutions.workspaceId), after(invocationResolutions.id, cursor)))
      .orderBy(asc(invocationResolutions.id)).limit(PAGE))) {
    tally("resolutions", await store(rows.map(({ resolution, invocationId, name }) =>
      resolutionRecord(resolution, { invocationId }, name, BACKFILLED)), dryRun));
  }

  for await (const rows of pages((cursor) =>
    db.select().from(approvalPolicyVersions)
      .where(and(
        scope(approvalPolicyVersions.workspaceId),
        ne(approvalPolicyVersions.operation, "baseline"),
        after(approvalPolicyVersions.id, cursor),
      ))
      .orderBy(asc(approvalPolicyVersions.id)).limit(PAGE))) {
    tally("policyVersions", await store(rows.map((row) => policyVersionRecord(row, BACKFILLED)), dryRun));
  }

  for await (const rows of pages((cursor) =>
    db.select().from(environments)
      .where(and(scope(environments.workspaceId), isNotNull(environments.haltedAt), after(environments.id, cursor)))
      .orderBy(asc(environments.id)).limit(PAGE))) {
    tally("halts", await store(rows.map((row) => haltRecord(row, BACKFILLED)), dryRun));
  }

  logger.info({ ...result, dryRun, workspaceId: options.workspaceId ?? "all" }, "Audit history backfill finished");
  return result;
}
