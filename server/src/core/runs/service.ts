import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { escapeLike } from "../../utils/validation.ts";
import { db } from "../../db/index.ts";
import { dbUtcNow } from "../../db/clock.ts";
import { runs, spans, type Run, type Span } from "../../db/schema/runs.ts";
import { agents, agentVersions } from "../../db/schema/agents.ts";
import { generateRunId, generateSpanId } from "../../utils/crypto.ts";
import { NotFoundError, ValidationError } from "../../utils/errors.ts";
import { createLogger } from "../../lib/logger.ts";
import { redactPayload } from "./redaction.ts";
import { captureMilestoneOnce } from "../../lib/product-events.ts";
import { publishRealtime } from "../realtime/publisher.ts";
import { runFeedback, type RunFeedback } from "../../db/schema/run-feedback.ts";
import { generateFeedbackId } from "../../utils/crypto.ts";
import { createHash } from "node:crypto";

const logger = createLogger({ module: "runs" });

const MAX_SPANS_PER_BATCH = 500;

export type Scope = { workspaceId: string; environmentId: string };
export type ReadScope = { workspaceId: string; environmentId?: string | null };

export type PublicSpan = {
  id: string;
  parentId: string | null;
  name: string;
  type: Span["type"];
  status: Span["status"];
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  model: string | null;
  provider: string | null;
  tokens: Record<string, number> | null;
  cost: number | null;
  input: unknown;
  output: unknown;
  error: Record<string, unknown> | null;
  attributes: Record<string, unknown> | null;
};

export type PublicRun = {
  id: string;
  agentId: string | null;
  agentVersion: string | null;
  environmentId: string;
  name: string | null;
  status: Run["status"];
  userId: string | null;
  application: string | null;
  input: unknown;
  output: unknown;
  error: Record<string, unknown> | null;
  tokens: number | null;
  cost: number | null;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
};

function toPublicSpan(s: Span): PublicSpan {
  return {
    id: s.spanId,
    parentId: s.parentSpanId,
    name: s.name,
    type: s.type,
    status: s.status,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt ? s.endedAt.toISOString() : null,
    durationMs: s.durationMs,
    model: s.model,
    provider: s.provider,
    tokens: s.tokens ?? null,
    cost: s.cost === null ? null : Number(s.cost),
    input: s.input ?? null,
    output: s.output ?? null,
    error: s.error ?? null,
    attributes: s.attributes ?? null,
  };
}

function toPublicRun(r: Run): PublicRun {
  return {
    id: r.runId,
    agentId: r.agentId,
    agentVersion: r.agentVersionId,
    environmentId: r.environmentId,
    name: r.name,
    status: r.status,
    userId: r.userId,
    application: r.application,
    input: r.input ?? null,
    output: r.output ?? null,
    error: r.error ?? null,
    tokens: r.tokens,
    cost: r.cost === null ? null : Number(r.cost),
    tags: r.tags ?? null,
    metadata: r.metadata ?? null,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    durationMs: r.durationMs,
  };
}

export type StartRunInput = {
  name?: string;
  agentId?: string;
  agentVersion?: string;
  userId?: string;
  application?: string;
  input?: unknown;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

async function resolveRunAgent(
  scopeIn: Scope,
  input: StartRunInput,
): Promise<{ agentId: string | null; agentVersionId: string | null }> {
  if (!input.agentId && !input.agentVersion) return { agentId: null, agentVersionId: null };

  if (!input.agentId) {
    throw new ValidationError("agentVersion was given without an agentId, so the version cannot be resolved");
  }

  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, scopeIn.workspaceId),
        eq(agents.environmentId, scopeIn.environmentId),
        eq(agents.agentId, input.agentId)
      )
    )
    .limit(1);

  if (!agent) {
    throw new ValidationError(`Unknown agent for this environment: ${input.agentId}`);
  }

  if (!input.agentVersion) return { agentId: input.agentId, agentVersionId: null };

  const [version] = await db
    .select({ agentVersionId: agentVersions.agentVersionId })
    .from(agentVersions)
    .where(
      and(
        eq(agentVersions.agentId, agent.id),
        eq(agentVersions.agentVersionId, input.agentVersion)
      )
    )
    .limit(1);

  if (!version) {
    throw new ValidationError(`Agent ${input.agentId} has no version ${input.agentVersion}`);
  }

  return { agentId: input.agentId, agentVersionId: version.agentVersionId };
}

export async function getRunIdentity(
  scopeIn: ReadScope,
  runPublicId: string,
): Promise<{ agentId: string | null; agentVersionId: string | null; userId: string | null }> {
  const row = await requireRun(scopeIn, runPublicId);
  return { agentId: row.agentId, agentVersionId: row.agentVersionId, userId: row.userId };
}

export async function startRun(scopeIn: Scope, input: StartRunInput): Promise<PublicRun> {
  const agent = await resolveRunAgent(scopeIn, input);

  const [row] = await db
    .insert(runs)
    .values({
      workspaceId: scopeIn.workspaceId,
      environmentId: scopeIn.environmentId,
      runId: generateRunId(),
      name: input.name ?? null,
      agentId: agent.agentId,
      agentVersionId: agent.agentVersionId,
      userId: input.userId ?? null,
      application: input.application ?? null,
      input: redactPayload(input.input),
      tags: input.tags ?? null,
      metadata: input.metadata ?? null,
    })
    .returning();
  logger.debug({ runId: row.runId, workspaceId: scopeIn.workspaceId }, "Run started");
  publishRealtime(scopeIn.workspaceId, {
    type: "run.started",
    environmentId: scopeIn.environmentId,
    data: { runId: row.runId, name: row.name, status: row.status },
  });
  captureMilestoneOnce(scopeIn.workspaceId, "first_run_started");
  return toPublicRun(row);
}

async function requireRun(scopeIn: ReadScope, runPublicId: string): Promise<Run> {
  const conditions = [eq(runs.workspaceId, scopeIn.workspaceId), eq(runs.runId, runPublicId)];
  if (scopeIn.environmentId) conditions.push(eq(runs.environmentId, scopeIn.environmentId));
  const [row] = await db
    .select()
    .from(runs)
    .where(and(...conditions))
    .limit(1);
  if (!row) throw new NotFoundError("Run not found");
  return row;
}

export type EndRunInput = {
  status?: Run["status"];
  output?: unknown;
  error?: Record<string, unknown>;
  tokens?: number;
  cost?: number;
  metadata?: Record<string, unknown>;
};

export async function endRun(scopeIn: Scope, runPublicId: string, input: EndRunInput): Promise<PublicRun> {
  const run = await requireRun(scopeIn, runPublicId);
  const endedAt = dbUtcNow();
  const [updated] = await db
    .update(runs)
    .set({
      status: input.status ?? "succeeded",
      output: input.output === undefined ? run.output : redactPayload(input.output),
      error: input.error ?? run.error,
      tokens: input.tokens ?? run.tokens,
      cost: input.cost === undefined ? run.cost : String(input.cost),
      metadata: input.metadata ?? run.metadata,
      endedAt,
      durationMs: sql<number>`greatest(0, round(extract(epoch from ((clock_timestamp() at time zone 'utc') - ${runs.startedAt})) * 1000))::int`,
      updatedAt: dbUtcNow(),
    })
    .where(eq(runs.id, run.id))
    .returning();
  publishRealtime(scopeIn.workspaceId, {
    type: "run.ended",
    environmentId: scopeIn.environmentId,
    data: { runId: updated.runId, status: updated.status, durationMs: updated.durationMs },
  });
  return toPublicRun(updated);
}

export type ListRunsFilter = {
	search?: string;
	status?: Run["status"];
  agentId?: string;
  userId?: string;
  startedAfter?: Date;
  startedBefore?: Date;
  limit: number;
  offset: number;
};

export async function listRuns(
  scopeIn: ReadScope,
  filter: ListRunsFilter,
): Promise<{ runs: PublicRun[]; total: number }> {
  const conditions = [eq(runs.workspaceId, scopeIn.workspaceId)];
  if (scopeIn.environmentId) conditions.push(eq(runs.environmentId, scopeIn.environmentId));
	if (filter.search) {
		const pattern = `%${escapeLike(filter.search)}%`;
		conditions.push(or(ilike(runs.runId, pattern), ilike(runs.name, pattern), ilike(runs.application, pattern))!);
	}
  if (filter.status) conditions.push(eq(runs.status, filter.status));
  if (filter.agentId) conditions.push(eq(runs.agentId, filter.agentId));
  if (filter.userId) conditions.push(eq(runs.userId, filter.userId));
  if (filter.startedAfter) conditions.push(gte(runs.startedAt, filter.startedAfter));
  if (filter.startedBefore) conditions.push(lte(runs.startedAt, filter.startedBefore));
  const where = and(...conditions);

  const rows = await db
    .select()
    .from(runs)
    .where(where)
    .orderBy(desc(runs.startedAt))
    .limit(filter.limit)
    .offset(filter.offset);

  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(runs).where(where);
  return { runs: rows.map(toPublicRun), total: Number(count) };
}

export type SpanNode = PublicSpan & { children: SpanNode[] };

export async function getRunWithTree(
  scopeIn: ReadScope,
  runPublicId: string,
): Promise<{ run: PublicRun; spans: SpanNode[] }> {
  const run = await requireRun(scopeIn, runPublicId);
  const rows = await db
    .select()
    .from(spans)
    .where(eq(spans.runId, run.id))
    .orderBy(spans.startedAt);

  const nodes = new Map<string, SpanNode>();
  for (const s of rows) nodes.set(s.spanId, { ...toPublicSpan(s), children: [] });

  const roots: SpanNode[] = [];
  for (const s of rows) {
    const node = nodes.get(s.spanId)!;
    const parent = s.parentSpanId ? nodes.get(s.parentSpanId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return { run: toPublicRun(run), spans: roots };
}

export function exportRunAsOtlp(run: PublicRun, roots: SpanNode[], feedback: PublicFeedback[] = []) {
  const hex = (value: string, length: number) => createHash("sha256").update(value).digest("hex").slice(0, length);
  const flatten = (nodes: SpanNode[]): SpanNode[] => nodes.flatMap((node) => [node, ...flatten(node.children)]);
  const nanos = (timestamp: string) => String(BigInt(new Date(timestamp).getTime()) * 1_000_000n);
  const attribute = (key: string, value: unknown) => ({ key, value: { stringValue: typeof value === "string" ? value : JSON.stringify(value) } });
  const optional = (key: string, value: unknown) =>
    value === null || value === undefined ? [] : [attribute(key, value)];
  const spanId = new Map(flatten(roots).map((span) => [span.id, hex(span.id, 16)]));
  const requestId = typeof run.metadata?.requestId === "string" ? run.metadata.requestId : undefined;

  return {
    resourceSpans: [{
      resource: { attributes: [
        attribute("service.name", run.application ?? "anlyon-agent"),
        attribute("anlyon.run_id", run.id),
        attribute("anlyon.environment_id", run.environmentId),
        ...(requestId ? [attribute("anlyon.request_id", requestId)] : []),
        ...(run.agentId ? [attribute("anlyon.agent_id", run.agentId)] : []),
        ...optional("anlyon.run.name", run.name),
        attribute("anlyon.run.status", run.status),
        attribute("anlyon.run.started_at", run.startedAt),
        ...optional("anlyon.run.ended_at", run.endedAt),
        ...optional("anlyon.run.duration_ms", run.durationMs),
        ...optional("anlyon.run.user_id", run.userId),
        ...optional("anlyon.run.agent_version", run.agentVersion),
        ...optional("anlyon.run.application", run.application),
        ...optional("anlyon.run.input", run.input),
        ...optional("anlyon.run.output", run.output),
        ...optional("anlyon.run.error", run.error),
        ...optional("anlyon.run.tokens", run.tokens),
        ...optional("anlyon.run.cost", run.cost),
        ...optional("anlyon.run.tags", run.tags),
        ...optional("anlyon.run.metadata", run.metadata),
        ...(feedback.length > 0 ? [attribute("anlyon.run.feedback", feedback)] : []),
      ] },
      scopeSpans: [{ scope: { name: "anlyon" }, spans: flatten(roots).map((span) => ({
        traceId: hex(run.id, 32),
        spanId: spanId.get(span.id),
        ...(span.parentId && spanId.get(span.parentId) ? { parentSpanId: spanId.get(span.parentId) } : {}),
        name: span.name,
        startTimeUnixNano: nanos(span.startedAt),
        endTimeUnixNano: nanos(span.endedAt ?? span.startedAt),
        status: { code: span.status === "failed" ? 2 : 1 },
        attributes: [
          attribute("anlyon.span_id", span.id),
          ...(span.parentId ? [attribute("anlyon.parent_span_id", span.parentId)] : []),
          attribute("anlyon.type", span.type),
          attribute("anlyon.status", span.status),
          ...optional("anlyon.duration_ms", span.durationMs),
          ...optional("anlyon.input", span.input),
          ...optional("anlyon.output", span.output),
          ...optional("anlyon.error", span.error),
          ...optional("anlyon.tokens", span.tokens),
          ...optional("anlyon.cost", span.cost),
          ...(span.model ? [attribute("gen_ai.request.model", span.model)] : []),
          ...(span.provider ? [attribute("gen_ai.system", span.provider)] : []),
          ...(span.attributes ? Object.entries(span.attributes).map(([key, value]) => attribute(key, value)) : []),
        ],
      })) }],
    }],
  };
}

export type OtlpTraceInput = {
  resourceSpans: Array<{
    resource?: { attributes?: Array<{ key: string; value?: Record<string, unknown> }> };
    scopeSpans: Array<{
      spans: Array<{
        spanId: string;
        parentSpanId?: string;
        name: string;
        startTimeUnixNano: string;
        endTimeUnixNano?: string;
        status?: { code?: number };
        attributes?: Array<{ key: string; value?: Record<string, unknown> }>;
      }>;
    }>;
  }>;
};

const IMPORTABLE_SPAN_TYPES = new Set<Span["type"]>([
  "model_call", "context_assembly", "session_read", "session_write", "memory_recall", "memory_write",
  "tool_call", "action_call", "approval_wait", "approval_decision", "workflow_step", "queue_delivery",
  "event_delivery", "custom",
]);

function decodeOtlpValue(value: Record<string, unknown> | undefined): unknown {
  if (!value) return null;
  for (const key of ["stringValue", "boolValue", "intValue", "doubleValue", "bytesValue"] as const) {
    if (key in value) return value[key];
  }
  if (Array.isArray(value.arrayValue)) return value.arrayValue;
  if (value.kvlistValue && typeof value.kvlistValue === "object") return value.kvlistValue;
  return null;
}

function otlpAttributes(attributes: Array<{ key: string; value?: Record<string, unknown> }> | undefined) {
  const values: Record<string, unknown> = {};
  for (const attribute of attributes ?? []) values[attribute.key] = decodeOtlpValue(attribute.value);
  return values;
}

function stringAttribute(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestampFromNanos(value: string, field: string): Date {
  let milliseconds: bigint;
  try {
    milliseconds = BigInt(value) / 1_000_000n;
  } catch {
    throw new ValidationError(`Invalid OTLP ${field}.`);
  }
  if (milliseconds < -8_640_000_000_000_000n || milliseconds > 8_640_000_000_000_000n) {
    throw new ValidationError(`OTLP ${field} is outside the supported date range.`);
  }
  const date = new Date(Number(milliseconds));
  if (Number.isNaN(date.getTime())) throw new ValidationError(`Invalid OTLP ${field}.`);
  return date;
}

function importedSpanId(sourceId: string, originalId: string | undefined): string {
  if (originalId && originalId.length <= 80) return originalId;
  return `otel_${createHash("sha256").update(sourceId).digest("hex").slice(0, 64)}`;
}

export async function importOtlpTrace(scopeIn: Scope, input: OtlpTraceInput): Promise<PublicRun> {
  const resource = input.resourceSpans[0];
  const resourceAttributes = otlpAttributes(resource.resource?.attributes);
  const sourceSpans = resource.scopeSpans.flatMap((scope) => scope.spans);
  if (sourceSpans.length === 0) throw new ValidationError("An OTLP trace must contain at least one span.");
  if (sourceSpans.length > MAX_SPANS_PER_BATCH) {
    throw new ValidationError(`An OTLP trace may contain at most ${MAX_SPANS_PER_BATCH} spans.`);
  }

  const seenSourceIds = new Set<string>();
  const importedIds = new Set<string>();
  const idBySourceId = new Map<string, string>();
  const parsed = sourceSpans.map((span) => {
    if (seenSourceIds.has(span.spanId)) throw new ValidationError("OTLP trace contains duplicate span IDs.");
    seenSourceIds.add(span.spanId);
    const attributes = otlpAttributes(span.attributes);
    const id = importedSpanId(span.spanId, stringAttribute(attributes, "anlyon.span_id"));
    if (importedIds.has(id)) throw new ValidationError("OTLP trace contains duplicate Anlyon span IDs.");
    importedIds.add(id);
    idBySourceId.set(span.spanId, id);

    const startedAt = timestampFromNanos(span.startTimeUnixNano, "startTimeUnixNano");
    const endedAt = span.endTimeUnixNano ? timestampFromNanos(span.endTimeUnixNano, "endTimeUnixNano") : undefined;
    if (endedAt && endedAt < startedAt) throw new ValidationError("OTLP span ends before it starts.");
    const sourceType = stringAttribute(attributes, "anlyon.type");
    return { span, attributes, id, startedAt, endedAt, type: sourceType && IMPORTABLE_SPAN_TYPES.has(sourceType as Span["type"]) ? sourceType as Span["type"] : "custom" as const };
  });

  const parentById = new Map<string, string | undefined>();
  for (const entry of parsed) {
    const parentSourceId = entry.span.parentSpanId;
    if (parentSourceId && !idBySourceId.has(parentSourceId)) {
      throw new ValidationError("OTLP trace contains a parent span that is not included in the import.");
    }
    parentById.set(entry.id, parentSourceId ? idBySourceId.get(parentSourceId) : undefined);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new ValidationError("OTLP trace contains a cyclic parent relationship.");
    if (visited.has(id)) return;
    visiting.add(id);
    const parent = parentById.get(id);
    if (parent) visit(parent);
    visiting.delete(id);
    visited.add(id);
  };
  for (const { id } of parsed) visit(id);

  const application = stringAttribute(resourceAttributes, "service.name")?.slice(0, 200);
  const sourceRequestId = stringAttribute(resourceAttributes, "anlyon.request_id");
  const run = await startRun(scopeIn, {
    name: "Imported OTLP trace",
    application,
    metadata: { importedFrom: "otlp-json", ...(sourceRequestId ? { sourceRequestId } : {}) },
  });
  await ingestSpans(scopeIn, run.id, parsed.map((entry) => ({
    id: entry.id,
    parentId: parentById.get(entry.id),
    name: entry.span.name,
    type: entry.type,
    status: entry.span.status?.code === 2 ? "failed" : entry.endedAt ? "succeeded" : "running",
    startedAt: entry.startedAt.toISOString(),
    ...(entry.endedAt ? { endedAt: entry.endedAt.toISOString() } : {}),
    model: stringAttribute(entry.attributes, "gen_ai.request.model"),
    provider: stringAttribute(entry.attributes, "gen_ai.system"),
    attributes: redactPayload(entry.attributes) as Record<string, unknown>,
  })));

  const startedAt = new Date(Math.min(...parsed.map((entry) => entry.startedAt.getTime())));
  const allEnded = parsed.every((entry) => entry.endedAt);
  const endedAt = allEnded ? new Date(Math.max(...parsed.map((entry) => entry.endedAt!.getTime()))) : null;
  const status: Run["status"] = !allEnded ? "running" : parsed.some((entry) => entry.span.status?.code === 2) ? "failed" : "succeeded";
  const [updated] = await db
    .update(runs)
    .set({
      startedAt,
      endedAt,
      status,
      durationMs: endedAt ? endedAt.getTime() - startedAt.getTime() : null,
      updatedAt: new Date(),
    })
    .where(eq(runs.runId, run.id))
    .returning();
  if (!updated) throw new NotFoundError("Imported run");
  if (endedAt) {
    publishRealtime(scopeIn.workspaceId, {
      type: "run.ended",
      environmentId: scopeIn.environmentId,
      data: { runId: updated.runId, status: updated.status, durationMs: updated.durationMs },
    });
  }
  return toPublicRun(updated);
}

export type IngestSpanInput = {
  id?: string;
  parentId?: string;
  name: string;
  type?: Span["type"];
  status?: Span["status"];
  startedAt: string;
  endedAt?: string;
  model?: string;
  provider?: string;
  tokens?: Record<string, number>;
  cost?: number;
  input?: unknown;
  output?: unknown;
  error?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
};

export async function ingestSpans(
  scopeIn: Scope,
  runPublicId: string,
  incoming: IngestSpanInput[],
): Promise<{ ingested: number }> {
  if (incoming.length === 0) return { ingested: 0 };
  if (incoming.length > MAX_SPANS_PER_BATCH) {
    throw new ValidationError(`A span batch may contain at most ${MAX_SPANS_PER_BATCH} spans.`);
  }
  const run = await requireRun(scopeIn, runPublicId);

  const values = incoming.map((s) => {
    const startedAt = new Date(s.startedAt);
    if (Number.isNaN(startedAt.getTime())) throw new ValidationError(`Invalid span startedAt: ${s.startedAt}`);
    const endedAt = s.endedAt ? new Date(s.endedAt) : null;
    return {
      workspaceId: scopeIn.workspaceId,
      environmentId: scopeIn.environmentId,
      runId: run.id,
      spanId: s.id ?? generateSpanId(),
      parentSpanId: s.parentId ?? null,
      name: s.name,
      type: s.type ?? "custom",
      status: s.status ?? (endedAt ? "succeeded" : "running"),
      input: redactPayload(s.input),
      output: redactPayload(s.output),
      error: s.error ?? null,
      model: s.model ?? null,
      provider: s.provider ?? null,
      tokens: s.tokens ?? null,
      cost: s.cost === undefined ? null : String(s.cost),
      attributes: s.attributes ?? null,
      startedAt,
      endedAt,
      durationMs: endedAt ? endedAt.getTime() - startedAt.getTime() : null,
    };
  });

  await db
    .insert(spans)
    .values(values)
    .onConflictDoUpdate({
      target: [spans.runId, spans.spanId],
      set: {
        parentSpanId: sql`excluded.parent_span_id`,
        name: sql`excluded.name`,
        type: sql`excluded.type`,
        status: sql`excluded.status`,
        input: sql`excluded.input`,
        output: sql`excluded.output`,
        error: sql`excluded.error`,
        model: sql`excluded.model`,
        provider: sql`excluded.provider`,
        tokens: sql`excluded.tokens`,
        cost: sql`excluded.cost`,
        attributes: sql`excluded.attributes`,
        startedAt: sql`excluded.started_at`,
        endedAt: sql`excluded.ended_at`,
        durationMs: sql`excluded.duration_ms`,
      },
    });

  if (values.some((v) => v.tokens !== null || v.cost !== null)) {
    await db.execute(sql`
      UPDATE runs SET
        tokens = COALESCE(agg.total_tokens, runs.tokens),
        cost = COALESCE(agg.total_cost, runs.cost),
        updated_at = now()
      FROM (
        SELECT
          sum(COALESCE(
            (s.tokens->>'total')::numeric,
            (SELECT sum(v.value::numeric) FROM jsonb_each_text(s.tokens) v)
          ))::int AS total_tokens,
          sum(s.cost) AS total_cost
        FROM spans s
        WHERE s.run_id = ${run.id}
      ) agg
      WHERE runs.id = ${run.id}
    `);
  }

  logger.debug({ runId: run.runId, count: values.length }, "Spans ingested");
  publishRealtime(scopeIn.workspaceId, {
    type: "spans.ingested",
    environmentId: scopeIn.environmentId,
    data: { runId: run.runId, count: values.length },
  });
  return { ingested: values.length };
}

export type PublicFeedback = {
  id: string;
  runId: string;
  spanId: string | null;
  source: RunFeedback["source"];
  label: string | null;
  rating: number | null;
  comment: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

function toPublicFeedback(runPublicId: string, f: RunFeedback): PublicFeedback {
  return {
    id: f.feedbackId,
    runId: runPublicId,
    spanId: f.spanId,
    source: f.source,
    label: f.label,
    rating: f.rating === null ? null : Number(f.rating),
    comment: f.comment,
    metadata: f.metadata ?? null,
    createdAt: f.createdAt.toISOString(),
  };
}

export interface AddFeedbackInput {
  spanId?: string;
  source?: RunFeedback["source"];
  label?: string;
  rating?: number;
  comment?: string;
  metadata?: Record<string, unknown>;
}

export async function addFeedback(
  scopeIn: Scope,
  runPublicId: string,
  input: AddFeedbackInput,
  createdBy?: string | null,
): Promise<PublicFeedback> {
  const run = await requireRun(scopeIn, runPublicId);
  const [row] = await db
    .insert(runFeedback)
    .values({
      workspaceId: scopeIn.workspaceId,
      environmentId: scopeIn.environmentId,
      runId: run.id,
      spanId: input.spanId ?? null,
      feedbackId: generateFeedbackId(),
      source: input.source ?? "user",
      label: input.label ?? null,
      rating: input.rating === undefined ? null : String(input.rating),
      comment: input.comment ?? null,
      metadata: input.metadata ?? null,
      createdBy: createdBy ?? null,
    })
    .returning();
  publishRealtime(scopeIn.workspaceId, {
    type: "feedback.created",
    environmentId: scopeIn.environmentId,
    data: { runId: run.runId, feedbackId: row.feedbackId, label: row.label },
  });
  return toPublicFeedback(run.runId, row);
}

export async function listFeedback(
  scopeIn: ReadScope,
  runPublicId: string,
): Promise<PublicFeedback[]> {
  const run = await requireRun(scopeIn, runPublicId);
  const rows = await db
    .select()
    .from(runFeedback)
    .where(eq(runFeedback.runId, run.id))
    .orderBy(desc(runFeedback.createdAt));
  return rows.map((r) => toPublicFeedback(run.runId, r));
}
