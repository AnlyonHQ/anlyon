import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AuditEventRow } from "../../db/schema/audit.ts";
import { ApiError } from "../../utils/errors.ts";

export const ARCHIVE_FORMAT = "anlyon.audit.archive.v1" as const;

export interface ArchivedRecord extends Omit<AuditEventRow, "occurredAt" | "recordedAt"> {
  occurredAt: string;
  recordedAt: string;
}

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  workspaceId: string;
  environmentId: string | null;
  day: string;
  order: "occurredAt,sequence";
  recordCount: number;
  firstSequence: number;
  lastSequence: number;
  firstOccurredAt: string;
  lastOccurredAt: string;
  sha256: string;
  contentSha256: string;
  sizeBytes: number;
  createdAt: string;
}

export class AuditArchiveIntegrityError extends ApiError {
  constructor(message: string) {
    super(500, "AUDIT_ARCHIVE_INTEGRITY", message);
    this.name = "AuditArchiveIntegrityError";
  }
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function archiveKeys(workspaceId: string, environmentId: string | null, day: string, firstSeq: number, lastSeq: number) {
  const [yyyy, mm, dd] = day.split("-");
  const base = `audit/v1/${workspaceId}/${environmentId ?? "workspace"}/${yyyy}/${mm}/${dd}/${firstSeq}-${lastSeq}`;
  return { objectKey: `${base}.jsonl.gz`, manifestKey: `${base}.manifest.json` };
}

export function toArchivedRecord(row: AuditEventRow): ArchivedRecord {
  return { ...row, occurredAt: row.occurredAt.toISOString(), recordedAt: row.recordedAt.toISOString() };
}

export function fromArchivedRecord(record: ArchivedRecord): AuditEventRow {
  return { ...record, occurredAt: new Date(record.occurredAt), recordedAt: new Date(record.recordedAt) };
}

export function compareRecords(a: Pick<AuditEventRow, "occurredAt" | "seq">, b: Pick<AuditEventRow, "occurredAt" | "seq">): number {
  return a.occurredAt.getTime() - b.occurredAt.getTime() || a.seq - b.seq;
}

export function buildArchive(rows: AuditEventRow[], now: Date = new Date()): { body: Buffer; manifest: ArchiveManifest; keys: ReturnType<typeof archiveKeys> } {
  if (rows.length === 0) throw new Error("An archive needs at least one record");
  const sorted = [...rows].sort(compareRecords);
  const { workspaceId, environmentId } = sorted[0];
  const day = utcDay(sorted[0].occurredAt);
  for (const row of sorted) {
    if (row.workspaceId !== workspaceId || row.environmentId !== environmentId || utcDay(row.occurredAt) !== day) {
      throw new Error("An archive holds one workspace, one environment and one UTC day");
    }
  }
  const lines = `${sorted.map((row) => JSON.stringify(toArchivedRecord(row))).join("\n")}\n`;
  const body = gzipSync(Buffer.from(lines, "utf8"));
  const seqs = sorted.map((row) => row.seq);
  const firstSeq = Math.min(...seqs);
  const lastSeq = Math.max(...seqs);
  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    workspaceId,
    environmentId,
    day,
    order: "occurredAt,sequence",
    recordCount: sorted.length,
    firstSequence: firstSeq,
    lastSequence: lastSeq,
    firstOccurredAt: sorted[0].occurredAt.toISOString(),
    lastOccurredAt: sorted[sorted.length - 1].occurredAt.toISOString(),
    sha256: sha256(body),
    contentSha256: sha256(lines),
    sizeBytes: body.length,
    createdAt: now.toISOString(),
  };
  return { body, manifest, keys: archiveKeys(workspaceId, environmentId, day, firstSeq, lastSeq) };
}

export function readArchive(body: Buffer, expected: { sha256: string; contentSha256: string; recordCount: number; objectKey: string }): AuditEventRow[] {
  if (sha256(body) !== expected.sha256) {
    throw new AuditArchiveIntegrityError(`Archived audit object ${expected.objectKey} does not match its recorded checksum.`);
  }
  const lines = gunzipSync(body).toString("utf8");
  if (sha256(lines) !== expected.contentSha256) {
    throw new AuditArchiveIntegrityError(`Archived audit object ${expected.objectKey} does not match its recorded content checksum.`);
  }
  const rows = lines.split("\n").filter(Boolean).map((line) => fromArchivedRecord(JSON.parse(line) as ArchivedRecord));
  if (rows.length !== expected.recordCount) {
    throw new AuditArchiveIntegrityError(`Archived audit object ${expected.objectKey} holds ${rows.length} records, not ${expected.recordCount}.`);
  }
  return rows;
}
