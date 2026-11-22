import { and, asc, count, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { env } from "../../config/env.ts";
import { legacyZodIssues } from "../../utils/zod-compat.ts";
import { db } from "../../db/index.ts";
import {
  type AuditArchiveRow,
  type AuditDeadLetterRow,
  type AuditEventRow,
  type AuditSinkRow,
  auditEvents,
  auditSettings,
  auditSinkDeadLetters,
  auditSinks,
} from "../../db/schema/audit.ts";
import { environments } from "../../db/schema/environments.ts";
import { decryptSecret, encryptSecret, generateDeliverySecret } from "../../utils/crypto.ts";
import { ConflictError, NotFoundError, ValidationError } from "../../utils/errors.ts";
import { matchEventType } from "../events/filters.ts";
import { AUDIT_SCHEMA, type AuditActor, type AuditExportEvent, type StoredAuditContext, toExportEvent } from "./event-schema.ts";
import { type AuditRecordInput, generateAuditEventId, writeAuditEvents } from "./outbox.ts";
import { applyErasures, archivesInRange, loadArchive, requireArchiveStore } from "./archive-read.ts";
import { compareRecords } from "./archive-format.ts";
import { retentionView } from "./lifecycle.ts";
import { privateDestinationsOffered, privateDestinationsRefusal } from "../instance/network.ts";
import {
  CONFIG_SCHEMAS,
  CREDENTIAL_INPUT_SCHEMAS,
  type SinkTarget,
  type SinkType,
  assertDestination,
  destinationUrls,
} from "./sinks/config.ts";
import { type Fetcher, type SendResult, sendToSink } from "./sinks/send.ts";

export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;
export const MAX_SINKS_PER_WORKSPACE = 10;

export interface AuditCaller {
  actor: AuditActor;
  context?: StoredAuditContext;
}

function credentialContext(workspaceId: string, sinkId: string) {
  return { store: "audit-sink" as const, workspaceId, name: sinkId };
}

export function encryptSinkCredentials(workspaceId: string, sinkId: string, credentials: Record<string, unknown>): string {
  return encryptSecret(JSON.stringify(credentials), env.DELIVERY_SECRET_MASTER_KEY, credentialContext(workspaceId, sinkId));
}

export function sinkTarget(row: Pick<AuditSinkRow, "workspaceId" | "sinkId" | "type" | "config" | "credentialsEncrypted">): SinkTarget {
  const credentials = JSON.parse(
    decryptSecret(row.credentialsEncrypted, env.DELIVERY_SECRET_MASTER_KEY, credentialContext(row.workspaceId, row.sinkId)),
  );
  return { type: row.type, config: row.config, credentials } as SinkTarget;
}

export function credentialsHint(type: SinkType, credentials: Record<string, unknown>): string {
  const tail = (value: unknown) => (typeof value === "string" && value.length > 8 ? `…${value.slice(-4)}` : "…");
  switch (type) {
    case "webhook":
      return `${String(credentials.signingSecret ?? "").slice(0, 12)}…`;
    case "s3":
      return `${String(credentials.accessKeyId ?? "").slice(0, 4)}${tail(credentials.accessKeyId)}`;
    case "datadog":
      return tail(credentials.apiKey);
    case "splunk":
      return tail(credentials.token);
  }
}

export interface PublicSink {
  sinkId: string;
  name: string;
  type: SinkType;
  config: Record<string, unknown>;
  credentialsHint: string | null;
  enabled: boolean;
  eventTypes: string[];
  environmentIds: string[] | null;
  includeHistory: boolean;
  status: "active" | "retrying" | "disabled";
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  deliveredCount: number;
  openDeadLetters: number;
  createdAt: string;
  updatedAt: string;
}

export function toPublicSink(row: AuditSinkRow, openDeadLetters = 0): PublicSink {
  return {
    sinkId: row.sinkId,
    name: row.name,
    type: row.type,
    config: row.config,
    credentialsHint: row.credentialsHint,
    enabled: row.enabled,
    eventTypes: row.eventTypes,
    environmentIds: row.environmentIds ?? null,
    includeHistory: row.includeHistory,
    status: !row.enabled ? "disabled" : row.attempts > 0 ? "retrying" : "active",
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    lastError: row.lastError,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    deliveredCount: row.deliveredCount,
    openDeadLetters,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CreateSinkInput {
  name: string;
  type: SinkType;
  config: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  enabled?: boolean;
  eventTypes?: string[];
  environmentIds?: string[] | null;
  startFrom?: "now" | "beginning";
  includeHistory?: boolean;
}

export interface UpdateSinkInput {
  name?: string;
  enabled?: boolean;
  eventTypes?: string[];
  environmentIds?: string[] | null;
  config?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  rotateSigningSecret?: boolean;
  includeHistory?: boolean;
}

function parseConfig(type: SinkType, config: unknown): Record<string, unknown> {
  const result = CONFIG_SCHEMAS[type].safeParse(config);
  if (!result.success) throw new ValidationError(`Invalid ${type} sink configuration`, legacyZodIssues(result.error.issues));
  return result.data as Record<string, unknown>;
}

function parseCredentials(type: Exclude<SinkType, "webhook">, credentials: unknown): Record<string, unknown> {
  const result = CREDENTIAL_INPUT_SCHEMAS[type].safeParse(credentials);
  if (!result.success) throw new ValidationError(`Invalid ${type} sink credentials`, legacyZodIssues(result.error.issues));
  return result.data as Record<string, unknown>;
}

async function assertEnvironments(workspaceId: string, environmentIds: string[] | null | undefined): Promise<void> {
  if (!environmentIds || environmentIds.length === 0) return;
  const rows = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.workspaceId, workspaceId), inArray(environments.id, environmentIds)));
  if (rows.length !== new Set(environmentIds).size) {
    throw new ValidationError("environmentIds names an environment that is not in this workspace");
  }
}

async function openDeadLetterCounts(sinkRowIds: string[]): Promise<Map<string, number>> {
  if (sinkRowIds.length === 0) return new Map();
  const rows = await db
    .select({ sinkId: auditSinkDeadLetters.sinkId, total: count() })
    .from(auditSinkDeadLetters)
    .where(and(inArray(auditSinkDeadLetters.sinkId, sinkRowIds), isNull(auditSinkDeadLetters.redeliveredAt)))
    .groupBy(auditSinkDeadLetters.sinkId);
  return new Map(rows.map((row) => [row.sinkId, Number(row.total)]));
}

async function loadSink(workspaceId: string, sinkId: string): Promise<AuditSinkRow> {
  const [row] = await db
    .select()
    .from(auditSinks)
    .where(and(eq(auditSinks.workspaceId, workspaceId), eq(auditSinks.sinkId, sinkId)));
  if (!row) throw new NotFoundError("Audit sink");
  return row;
}

export async function listSinks(workspaceId: string): Promise<PublicSink[]> {
  const rows = await db.select().from(auditSinks).where(eq(auditSinks.workspaceId, workspaceId)).orderBy(asc(auditSinks.createdAt));
  const counts = await openDeadLetterCounts(rows.map((row) => row.id));
  return rows.map((row) => toPublicSink(row, counts.get(row.id) ?? 0));
}

export async function getSink(workspaceId: string, sinkId: string): Promise<PublicSink> {
  const row = await loadSink(workspaceId, sinkId);
  const counts = await openDeadLetterCounts([row.id]);
  return toPublicSink(row, counts.get(row.id) ?? 0);
}

function sinkAuditData(row: Pick<AuditSinkRow, "sinkId" | "name" | "type" | "config" | "enabled" | "eventTypes" | "environmentIds" | "includeHistory">) {
  return {
    sinkId: row.sinkId, name: row.name, sinkType: row.type, config: row.config,
    enabled: row.enabled, eventTypes: row.eventTypes, environmentIds: row.environmentIds ?? null,
    includeHistory: row.includeHistory,
  };
}

function sinkRecord(type: string, workspaceId: string, sinkId: string, caller: AuditCaller, data: Record<string, unknown>): AuditRecordInput {
  return { workspaceId, type, actor: caller.actor, context: caller.context, resource: { type: "audit_sink", id: sinkId }, data };
}

export async function privateNetworkAllowed(workspaceId: string): Promise<boolean> {
  if (!privateDestinationsOffered()) return false;
  const [row] = await db
    .select({ allow: auditSettings.allowPrivateDestinations })
    .from(auditSettings)
    .where(eq(auditSettings.workspaceId, workspaceId));
  return row?.allow === true;
}

async function assertSinkDestinations(workspaceId: string, type: SinkType, config: Record<string, unknown>): Promise<void> {
  const urls = destinationUrls(type, config);
  if (urls.length === 0) return;
  const allowPrivate = await privateNetworkAllowed(workspaceId);
  for (const url of urls) assertDestination(url, allowPrivate);
}

export async function createSink(
  workspaceId: string,
  input: CreateSinkInput,
  caller: AuditCaller,
): Promise<{ sink: PublicSink; signingSecret?: string }> {
  const config = parseConfig(input.type, input.config);
  let credentials: Record<string, unknown>;
  let signingSecret: string | undefined;
  if (input.type === "webhook") {
    signingSecret = generateDeliverySecret().secret;
    credentials = { signingSecret };
  } else {
    credentials = parseCredentials(input.type, input.credentials);
  }
  await assertEnvironments(workspaceId, input.environmentIds);
  await assertSinkDestinations(workspaceId, input.type, config);

  const [{ total }] = await db.select({ total: count() }).from(auditSinks).where(eq(auditSinks.workspaceId, workspaceId));
  if (Number(total) >= MAX_SINKS_PER_WORKSPACE) {
    throw new ConflictError(`A workspace can have at most ${MAX_SINKS_PER_WORKSPACE} audit sinks.`);
  }

  const sinkId = `asink_${nanoid(21)}`;
  const [cursor] = (
    await db.execute(sql`select (pg_snapshot_xmin(pg_current_snapshot())::text)::bigint - 1 as tx`)
  ).rows as Array<{ tx: string | number }>;
  const fromBeginning = input.startFrom === "beginning";
  const row = await db.transaction(async (tx) => {
  const [created] = await tx
    .insert(auditSinks)
    .values({
      sinkId,
      workspaceId,
      name: input.name,
      type: input.type,
      config,
      credentialsEncrypted: encryptSinkCredentials(workspaceId, sinkId, credentials),
      credentialsHint: credentialsHint(input.type, credentials),
      enabled: input.enabled ?? true,
      eventTypes: input.eventTypes && input.eventTypes.length > 0 ? input.eventTypes : ["*"],
      environmentIds: input.environmentIds && input.environmentIds.length > 0 ? input.environmentIds : null,
      cursorTxId: fromBeginning ? 0 : Number(cursor.tx),
      cursorSeq: fromBeginning ? 0 : Number.MAX_SAFE_INTEGER,
      includeHistory: input.includeHistory ?? false,
      createdBy: caller.actor.id,
    })
    .returning();
  await writeAuditEvents(tx, [sinkRecord("audit.sink.created", workspaceId, sinkId, caller,
    { ...sinkAuditData(created), startFrom: input.startFrom ?? "now" })]);
  return created;
  });
  return { sink: toPublicSink(row), signingSecret };
}

export async function updateSink(
  workspaceId: string,
  sinkId: string,
  input: UpdateSinkInput,
  caller: AuditCaller,
): Promise<{ sink: PublicSink; signingSecret?: string }> {
  const row = await loadSink(workspaceId, sinkId);
  const patch: Partial<typeof auditSinks.$inferInsert> = { updatedAt: new Date() };
  const changed: string[] = [];
  let signingSecret: string | undefined;

  if (input.name !== undefined) { patch.name = input.name; changed.push("name"); }
  if (input.enabled !== undefined) {
    patch.enabled = input.enabled;
    changed.push("enabled");
    if (input.enabled && !row.enabled) { patch.attempts = 0; patch.nextAttemptAt = new Date(); }
  }
  if (input.eventTypes !== undefined) { patch.eventTypes = input.eventTypes.length > 0 ? input.eventTypes : ["*"]; changed.push("eventTypes"); }
  if (input.environmentIds !== undefined) {
    await assertEnvironments(workspaceId, input.environmentIds);
    patch.environmentIds = input.environmentIds && input.environmentIds.length > 0 ? input.environmentIds : null;
    changed.push("environmentIds");
  }
  if (input.config !== undefined) {
    patch.config = parseConfig(row.type, input.config);
    await assertSinkDestinations(workspaceId, row.type, patch.config);
    changed.push("config");
  }
  if (input.includeHistory !== undefined) { patch.includeHistory = input.includeHistory; changed.push("includeHistory"); }
  if (input.credentials !== undefined) {
    if (row.type === "webhook") throw new ValidationError("A webhook sink's secret is generated. Use rotateSigningSecret.");
    const credentials = parseCredentials(row.type, input.credentials);
    patch.credentialsEncrypted = encryptSinkCredentials(workspaceId, row.sinkId, credentials);
    patch.credentialsHint = credentialsHint(row.type, credentials);
    changed.push("credentials");
  }
  if (input.rotateSigningSecret) {
    if (row.type !== "webhook") throw new ValidationError("Only a webhook sink has a signing secret.");
    signingSecret = generateDeliverySecret().secret;
    patch.credentialsEncrypted = encryptSinkCredentials(workspaceId, row.sinkId, { signingSecret });
    patch.credentialsHint = credentialsHint("webhook", { signingSecret });
    changed.push("signingSecret");
  }
  if (changed.some((field) => field === "config" || field === "credentials" || field === "signingSecret")) {
    patch.nextAttemptAt = new Date();
  }

  const updated = await db.transaction(async (tx) => {
    const [changedRow] = await tx.update(auditSinks).set(patch).where(eq(auditSinks.id, row.id)).returning();
    await writeAuditEvents(tx, [sinkRecord("audit.sink.updated", workspaceId, sinkId, caller, { ...sinkAuditData(changedRow), changed })]);
    return changedRow;
  });
  const counts = await openDeadLetterCounts([updated.id]);
  return { sink: toPublicSink(updated, counts.get(updated.id) ?? 0), signingSecret };
}

export async function deleteSink(workspaceId: string, sinkId: string, caller: AuditCaller): Promise<void> {
  const row = await loadSink(workspaceId, sinkId);
  await db.transaction(async (tx) => {
    await tx.delete(auditSinks).where(eq(auditSinks.id, row.id));
    await writeAuditEvents(tx, [sinkRecord("audit.sink.deleted", workspaceId, sinkId, caller, sinkAuditData(row))]);
  });
}

export function testEvent(workspaceId: string, caller: AuditCaller): AuditExportEvent {
  return {
    schema: AUDIT_SCHEMA,
    id: generateAuditEventId(),
    sequence: 0,
    type: "audit.test",
    category: "audit",
    occurredAt: new Date().toISOString(),
    workspaceId,
    environmentId: null,
    actor: caller.actor,
    resource: null,
    outcome: null,
    data: { message: "Test event from Anlyon. Safe to discard." },
    context: null,
    test: true,
  };
}

export async function sendTestEvent(workspaceId: string, sinkId: string, caller: AuditCaller, fetcher?: Fetcher): Promise<SendResult> {
  const row = await loadSink(workspaceId, sinkId);
  const event = testEvent(workspaceId, caller);
  return sendToSink(sinkTarget(row), [event], {
    batchId: `test_${nanoid(12)}`, fetcher, allowPrivateNetwork: await privateNetworkAllowed(workspaceId),
  });
}

export interface PublicDeadLetter {
  id: string;
  eventCount: number;
  firstEventId: string;
  lastEventId: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  lastRetryAt: string | null;
  redeliveredAt: string | null;
}

function toPublicDeadLetter(row: AuditDeadLetterRow): PublicDeadLetter {
  return {
    id: row.id, eventCount: row.eventCount, firstEventId: row.firstEventId, lastEventId: row.lastEventId,
    attempts: row.attempts, lastError: row.lastError, createdAt: row.createdAt.toISOString(),
    lastRetryAt: row.lastRetryAt?.toISOString() ?? null, redeliveredAt: row.redeliveredAt?.toISOString() ?? null,
  };
}

export async function listDeadLetters(workspaceId: string, sinkId: string): Promise<PublicDeadLetter[]> {
  const sink = await loadSink(workspaceId, sinkId);
  const rows = await db
    .select()
    .from(auditSinkDeadLetters)
    .where(eq(auditSinkDeadLetters.sinkId, sink.id))
    .orderBy(desc(auditSinkDeadLetters.createdAt))
    .limit(100);
  return rows.map(toPublicDeadLetter);
}

export async function deadLetterEvents(sink: AuditSinkRow, letter: AuditDeadLetterRow): Promise<AuditEventRow[]> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(
      eq(auditEvents.workspaceId, sink.workspaceId),
      sql`(${auditEvents.txId}, ${auditEvents.seq}) >= (${letter.fromTxId}, ${letter.fromSeq})`,
      sql`(${auditEvents.txId}, ${auditEvents.seq}) <= (${letter.toTxId}, ${letter.toSeq})`,
    ))
    .orderBy(asc(auditEvents.txId), asc(auditEvents.seq));
  return rows.filter((row) => sinkTakes(sink, row));
}

export async function redeliverDeadLetter(
  workspaceId: string,
  sinkId: string,
  deadLetterId: string,
  caller: AuditCaller,
  fetcher?: Fetcher,
): Promise<{ deadLetter: PublicDeadLetter; result: SendResult }> {
  const sink = await loadSink(workspaceId, sinkId);
  const [letter] = await db
    .select()
    .from(auditSinkDeadLetters)
    .where(and(eq(auditSinkDeadLetters.id, deadLetterId), eq(auditSinkDeadLetters.sinkId, sink.id)));
  if (!letter) throw new NotFoundError("Dead letter");
  if (letter.redeliveredAt) throw new ConflictError("This dead letter was already redelivered.");

  const rows = await deadLetterEvents(sink, letter);
  const result: SendResult = rows.length === 0
    ? { ok: true, status: null, error: null, durationMs: 0 }
    : await sendToSink(sinkTarget(sink), rows.map(toExportEvent), {
      batchId: `dl_${letter.id}`, fetcher, allowPrivateNetwork: await privateNetworkAllowed(workspaceId),
    });
  const now = new Date();
  const updated = await db.transaction(async (tx) => {
    const [marked] = await tx
      .update(auditSinkDeadLetters)
      .set(result.ok
        ? { redeliveredAt: now, lastRetryAt: now }
        : { lastRetryAt: now, lastError: result.error, attempts: letter.attempts + 1 })
      .where(eq(auditSinkDeadLetters.id, letter.id))
      .returning();
    if (result.ok) {
      await writeAuditEvents(tx, [sinkRecord("audit.dead_letter.redelivered", workspaceId, sinkId, caller,
        { deadLetterId: letter.id, eventCount: rows.length, firstEventId: letter.firstEventId, lastEventId: letter.lastEventId })]);
    }
    return marked;
  });
  return { deadLetter: toPublicDeadLetter(updated), result };
}

export function sinkTakes(
  sink: Pick<AuditSinkRow, "eventTypes" | "environmentIds" | "includeHistory">,
  row: Pick<AuditEventRow, "type" | "environmentId" | "backfilled">,
): boolean {
  if (row.backfilled && !sink.includeHistory) return false;
  if (!matchEventType(sink.eventTypes, row.type)) return false;
  if (sink.environmentIds && sink.environmentIds.length > 0) {
    return row.environmentId === null || sink.environmentIds.includes(row.environmentId);
  }
  return true;
}

export interface AuditEventFilter {
  from?: Date;
  to?: Date;
  environmentId?: string;
  types?: string[];
  category?: string;
  action?: string;
  endUserId?: string;
  onlyEnvironmentId?: string;
}

function filterConditions(workspaceId: string, filter: AuditEventFilter): SQL[] {
  const conditions: SQL[] = [eq(auditEvents.workspaceId, workspaceId)];
  if (filter.from) conditions.push(gte(auditEvents.occurredAt, filter.from));
  if (filter.to) conditions.push(lt(auditEvents.occurredAt, filter.to));
  if (filter.onlyEnvironmentId) conditions.push(eq(auditEvents.environmentId, filter.onlyEnvironmentId));
  if (filter.environmentId) conditions.push(eq(auditEvents.environmentId, filter.environmentId));
  if (filter.category) conditions.push(eq(auditEvents.category, filter.category));
  if (filter.endUserId) conditions.push(eq(auditEvents.endUserId, filter.endUserId));
  if (filter.types && filter.types.length > 0) {
    const typeConditions = filter.types.map((pattern) => {
      if (pattern === "*") return sql`true`;
      if (pattern.endsWith(".*")) return sql`${auditEvents.type} like ${`${escapeLike(pattern.slice(0, -1))}%`}`;
      return eq(auditEvents.type, pattern);
    });
    conditions.push(or(...typeConditions) as SQL);
  }
  if (filter.action) {
    conditions.push(sql`(${auditEvents.data}->>'actionName' = ${filter.action} or ${auditEvents.data}->>'actionId' = ${filter.action})`);
  }
  return conditions;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const EVENTS_PAGE_DEFAULT = 50;
export const EVENTS_PAGE_MAX = 200;

export async function listAuditEvents(
  workspaceId: string,
  filter: AuditEventFilter,
  page: { limit?: number; before?: number } = {},
): Promise<{ events: AuditExportEvent[]; nextBefore: number | null }> {
  const limit = Math.min(page.limit ?? EVENTS_PAGE_DEFAULT, EVENTS_PAGE_MAX);
  const conditions = filterConditions(workspaceId, filter);
  if (page.before !== undefined) conditions.push(lt(auditEvents.seq, page.before));
  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.seq))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  return {
    events: pageRows.map(toExportEvent),
    nextBefore: rows.length > limit ? pageRows[pageRows.length - 1].seq : null,
  };
}

const EXPORT_CHUNK = 1000;
export const EXPORT_MAX_DAYS = 366;

export async function* iterateAuditEvents(workspaceId: string, filter: AuditEventFilter): AsyncGenerator<AuditExportEvent[]> {
  const archives = await archivesInRange(workspaceId, { from: filter.from, to: filter.to, environmentId: filter.onlyEnvironmentId ?? filter.environmentId });
  if (archives.length === 0) {
    yield* iterateStored(workspaceId, filter);
    return;
  }
  const store = requireArchiveStore();
  const byDay = new Map<string, AuditArchiveRow[]>();
  for (const archive of archives) byDay.set(archive.day, [...(byDay.get(archive.day) ?? []), archive]);
  let cursor = filter.from;
  for (const [day, objects] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dayStart = new Date(`${day}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    if (!cursor || cursor < dayStart) yield* iterateStored(workspaceId, { ...filter, from: cursor, to: earlier(dayStart, filter.to) });
    const from = later(dayStart, filter.from);
    const to = earlier(dayEnd, filter.to);
    const archived: AuditEventRow[] = [];
    for (const archive of objects) archived.push(...(await loadArchive(store, archive)));
    const rows = (await applyErasures(workspaceId, archived)).filter((row) => matchesFilter(row, { ...filter, from, to }));
    const seen = new Set(rows.map((row) => row.seq));
    for await (const chunk of iterateStoredRows(workspaceId, { ...filter, from, to })) {
      for (const row of chunk) if (!seen.has(row.seq)) rows.push(row);
    }
    rows.sort(compareRecords);
    for (let i = 0; i < rows.length; i += EXPORT_CHUNK) yield rows.slice(i, i + EXPORT_CHUNK).map(toExportEvent);
    cursor = to;
  }
  if (!filter.to || !cursor || cursor < filter.to) yield* iterateStored(workspaceId, { ...filter, from: cursor });
}

export async function assertExportReadable(workspaceId: string, filter: AuditEventFilter): Promise<void> {
  const archives = await archivesInRange(workspaceId, { from: filter.from, to: filter.to, environmentId: filter.onlyEnvironmentId ?? filter.environmentId });
  if (archives.length > 0) requireArchiveStore();
}

function later(a: Date, b: Date | undefined): Date {
  return b && b > a ? b : a;
}

function earlier(a: Date, b: Date | undefined): Date {
  return b && b < a ? b : a;
}

function matchesFilter(row: AuditEventRow, filter: AuditEventFilter): boolean {
  if (filter.from && row.occurredAt < filter.from) return false;
  if (filter.to && row.occurredAt >= filter.to) return false;
  if (filter.onlyEnvironmentId && row.environmentId !== filter.onlyEnvironmentId) return false;
  if (filter.environmentId && row.environmentId !== filter.environmentId) return false;
  if (filter.category && row.category !== filter.category) return false;
  if (filter.endUserId && row.endUserId !== filter.endUserId) return false;
  if (filter.types && filter.types.length > 0 && !filter.types.some((pattern) =>
    pattern === "*" || (pattern.endsWith(".*") ? row.type.startsWith(pattern.slice(0, -1)) : row.type === pattern))) return false;
  if (filter.action) {
    const data = row.data as Record<string, unknown>;
    if (data.actionName !== filter.action && data.actionId !== filter.action) return false;
  }
  return true;
}

async function* iterateStored(workspaceId: string, filter: AuditEventFilter): AsyncGenerator<AuditExportEvent[]> {
  for await (const rows of iterateStoredRows(workspaceId, filter)) yield rows.map(toExportEvent);
}

async function* iterateStoredRows(workspaceId: string, filter: AuditEventFilter): AsyncGenerator<AuditEventRow[]> {
  let after: { occurredAt: Date; seq: number } | null = null;
  for (;;) {
    const conditions = filterConditions(workspaceId, filter);
    if (after) {
      conditions.push(sql`(${auditEvents.occurredAt}, ${auditEvents.seq}) > (${after.occurredAt.toISOString()}::timestamptz, ${after.seq})`);
    }
    const rows = await db
      .select()
      .from(auditEvents)
      .where(and(...conditions))
      .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.seq))
      .limit(EXPORT_CHUNK);
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < EXPORT_CHUNK) return;
    const last = rows[rows.length - 1];
    after = { occurredAt: last.occurredAt, seq: last.seq };
  }
}

export interface PublicAuditSettings {
  retentionDays: number | null;
  planRetentionMonths: number | null;
  retentionGraceUntil: string | null;
  hotDays: number;
  archiveAvailable: boolean;
  minRetentionDays: number;
  maxRetentionDays: number;
  allowPrivateDestinations: boolean;
  privateDestinationsAvailable: boolean;
  schema: typeof AUDIT_SCHEMA;
  updatedAt: string | null;
}

export async function getAuditSettings(workspaceId: string): Promise<PublicAuditSettings> {
  const [row] = await db.select().from(auditSettings).where(eq(auditSettings.workspaceId, workspaceId));
  return {
    retentionDays: row?.retentionDays ?? null,
    ...(await retentionView(workspaceId)),
    minRetentionDays: MIN_RETENTION_DAYS,
    maxRetentionDays: MAX_RETENTION_DAYS,
    allowPrivateDestinations: row?.allowPrivateDestinations ?? false,
    privateDestinationsAvailable: privateDestinationsOffered(),
    schema: AUDIT_SCHEMA,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export async function updateAuditSettings(
  workspaceId: string,
  input: { retentionDays?: number | null; allowPrivateDestinations?: boolean },
  caller: AuditCaller,
): Promise<PublicAuditSettings> {
  const days = input.retentionDays;
  if (days !== undefined && days !== null && (!Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS)) {
    throw new ValidationError(`retentionDays must be a whole number from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}, or null to keep records for the plan's retention.`);
  }
  const refusal = privateDestinationsRefusal("audit sinks");
  if (input.allowPrivateDestinations === true && refusal) throw new ValidationError(refusal);
  const previous = await getAuditSettings(workspaceId);
  const next = {
    retentionDays: days === undefined ? previous.retentionDays : days,
    allowPrivateDestinations: input.allowPrivateDestinations ?? previous.allowPrivateDestinations,
  };
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .insert(auditSettings)
      .values({ workspaceId, ...next, updatedBy: caller.actor.id, updatedAt: now })
      .onConflictDoUpdate({ target: auditSettings.workspaceId, set: { ...next, updatedBy: caller.actor.id, updatedAt: now } });
    await writeAuditEvents(tx, [{
      workspaceId, type: "audit.settings.updated", actor: caller.actor, context: caller.context,
      resource: { type: "audit_settings", id: workspaceId },
      data: {
        ...next,
        previousRetentionDays: previous.retentionDays,
        previousAllowPrivateDestinations: previous.allowPrivateDestinations,
      },
    }]);
  });
  return getAuditSettings(workspaceId);
}

export async function recordExport(workspaceId: string, environmentId: string | null, caller: AuditCaller, data: Record<string, unknown>): Promise<void> {
  await writeAuditEvents(db, [{
    workspaceId, environmentId, type: "audit.export.created", actor: caller.actor, context: caller.context, resource: null, data,
  }]);
}

export function assertExportRange(from: Date, to: Date): void {
  if (!(from < to)) throw new ValidationError("from must be before to");
  if (to.getTime() - from.getTime() > EXPORT_MAX_DAYS * 86_400_000) {
    throw new ValidationError(`An export covers at most ${EXPORT_MAX_DAYS} days. Split the range.`);
  }
}

