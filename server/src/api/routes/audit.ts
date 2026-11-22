import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import { legacyDatetime } from "../../utils/zod-compat.ts";
import { auditCaller } from "../audit-caller.ts";
import { requireApiKey, requireApiKeyScope, requirePermission, requireSession, requireWorkspaceAccess } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody, validateQuery } from "../middleware/validation.ts";
import { NotFoundError } from "../../utils/errors.ts";
import { isFeatureEnabled } from "../../core/edition/features.ts";
import { AUDIT_FEATURE } from "../../core/audit/outbox.ts";
import { AUDIT_EVENT_JSON_SCHEMA, AUDIT_EVENT_TYPES, AUDIT_SCHEMA } from "../../core/audit/event-schema.ts";
import { exportChunks, toReadableStream } from "../../core/audit/export.ts";
import { SINK_TYPES } from "../../core/audit/sinks/config.ts";
import {
  type AuditEventFilter,
  EVENTS_PAGE_MAX,
  assertExportRange,
  assertExportReadable,
  createSink,
  deleteSink,
  getAuditSettings,
  getSink,
  iterateAuditEvents,
  listAuditEvents,
  listDeadLetters,
  listSinks,
  recordExport,
  redeliverDeadLetter,
  sendTestEvent,
  updateAuditSettings,
  updateSink,
} from "../../core/audit/service.ts";
import { pathParam } from "../params.ts";
import { requireTeamFeature } from "../middleware/team-feature.ts";

const eventTypePattern = z
  .string()
  .trim()
  .max(100)
  .regex(/^(\*|[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?)$/, 'Use an event type ("policy.updated"), a prefix ("approval.*") or "*"');

const createSinkSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    type: z.enum(SINK_TYPES as [string, ...string[]]),
    config: z.record(z.string(), z.unknown()),
    credentials: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
    eventTypes: z.array(eventTypePattern).max(50).optional(),
    environmentIds: z.array(z.string().guid()).max(50).nullable().optional(),
    startFrom: z.enum(["now", "beginning"]).optional(),
    includeHistory: z.boolean().optional(),
  })
  .strict();

const updateSinkSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    credentials: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
    eventTypes: z.array(eventTypePattern).max(50).optional(),
    environmentIds: z.array(z.string().guid()).max(50).nullable().optional(),
    rotateSigningSecret: z.boolean().optional(),
    includeHistory: z.boolean().optional(),
  })
  .strict();

const settingsSchema = z
  .object({
    retentionDays: z.number().int().nullable().optional(),
    allowPrivateDestinations: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.retentionDays !== undefined || body.allowPrivateDestinations !== undefined, "Nothing to change");

const isoDate = legacyDatetime({ offset: true }).transform((value) => new Date(value));
const typeList = z
  .string()
  .max(1000)
  .transform((value) => value.split(",").map((part) => part.trim()).filter(Boolean))
  .pipe(z.array(eventTypePattern).max(20));

const filterFields = {
  environmentId: z.string().guid().optional(),
  type: typeList.optional(),
  category: z.enum(Object.keys(AUDIT_EVENT_TYPES) as [string, ...string[]]).optional(),
  action: z.string().trim().min(1).max(200).optional(),
  endUserId: z.string().regex(/^(?:[A-Za-z0-9._:@-]{1,128}|erased~[0-9a-f]{32})$/).optional(),
};

const eventsQuerySchema = z.object({
  ...filterFields,
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(EVENTS_PAGE_MAX).optional(),
  before: z.coerce.number().int().min(1).optional(),
});

const exportQuerySchema = z.object({
  ...filterFields,
  from: isoDate,
  to: isoDate,
  format: z.enum(["json", "csv"]).optional(),
});

type EventsQuery = z.infer<typeof eventsQuerySchema>;
type ExportQuery = z.infer<typeof exportQuerySchema>;

async function requireAuditStreaming(_c: Context, next: Next) {
  if (!isFeatureEnabled(AUDIT_FEATURE)) throw new NotFoundError("Endpoint");
  await next();
}

function credentialEnvironment(c: Context): string | undefined {
  const authType = c.get("authType") as string | undefined;
  return authType === "apiKey" || authType === "oauth" ? (c.get("environmentId") as string) : undefined;
}

function toFilter(c: Context, query: Pick<EventsQuery, "environmentId" | "type" | "category" | "action" | "from" | "to" | "endUserId">): AuditEventFilter {
  return {
    environmentId: query.environmentId,
    types: query.type,
    category: query.category,
    action: query.action,
    endUserId: query.endUserId,
    from: query.from,
    to: query.to,
    onlyEnvironmentId: credentialEnvironment(c),
  };
}

async function eventsHandler(c: Context) {
  const query = c.get("validatedQuery") as EventsQuery;
  const page = await listAuditEvents(c.get("workspaceId"), toFilter(c, query), { limit: query.limit, before: query.before });
  return c.json({ success: true, data: page.events, pagination: { nextBefore: page.nextBefore } });
}

async function exportHandler(c: Context) {
  const query = c.get("validatedQuery") as ExportQuery;
  assertExportRange(query.from, query.to);
  const workspaceId = c.get("workspaceId") as string;
  const filter = toFilter(c, query);
  const format = query.format ?? "json";
  const filters = {
    from: query.from.toISOString(), to: query.to.toISOString(), environmentId: filter.onlyEnvironmentId ?? query.environmentId ?? null,
    type: query.type ?? null, category: query.category ?? null, action: query.action ?? null,
    endUserId: query.endUserId ?? null,
  };
  await assertExportReadable(workspaceId, filter);
  await recordExport(workspaceId, filter.onlyEnvironmentId ?? query.environmentId ?? null, auditCaller(c), { format, filters });
  const stamp = new Date().toISOString().slice(0, 10);
  const stream = toReadableStream(
    exportChunks(format, { generatedAt: new Date().toISOString(), workspaceId, filters }, iterateAuditEvents(workspaceId, filter)),
  );
  return c.body(stream, 200, {
    "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="anlyon-audit-${stamp}.${format}"`,
    "Cache-Control": "no-store",
  });
}

export const auditConsoleRouter = new Hono();

const consoleGuard = [requireAuditStreaming, requireSession, requireWorkspaceAccess, requirePermission("audit.manage")] as const;
auditConsoleRouter.use("/:workspaceId/audit/*", ...consoleGuard);

auditConsoleRouter.get("/:workspaceId/audit/settings", async (c: Context) => {
  return c.json({ success: true, data: await getAuditSettings(c.get("workspaceId")) });
});

auditConsoleRouter.put("/:workspaceId/audit/settings", requireTeamFeature("audit_streaming"), validateBody(settingsSchema), async (c: Context) => {
  const settings = await updateAuditSettings(c.get("workspaceId"), c.get("validatedBody"), auditCaller(c));
  return c.json({ success: true, data: settings });
});

auditConsoleRouter.get("/:workspaceId/audit/sinks", async (c: Context) => {
  return c.json({ success: true, data: await listSinks(c.get("workspaceId")) });
});

auditConsoleRouter.post("/:workspaceId/audit/sinks", requireTeamFeature("audit_streaming"), validateBody(createSinkSchema), async (c: Context) => {
  const result = await createSink(c.get("workspaceId"), c.get("validatedBody"), auditCaller(c));
  c.header("Cache-Control", "no-store");
  return c.json({ success: true, data: { ...result.sink, ...(result.signingSecret ? { signingSecret: result.signingSecret } : {}) } }, 201);
});

auditConsoleRouter.get("/:workspaceId/audit/sinks/:sinkId", async (c: Context) => {
  return c.json({ success: true, data: await getSink(c.get("workspaceId"), pathParam(c, "sinkId")) });
});

auditConsoleRouter.patch("/:workspaceId/audit/sinks/:sinkId", requireTeamFeature("audit_streaming"), validateBody(updateSinkSchema), async (c: Context) => {
  const result = await updateSink(c.get("workspaceId"), pathParam(c, "sinkId"), c.get("validatedBody"), auditCaller(c));
  c.header("Cache-Control", "no-store");
  return c.json({ success: true, data: { ...result.sink, ...(result.signingSecret ? { signingSecret: result.signingSecret } : {}) } });
});

auditConsoleRouter.delete("/:workspaceId/audit/sinks/:sinkId", async (c: Context) => {
  await deleteSink(c.get("workspaceId"), pathParam(c, "sinkId"), auditCaller(c));
  return c.json({ success: true, data: { deleted: true } });
});

auditConsoleRouter.post("/:workspaceId/audit/sinks/:sinkId/test", async (c: Context) => {
  const result = await sendTestEvent(c.get("workspaceId"), pathParam(c, "sinkId"), auditCaller(c));
  return c.json({ success: true, data: result });
});

auditConsoleRouter.get("/:workspaceId/audit/sinks/:sinkId/dead-letters", async (c: Context) => {
  return c.json({ success: true, data: await listDeadLetters(c.get("workspaceId"), pathParam(c, "sinkId")) });
});

auditConsoleRouter.post("/:workspaceId/audit/sinks/:sinkId/dead-letters/:deadLetterId/redeliver", async (c: Context) => {
  const deadLetterId = z.string().guid().safeParse(pathParam(c, "deadLetterId"));
  if (!deadLetterId.success) throw new NotFoundError("Dead letter");
  const result = await redeliverDeadLetter(c.get("workspaceId"), pathParam(c, "sinkId"), deadLetterId.data, auditCaller(c));
  return c.json({ success: true, data: result });
});

auditConsoleRouter.get("/:workspaceId/audit/events", validateQuery(eventsQuerySchema), eventsHandler);
auditConsoleRouter.get("/:workspaceId/audit/export", validateQuery(exportQuerySchema), exportHandler);

export const auditRouter = new Hono();

auditRouter.use("*", requireAuditStreaming);
auditRouter.use("*", requireApiKey);
auditRouter.use("*", requireApiKeyScope("audit:read"));
auditRouter.use("*", requirePermission("audit.manage"));
auditRouter.use("*", rateLimitByWorkspace);

auditRouter.get("/schema", (c: Context) => {
  return c.json({ success: true, data: { schema: AUDIT_SCHEMA, jsonSchema: AUDIT_EVENT_JSON_SCHEMA, eventTypes: AUDIT_EVENT_TYPES } });
});
auditRouter.get("/events", validateQuery(eventsQuerySchema), eventsHandler);
auditRouter.get("/export", validateQuery(exportQuerySchema), exportHandler);
