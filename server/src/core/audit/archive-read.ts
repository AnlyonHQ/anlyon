import { and, asc, eq, gte, inArray, isNull, lt, type SQL } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { type AuditArchiveRow, type AuditEventRow, auditArchives } from "../../db/schema/audit.ts";
import { endUserErasures } from "../../db/schema/end-user-erasures.ts";
import { ApiError } from "../../utils/errors.ts";
import { ERASED_PREFIX, erasedEndUserId } from "../end-users/identity.ts";
import { type AuditArchiveStore, auditArchiveStore } from "./archive-store.ts";
import { AuditArchiveIntegrityError, readArchive } from "./archive-format.ts";

export class AuditArchiveUnavailableError extends ApiError {
  constructor() {
    super(503, "AUDIT_ARCHIVE_UNAVAILABLE", "Some records in this range are in the audit archive, which this server cannot reach right now. Try again later, or export a more recent range.");
    this.name = "AuditArchiveUnavailableError";
  }
}

export interface ArchiveRange {
  from?: Date;
  to?: Date;
  environmentId?: string;
}

export async function archivesInRange(workspaceId: string, range: ArchiveRange): Promise<AuditArchiveRow[]> {
  const conditions: (SQL | undefined)[] = [
    eq(auditArchives.workspaceId, workspaceId),
    isNull(auditArchives.expiredAt),
    range.from ? gte(auditArchives.lastOccurredAt, range.from) : undefined,
    range.to ? lt(auditArchives.firstOccurredAt, range.to) : undefined,
    range.environmentId ? eq(auditArchives.environmentId, range.environmentId) : undefined,
  ];
  return db
    .select()
    .from(auditArchives)
    .where(and(...conditions))
    .orderBy(asc(auditArchives.day), asc(auditArchives.firstSeq));
}

export async function loadArchive(store: AuditArchiveStore, archive: AuditArchiveRow): Promise<AuditEventRow[]> {
  const body = await store.get(archive.objectKey);
  if (!body) throw new AuditArchiveIntegrityError(`Archived audit object ${archive.objectKey} is missing.`);
  const rows = readArchive(body, archive);
  for (const row of rows) {
    if (row.workspaceId !== archive.workspaceId || row.environmentId !== archive.environmentId) {
      throw new AuditArchiveIntegrityError(`Archived audit object ${archive.objectKey} holds records of another workspace or environment.`);
    }
  }
  return rows;
}

export async function applyErasures(workspaceId: string, rows: AuditEventRow[]): Promise<AuditEventRow[]> {
  const candidates = new Map<string, { environmentId: string; endUserId: string; erasedAs: string }>();
  for (const row of rows) {
    if (!row.endUserId || !row.environmentId || row.endUserId.startsWith(ERASED_PREFIX)) continue;
    const key = `${row.environmentId}|${row.endUserId}`;
    if (!candidates.has(key)) {
      candidates.set(key, { environmentId: row.environmentId, endUserId: row.endUserId, erasedAs: erasedEndUserId(workspaceId, row.endUserId) });
    }
  }
  if (candidates.size === 0) return rows;
  const hashes = [...new Set([...candidates.values()].map((c) => c.erasedAs))];
  const erasures = await db
    .select({ environmentId: endUserErasures.environmentId, erasedAs: endUserErasures.erasedAs, erasedAt: endUserErasures.erasedAt })
    .from(endUserErasures)
    .where(and(eq(endUserErasures.workspaceId, workspaceId), inArray(endUserErasures.erasedAs, hashes)));
  if (erasures.length === 0) return rows;
  const erasedAt = new Map(erasures.map((e) => [`${e.environmentId}|${e.erasedAs}`, e.erasedAt]));
  return rows.map((row) => {
    if (!row.endUserId || !row.environmentId) return row;
    const candidate = candidates.get(`${row.environmentId}|${row.endUserId}`);
    if (!candidate) return row;
    const at = erasedAt.get(`${row.environmentId}|${candidate.erasedAs}`);
    if (!at || row.recordedAt > at) return row;
    return {
      ...row,
      endUserId: candidate.erasedAs,
      resourceId: row.resourceType === "end_user" && row.resourceId === row.endUserId ? candidate.erasedAs : row.resourceId,
    };
  });
}

export function requireArchiveStore(): AuditArchiveStore {
  const store = auditArchiveStore();
  if (!store) throw new AuditArchiveUnavailableError();
  return store;
}
