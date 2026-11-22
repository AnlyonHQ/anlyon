import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.ts";
import { type SignOffRequestRow, signOffRequests } from "../../db/schema/sign-offs.ts";
import { env } from "../../config/env.ts";
import { createLogger } from "../../lib/logger.ts";
import { ApiError, AuthorizationError, ConflictError, NotFoundError } from "../../utils/errors.ts";
import { decryptSecret, encryptSecret } from "../../utils/crypto.ts";
import { type AuditRecordInput, writeAuditEvents } from "../audit/outbox.ts";
import type { AuditActor, StoredAuditContext } from "../audit/event-schema.ts";
import { hasPermission } from "../workspace/permissions.ts";
import { resolveMemberRole } from "../workspace/roles.ts";
import { type Classification, type FieldChange, type GovernanceOperation, renderDiff } from "./classify.ts";
import { digestOf, type GovernanceScope, operationDefinition, type Prepared, type ResourceRef } from "./operations.ts";

const logger = createLogger({ module: "sign-offs" });

export const SIGN_OFF_TTL_HOURS = 24;
export const SIGN_OFF_POLL_SECONDS = 5;
const APPLYING_STALE_MS = 10 * 60 * 1000;

export type PublicSignOffStatus = "pending" | "applied" | "rejected" | "expired" | "cancelled" | "failed";

export interface SignOffRequester {
  type: "api_key" | "oauth_client" | "other";
  keyId: string | null;
  oauthClientId: string | null;
  userId: string | null;
  scopes: string[] | null;
  context?: StoredAuditContext;
}

export interface PublicSignOff {
  object: "sign_off_request";
  id: string;
  status: PublicSignOffStatus;
  operation: string;
  environmentId: string;
  resource: ResourceRef | null;
  summary: string;
  changes: FieldChange[];
  diff: string;
  signOffUrl: string;
  pollUrl: string;
  pollAfterSeconds: number;
  requestedBy: AuditActor;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: { type: "user"; id: string; via: "console" | "email_link" } | null;
  decisionNote: string | null;
  result: unknown;
  error: { code: string; message: string } | null;
}

export function generateSignOffId(): string {
  return `sor_${nanoid(21)}`;
}

export function signOffUrl(signOffId: string): string {
  return `${env.CONSOLE_URL.replace(/\/$/, "")}/sign-offs/${signOffId}`;
}

function requesterActor(row: Pick<SignOffRequestRow, "requestedByType" | "requestedByKeyId" | "requestedByOAuthClientId" | "requestedByUserId">): AuditActor {
  if (row.requestedByType === "api_key") return { type: "api_key", id: row.requestedByKeyId };
  if (row.requestedByType === "oauth_client") return { type: "oauth_client", id: row.requestedByOAuthClientId, onBehalfOf: row.requestedByUserId };
  return { type: "system", id: null };
}

export function toPublicSignOff(row: SignOffRequestRow): PublicSignOff {
  const c = row.classification as unknown as Classification;
  return {
    object: "sign_off_request",
    id: row.signOffId,
    status: row.status === "applying" ? "pending" : row.status,
    operation: row.operation,
    environmentId: row.environmentId,
    resource: row.resource ?? null,
    summary: row.summary,
    changes: c.changes ?? [],
    diff: renderDiff(c.changes ?? []),
    signOffUrl: signOffUrl(row.signOffId),
    pollUrl: `/api/v2/sign-offs/${row.signOffId}`,
    pollAfterSeconds: SIGN_OFF_POLL_SECONDS,
    requestedBy: requesterActor(row),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedBy: row.decidedByUserId && row.decidedVia ? { type: "user", id: row.decidedByUserId, via: row.decidedVia } : null,
    decisionNote: row.decisionNote,
    result: row.result ?? null,
    error: row.error ?? null,
  };
}

const sealContext = (row: { workspaceId: string; environmentId: string; signOffId: string }) => ({
  store: "sign-off" as const, workspaceId: row.workspaceId, environmentId: row.environmentId, name: row.signOffId,
});

function seal(row: { workspaceId: string; environmentId: string; signOffId: string }, input: unknown): string {
  return encryptSecret(JSON.stringify(input ?? {}), env.DELIVERY_SECRET_MASTER_KEY, sealContext(row));
}

function unseal(row: SignOffRequestRow): Record<string, unknown> {
  return JSON.parse(decryptSecret(row.sealedInput, env.DELIVERY_SECRET_MASTER_KEY, sealContext(row))) as Record<string, unknown>;
}

function record(row: SignOffRequestRow, type: string, actor: AuditActor, extra: Record<string, unknown> = {}, context?: StoredAuditContext): AuditRecordInput {
  return {
    workspaceId: row.workspaceId,
    environmentId: row.environmentId,
    type,
    actor,
    resource: { type: "sign_off_request", id: row.signOffId },
    data: {
      signOffId: row.signOffId,
      operation: row.operation,
      summary: row.summary,
      resource: row.resource,
      requestedBy: requesterActor(row),
      changes: (row.classification as unknown as Classification).changes,
      ...extra,
    },
    context: context ?? null,
  };
}

export interface RequestedChange {
  operation: GovernanceOperation;
  target: Record<string, string>;
  input: Record<string, unknown>;
}

export async function requestSignOffIfLoosening(
  scope: GovernanceScope,
  change: RequestedChange,
  requester: SignOffRequester,
): Promise<{ signOff: PublicSignOff; created: boolean } | null> {
  const prepared = await operationDefinition(change.operation).prepare(scope, change.target, change.input);
  if (prepared.passThrough || prepared.classification.direction !== "loosening") return null;
  return createSignOff(scope, change, prepared, requester);
}

async function createSignOff(
  scope: GovernanceScope,
  change: RequestedChange,
  prepared: Prepared,
  requester: SignOffRequester,
): Promise<{ signOff: PublicSignOff; created: boolean }> {
  const requestDigest = digestOf([
    scope.workspaceId, scope.environmentId, change.operation, change.target, change.input,
    requester.type, requester.keyId, requester.oauthClientId, requester.userId,
  ]);
  const existing = await pendingByDigest(requestDigest);
  if (existing) return { signOff: toPublicSignOff(existing), created: false };

  const signOffId = generateSignOffId();
  const now = new Date();
  const values = {
    signOffId,
    workspaceId: scope.workspaceId,
    environmentId: scope.environmentId,
    operation: change.operation,
    status: "pending" as const,
    target: change.target,
    sealedInput: seal({ ...scope, signOffId }, change.input),
    baseDigest: prepared.baseDigest,
    requestDigest,
    classification: prepared.classification as unknown as Record<string, unknown>,
    summary: prepared.summary.slice(0, 500),
    resource: prepared.resource,
    requesterScopes: requester.scopes,
    requestedByType: requester.type,
    requestedByKeyId: requester.keyId,
    requestedByOAuthClientId: requester.oauthClientId,
    requestedByUserId: requester.userId,
    expiresAt: new Date(now.getTime() + SIGN_OFF_TTL_HOURS * 3600_000),
    createdAt: now,
    updatedAt: now,
  };
  try {
    const row = await db.transaction(async (tx) => {
      const [inserted] = await tx.insert(signOffRequests).values(values).returning();
      await writeAuditEvents(tx, [record(inserted, "sign_off.requested", requesterActor(inserted), { expiresAt: inserted.expiresAt.toISOString() }, requester.context)]);
      return inserted;
    });
    void import("./notify.ts")
      .then((notify) => notify.announceSignOff(row))
      .catch((error) => logger.warn({ signOffId, error: error instanceof Error ? error.message : error }, "Sign-off notification failed"));
    return { signOff: toPublicSignOff(row), created: true };
  } catch (error) {
    const raced = await pendingByDigest(requestDigest);
    if (raced) return { signOff: toPublicSignOff(raced), created: false };
    throw error;
  }
}

async function pendingByDigest(requestDigest: string): Promise<SignOffRequestRow | null> {
  const [row] = await db.select().from(signOffRequests)
    .where(and(eq(signOffRequests.requestDigest, requestDigest), inArray(signOffRequests.status, ["pending", "applying"])))
    .limit(1);
  if (!row) return null;
  if (row.status === "pending" && row.expiresAt <= new Date()) {
    await expireRow(row);
    return null;
  }
  return row;
}

export type SignOffReader =
  | { type: "session"; workspaceId: string }
  | { type: "credential"; workspaceId: string; environmentId: string; keyId: string | null; oauthClientId: string | null; userId: string | null };

function readable(row: SignOffRequestRow, reader: SignOffReader): boolean {
  if (row.workspaceId !== reader.workspaceId) return false;
  if (reader.type === "session") return true;
  if (row.environmentId !== reader.environmentId) return false;
  if (reader.keyId) return row.requestedByKeyId === reader.keyId;
  if (reader.oauthClientId) return row.requestedByOAuthClientId === reader.oauthClientId && row.requestedByUserId === reader.userId;
  return false;
}

async function freshRow(row: SignOffRequestRow): Promise<SignOffRequestRow> {
  if (row.status === "pending" && row.expiresAt <= new Date()) return (await expireRow(row)) ?? row;
  if (row.status === "applying" && Date.now() - row.updatedAt.getTime() > APPLYING_STALE_MS) return (await interruptRow(row)) ?? row;
  return row;
}

export async function getSignOffRow(workspaceId: string, signOffId: string): Promise<SignOffRequestRow> {
  const [row] = await db.select().from(signOffRequests)
    .where(and(eq(signOffRequests.workspaceId, workspaceId), eq(signOffRequests.signOffId, signOffId)))
    .limit(1);
  if (!row) throw new NotFoundError("Sign-off request");
  return freshRow(row);
}

export async function getSignOff(signOffId: string, reader: SignOffReader): Promise<PublicSignOff> {
  const row = await getSignOffRow(reader.workspaceId, signOffId);
  if (!readable(row, reader)) throw new NotFoundError("Sign-off request");
  return toPublicSignOff(row);
}

export async function listSignOffs(
  reader: SignOffReader,
  filter: { status?: PublicSignOffStatus; limit?: number } = {},
): Promise<PublicSignOff[]> {
  const conditions = [eq(signOffRequests.workspaceId, reader.workspaceId)];
  if (reader.type === "credential") {
    conditions.push(eq(signOffRequests.environmentId, reader.environmentId));
    if (reader.keyId) conditions.push(eq(signOffRequests.requestedByKeyId, reader.keyId));
    else if (reader.oauthClientId && reader.userId) {
      conditions.push(eq(signOffRequests.requestedByOAuthClientId, reader.oauthClientId), eq(signOffRequests.requestedByUserId, reader.userId));
    } else return [];
  }
  if (filter.status) {
    conditions.push(filter.status === "pending"
      ? inArray(signOffRequests.status, ["pending", "applying"])
      : eq(signOffRequests.status, filter.status));
  }
  const rows = await db.select().from(signOffRequests).where(and(...conditions))
    .orderBy(desc(signOffRequests.createdAt)).limit(Math.min(Math.max(filter.limit ?? 50, 1), 100));
  const fresh = await Promise.all(rows.map(freshRow));
  return fresh
    .filter((row) => !filter.status || toPublicSignOff(row).status === filter.status)
    .map(toPublicSignOff);
}

export interface Decider {
  userId: string;
  via: "console" | "email_link";
  note?: string | null;
  context?: StoredAuditContext;
}

export async function assertMaySignOff(workspaceId: string, userId: string): Promise<void> {
  const resolved = await resolveMemberRole(workspaceId, userId, null);
  if (!resolved) throw new AuthorizationError("You are not a member of this workspace.");
  if (!hasPermission(resolved.workspaceRole, "governance.sign_off")) {
    throw new AuthorizationError("Only a workspace admin can approve or reject a change an agent asked for.");
  }
}

function notPending(row: SignOffRequestRow): ApiError {
  const status = toPublicSignOff(row).status;
  return new ApiError(409, "SIGN_OFF_NOT_PENDING", `This request is ${status === "pending" ? "being applied" : status} and can no longer be decided.`, { status });
}

export async function rejectSignOff(workspaceId: string, signOffId: string, decider: Decider): Promise<PublicSignOff> {
  await assertMaySignOff(workspaceId, decider.userId);
  const current = await getSignOffRow(workspaceId, signOffId);
  if (current.status !== "pending") throw notPending(current);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx.update(signOffRequests)
      .set({ status: "rejected", decidedByUserId: decider.userId, decidedVia: decider.via, decisionNote: decider.note ?? null, decidedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(signOffRequests.id, current.id), eq(signOffRequests.status, "pending")))
      .returning();
    if (!updated) return null;
    await writeAuditEvents(tx, [record(updated, "sign_off.rejected", { type: "user", id: decider.userId }, { via: decider.via, note: decider.note ?? null }, decider.context)]);
    return updated;
  });
  if (!row) throw notPending(await getSignOffRow(workspaceId, signOffId));
  return toPublicSignOff(row);
}

export async function approveSignOff(workspaceId: string, signOffId: string, decider: Decider): Promise<PublicSignOff> {
  await assertMaySignOff(workspaceId, decider.userId);
  const current = await getSignOffRow(workspaceId, signOffId);
  if (current.status !== "pending") throw notPending(current);

  const [claimed] = await db.update(signOffRequests)
    .set({ status: "applying", decidedByUserId: decider.userId, decidedVia: decider.via, decisionNote: decider.note ?? null, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(signOffRequests.id, current.id), eq(signOffRequests.status, "pending")))
    .returning();
  if (!claimed) throw notPending(await getSignOffRow(workspaceId, signOffId));

  const scope = { workspaceId: claimed.workspaceId, environmentId: claimed.environmentId };
  const definition = operationDefinition(claimed.operation as GovernanceOperation);
  let outcome: { status: "applied"; result: unknown } | { status: "failed"; error: { code: string; message: string } };
  try {
    const input = unseal(claimed);
    const now = await definition.prepare(scope, claimed.target, input);
    if (now.baseDigest !== claimed.baseDigest) {
      outcome = { status: "failed", error: { code: "SIGN_OFF_STALE", message: "What this change applies to was changed after it was requested. Nothing was applied. Ask for it again." } };
    } else {
      const result = await definition.apply(scope, claimed.target, input, {
        signOffId: claimed.signOffId,
        approverUserId: decider.userId,
        requesterScopes: claimed.requesterScopes ?? null,
        requestedBy: requesterActor(claimed),
        prepared: now,
      });
      outcome = { status: "applied", result: JSON.parse(JSON.stringify(result ?? null)) };
    }
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "SIGN_OFF_APPLY_FAILED";
    const message = error instanceof ApiError ? error.message : "The change could not be applied. Nothing was changed.";
    if (!(error instanceof ApiError)) logger.error({ signOffId, error: error instanceof Error ? error.message : error }, "Sign-off apply failed");
    outcome = { status: "failed", error: { code, message } };
  }

  const row = await db.transaction(async (tx) => {
    const [updated] = await tx.update(signOffRequests)
      .set({
        status: outcome.status,
        result: outcome.status === "applied" ? outcome.result : null,
        error: outcome.status === "failed" ? outcome.error : null,
        updatedAt: new Date(),
      })
      .where(and(eq(signOffRequests.id, claimed.id), eq(signOffRequests.status, "applying")))
      .returning();
    if (!updated) return null;
    await writeAuditEvents(tx, [record(updated, outcome.status === "applied" ? "sign_off.approved" : "sign_off.failed", { type: "user", id: decider.userId }, {
      via: decider.via, note: decider.note ?? null, applied: outcome.status === "applied",
      ...(outcome.status === "failed" ? { error: outcome.error } : {}),
    }, decider.context)]);
    return updated;
  });
  if (!row) throw notPending(await getSignOffRow(workspaceId, signOffId));
  return toPublicSignOff(row);
}

export async function cancelSignOff(signOffId: string, reader: Extract<SignOffReader, { type: "credential" }>, context?: StoredAuditContext): Promise<PublicSignOff> {
  const current = await getSignOffRow(reader.workspaceId, signOffId);
  if (!readable(current, reader)) throw new NotFoundError("Sign-off request");
  if (current.status !== "pending") throw notPending(current);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx.update(signOffRequests)
      .set({ status: "cancelled", decidedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(signOffRequests.id, current.id), eq(signOffRequests.status, "pending")))
      .returning();
    if (!updated) return null;
    await writeAuditEvents(tx, [record(updated, "sign_off.cancelled", requesterActor(updated), {}, context)]);
    return updated;
  });
  if (!row) throw new ConflictError("This request can no longer be cancelled.");
  return toPublicSignOff(row);
}

async function expireRow(row: SignOffRequestRow): Promise<SignOffRequestRow | null> {
  return db.transaction(async (tx) => {
    const [updated] = await tx.update(signOffRequests)
      .set({ status: "expired", decidedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(signOffRequests.id, row.id), eq(signOffRequests.status, "pending")))
      .returning();
    if (!updated) return null;
    await writeAuditEvents(tx, [record(updated, "sign_off.expired", { type: "system", id: null }, { ttlHours: SIGN_OFF_TTL_HOURS })]);
    return updated;
  });
}

async function interruptRow(row: SignOffRequestRow): Promise<SignOffRequestRow | null> {
  return db.transaction(async (tx) => {
    const error = { code: "SIGN_OFF_INTERRUPTED", message: "Applying this change was interrupted. Check whether it took effect before asking again." };
    const [updated] = await tx.update(signOffRequests)
      .set({ status: "failed", error, updatedAt: new Date() })
      .where(and(eq(signOffRequests.id, row.id), eq(signOffRequests.status, "applying")))
      .returning();
    if (!updated) return null;
    await writeAuditEvents(tx, [record(updated, "sign_off.failed", { type: "system", id: null }, { error })]);
    return updated;
  });
}

export async function sweepSignOffs(batchSize = 200): Promise<number> {
  const due = await db.select().from(signOffRequests)
    .where(and(eq(signOffRequests.status, "pending"), lt(signOffRequests.expiresAt, new Date())))
    .limit(batchSize);
  for (const row of due) await expireRow(row);
  const stuck = await db.select().from(signOffRequests)
    .where(and(eq(signOffRequests.status, "applying"), lt(signOffRequests.updatedAt, new Date(Date.now() - APPLYING_STALE_MS))))
    .limit(batchSize);
  for (const row of stuck) await interruptRow(row);
  if (due.length || stuck.length) logger.info({ expired: due.length, interrupted: stuck.length }, "Swept sign-off requests");
  return due.length + stuck.length;
}
