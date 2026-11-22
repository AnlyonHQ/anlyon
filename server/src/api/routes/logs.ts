import { Hono, type Context } from "hono";
import { requireApiKey, requireApiKeyResourceScopes } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { db } from "../../db/index.ts";
import { messages } from "../../db/schema/messages.ts";
import { messageExecutionLogs } from "../../db/schema/execution-logs.ts";
import { eq, and, sql, gte, lte, like, inArray, desc, asc, or, getTableColumns } from "drizzle-orm";
import { buildPaginatedResponse, getOffset, validatePagination } from "../../utils/pagination.ts";
import { validateQuery } from "../middleware/validation.ts";
import { logsQuerySchema, logStatsQuerySchema, logExportQuerySchema } from "../../utils/validation.ts";
import { redactLogHeaders } from "../../core/logging/public-log.ts";
import { resolveEnvironmentId } from "./environment-context.ts";

const logsRouter = new Hono();

logsRouter.use("*", requireApiKey);
logsRouter.use("*", requireApiKeyResourceScopes("logs:read"));
logsRouter.use("*", rateLimitByWorkspace);

const MESSAGE_LOG_STATUSES = ["CREATED", "ACTIVE", "PROCESSING", "SUCCESS", "ERROR", "RETRY"] as const;

type SortOrder = "asc" | "desc";
type SortBy = "timestamp" | "duration" | "status" | "httpStatus";

interface LogFilters {
  type?: "message" | "all";
  status?: string;
  startDate?: string;
  endDate?: string;
  httpStatus?: string;
  minDuration?: number;
  maxDuration?: number;
  url?: string;
  messageId?: string;
  errorCode?: string;
  search?: string;
  sortBy?: SortBy;
  sortOrder?: SortOrder;
  page?: number;
  limit?: number;
}

interface UnifiedLogEntry {
  id: string;
  type: "message";
  entityId: string;
  status: string;
  timestamp: string;
  duration?: number | null;
  attemptNumber?: number | null;
  requestUrl?: string | null;
  requestMethod?: string | null;
  requestHeaders?: unknown;
  requestBody?: unknown;
  responseStatus?: number | null;
  responseHeaders?: unknown;
  responseBody?: string | null;
  errorMessage?: string | null;
  errorCode?: string | null;
}

logsRouter.get("/", validateQuery(logsQuerySchema), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const environmentId = await resolveEnvironmentId(c);

  const query = c.get("validatedQuery");
  const { type, startDate, endDate, minDuration, maxDuration, sortBy, sortOrder, page, limit } = query;
  const statusFilter = query.status;
  const httpStatusFilter = query.httpStatus;
  const urlFilter = query.url;
  const messageIdFilter = query.messageId;
  const errorCodeFilter = query.errorCode;
  const searchFilter = query.search;

  const { page: validPage, limit: validLimit } = validatePagination(page, limit);
  const offset = getOffset(validPage, validLimit);

  const statuses = statusFilter ? statusFilter.split(",").map((s: string) => s.trim().toUpperCase()) : undefined;
  const httpStatuses = httpStatusFilter ? httpStatusFilter.split(",").map((s: string) => parseInt(s.trim())).filter((n: number) => !isNaN(n)) : undefined;

  const unifiedLogs: UnifiedLogEntry[] = [];
  let totalMessageLogs = 0;

  if (type === "all" || type === "message") {
    const messageLogConditions = [eq(messageExecutionLogs.workspaceId, workspaceId)];

    if (statuses && statuses.length > 0) {
      const validStatuses = statuses.filter((s: string) => MESSAGE_LOG_STATUSES.includes(s as any));
      if (validStatuses.length > 0) {
        messageLogConditions.push(inArray(messageExecutionLogs.status, validStatuses));
      }
    }

    if (startDate) {
      messageLogConditions.push(gte(messageExecutionLogs.timestamp, new Date(startDate)));
    }

    if (endDate) {
      messageLogConditions.push(lte(messageExecutionLogs.timestamp, new Date(endDate)));
    }

    if (httpStatuses && httpStatuses.length > 0) {
      messageLogConditions.push(inArray(messageExecutionLogs.responseStatus, httpStatuses));
    }

    if (minDuration !== undefined) {
      messageLogConditions.push(gte(messageExecutionLogs.duration, minDuration));
    }

    if (maxDuration !== undefined) {
      messageLogConditions.push(lte(messageExecutionLogs.duration, maxDuration));
    }

    if (urlFilter) {
      messageLogConditions.push(like(messageExecutionLogs.requestUrl, `%${urlFilter}%`));
    }

    if (messageIdFilter) {
      messageLogConditions.push(like(messageExecutionLogs.messageId, `%${messageIdFilter}%`));
    }

    if (errorCodeFilter) {
      messageLogConditions.push(eq(messageExecutionLogs.errorCode, errorCodeFilter));
    }

    if (searchFilter) {
      messageLogConditions.push(
        or(
          like(messageExecutionLogs.errorMessage, `%${searchFilter}%`),
          like(messageExecutionLogs.responseBody, `%${searchFilter}%`)
        )!
      );
    }

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(messageExecutionLogs)
      .innerJoin(
        messages,
        and(
          eq(messages.messageId, messageExecutionLogs.messageId),
          eq(messages.workspaceId, workspaceId),
          eq(messages.environmentId, environmentId),
        ),
      )
      .where(and(...messageLogConditions));
    totalMessageLogs = Number(countResult[0]?.count || 0);

    const messageLogResults = await db
      .select(getTableColumns(messageExecutionLogs))
      .from(messageExecutionLogs)
      .innerJoin(
        messages,
        and(
          eq(messages.messageId, messageExecutionLogs.messageId),
          eq(messages.workspaceId, workspaceId),
          eq(messages.environmentId, environmentId),
        ),
      )
      .where(and(...messageLogConditions))
      .orderBy(
        sortBy === "duration"
          ? sortOrder === "asc"
            ? asc(messageExecutionLogs.duration)
            : desc(messageExecutionLogs.duration)
          : sortBy === "status"
            ? sortOrder === "asc"
              ? asc(messageExecutionLogs.status)
              : desc(messageExecutionLogs.status)
            : sortBy === "httpStatus"
              ? sortOrder === "asc"
                ? asc(messageExecutionLogs.responseStatus)
                : desc(messageExecutionLogs.responseStatus)
              : sortOrder === "asc"
                ? asc(messageExecutionLogs.timestamp)
                : desc(messageExecutionLogs.timestamp)
      )
      .limit(validLimit)
      .offset(offset);

    for (const log of messageLogResults) {
      unifiedLogs.push({
        id: log.id,
        type: "message",
        entityId: log.messageId,
        status: log.status,
        timestamp: log.timestamp.toISOString(),
        duration: log.duration,
        attemptNumber: log.attemptNumber,
        requestUrl: log.requestUrl,
        requestMethod: log.requestMethod,
        requestHeaders: redactLogHeaders(log.requestHeaders),
        requestBody: log.requestBody,
        responseStatus: log.responseStatus,
        responseHeaders: redactLogHeaders(log.responseHeaders),
        responseBody: log.responseBody,
        errorMessage: log.errorMessage,
        errorCode: log.errorCode,
      });
    }
  }

  unifiedLogs.sort((a, b) => {
    const aVal = sortBy === "duration" ? (a.duration || 0) : new Date(a.timestamp).getTime();
    const bVal = sortBy === "duration" ? (b.duration || 0) : new Date(b.timestamp).getTime();
    return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
  });

  const total = totalMessageLogs;

  const stats = await calculateStats(workspaceId, environmentId, type);

  return c.json({
    success: true,
    ...buildPaginatedResponse(unifiedLogs.slice(0, validLimit), total, validPage, validLimit),
    stats,
  });
});

logsRouter.get("/stats", validateQuery(logStatsQuerySchema), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const environmentId = await resolveEnvironmentId(c);

  const { type, startDate, endDate } = c.get("validatedQuery");

  const stats = await calculateDetailedStats(workspaceId, environmentId, type, startDate, endDate);

  return c.json({
    success: true,
    data: stats,
  });
});

logsRouter.get("/export", validateQuery(logExportQuerySchema), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const environmentId = await resolveEnvironmentId(c);

  const query = c.get("validatedQuery");
  const { format, type, startDate, endDate, minDuration, maxDuration } = query;
  const statusFilter = query.status;
  const httpStatusFilter = query.httpStatus;
  const urlFilter = query.url;
  const messageIdFilter = query.messageId;

  const statuses = statusFilter ? statusFilter.split(",").map((s: string) => s.trim().toUpperCase()) : undefined;
  const httpStatuses = httpStatusFilter ? httpStatusFilter.split(",").map((s: string) => parseInt(s.trim())).filter((n: number) => !isNaN(n)) : undefined;

  const exportLimit = 10000;

  const unifiedLogs: UnifiedLogEntry[] = [];

  if (type === "all" || type === "message") {
    const messageLogConditions = [eq(messageExecutionLogs.workspaceId, workspaceId)];

    if (statuses && statuses.length > 0) {
      const validStatuses = statuses.filter((s: string) => MESSAGE_LOG_STATUSES.includes(s as any));
      if (validStatuses.length > 0) {
        messageLogConditions.push(inArray(messageExecutionLogs.status, validStatuses));
      }
    }

    if (startDate) {
      messageLogConditions.push(gte(messageExecutionLogs.timestamp, new Date(startDate)));
    }

    if (endDate) {
      messageLogConditions.push(lte(messageExecutionLogs.timestamp, new Date(endDate)));
    }

    if (httpStatuses && httpStatuses.length > 0) {
      messageLogConditions.push(inArray(messageExecutionLogs.responseStatus, httpStatuses));
    }

    if (minDuration !== undefined) {
      messageLogConditions.push(gte(messageExecutionLogs.duration, minDuration));
    }

    if (maxDuration !== undefined) {
      messageLogConditions.push(lte(messageExecutionLogs.duration, maxDuration));
    }

    if (urlFilter) {
      messageLogConditions.push(like(messageExecutionLogs.requestUrl, `%${urlFilter}%`));
    }

    if (messageIdFilter) {
      messageLogConditions.push(like(messageExecutionLogs.messageId, `%${messageIdFilter}%`));
    }

    const messageLogResults = await db
      .select(getTableColumns(messageExecutionLogs))
      .from(messageExecutionLogs)
      .innerJoin(
        messages,
        and(
          eq(messages.messageId, messageExecutionLogs.messageId),
          eq(messages.workspaceId, workspaceId),
          eq(messages.environmentId, environmentId),
        ),
      )
      .where(and(...messageLogConditions))
      .orderBy(desc(messageExecutionLogs.timestamp))
      .limit(exportLimit);

    for (const log of messageLogResults) {
      unifiedLogs.push({
        id: log.id,
        type: "message",
        entityId: log.messageId,
        status: log.status,
        timestamp: log.timestamp.toISOString(),
        duration: log.duration,
        attemptNumber: log.attemptNumber,
        requestUrl: log.requestUrl,
        requestMethod: log.requestMethod,
        responseStatus: log.responseStatus,
        errorMessage: log.errorMessage,
        errorCode: log.errorCode,
      });
    }
  }

  unifiedLogs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  if (format === "json") {
    c.header("Content-Type", "application/json");
    c.header("Content-Disposition", `attachment; filename="logs-export-${new Date().toISOString().slice(0, 10)}.json"`);
    return c.json({ logs: unifiedLogs });
  }

  const csvHeaders = [
    "ID",
    "Type",
    "Entity ID",
    "Status",
    "Timestamp",
    "Duration (ms)",
    "HTTP Status",
    "URL",
    "Method",
    "Error Message",
    "Error Code",
  ];

  const csvRows = unifiedLogs.map((log) => [
    log.id,
    log.type,
    log.entityId,
    log.status,
    log.timestamp,
    log.duration ?? "",
    log.responseStatus ?? "",
    log.requestUrl ?? "",
    log.requestMethod ?? "",
    (log.errorMessage ?? "").replace(/"/g, '""'),
    log.errorCode ?? "",
  ]);

  const csvContent = [
    csvHeaders.join(","),
    ...csvRows.map((row) => row.map((cell) => `"${cell}"`).join(",")),
  ].join("\n");

  c.header("Content-Type", "text/csv");
  c.header("Content-Disposition", `attachment; filename="logs-export-${new Date().toISOString().slice(0, 10)}.csv"`);
  return c.text(csvContent);
});

async function calculateStats(
  workspaceId: string,
  environmentId: string,
  type: "message" | "all",
) {
  let totalSuccess = 0;
  let totalError = 0;
  let totalRetry = 0;
  let totalCount = 0;
  let totalDuration = 0;
  let durationCount = 0;

  if (type === "all" || type === "message") {
    const messageStats = await db
      .select({
        status: messageExecutionLogs.status,
        count: sql<number>`count(*)`,
        avgDuration: sql<number>`avg(${messageExecutionLogs.duration})`,
      })
      .from(messageExecutionLogs)
      .innerJoin(
        messages,
        and(
          eq(messages.messageId, messageExecutionLogs.messageId),
          eq(messages.workspaceId, workspaceId),
          eq(messages.environmentId, environmentId),
        ),
      )
      .where(eq(messageExecutionLogs.workspaceId, workspaceId))
      .groupBy(messageExecutionLogs.status);

    for (const stat of messageStats) {
      const count = Number(stat.count);
      totalCount += count;
      if (stat.status === "SUCCESS") totalSuccess += count;
      if (stat.status === "ERROR") totalError += count;
      if (stat.status === "RETRY") totalRetry += count;
      if (stat.avgDuration) {
        totalDuration += Number(stat.avgDuration) * count;
        durationCount += count;
      }
    }
  }

  return {
    totalSuccess,
    totalError,
    totalRetry,
    avgDuration: durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
    errorRate: totalCount > 0 ? Math.round((totalError / totalCount) * 100 * 100) / 100 : 0,
  };
}

async function calculateDetailedStats(
  workspaceId: string,
  environmentId: string,
  type: "message" | "all",
  startDate?: string,
  endDate?: string
) {
  const byStatus: Record<string, number> = {};
  const byHttpStatus: Record<string, number> = {};
  const byErrorCode: Record<string, number> = {};
  const byHour: { hour: string; count: number; errors: number }[] = [];

  let durations: number[] = [];

  if (type === "all" || type === "message") {
    const conditions = [eq(messageExecutionLogs.workspaceId, workspaceId)];
    if (startDate) conditions.push(gte(messageExecutionLogs.timestamp, new Date(startDate)));
    if (endDate) conditions.push(lte(messageExecutionLogs.timestamp, new Date(endDate)));

    const statusStats = await db
      .select({
        status: messageExecutionLogs.status,
        count: sql<number>`count(*)`,
      })
      .from(messageExecutionLogs)
      .innerJoin(
        messages,
        and(
          eq(messages.messageId, messageExecutionLogs.messageId),
          eq(messages.workspaceId, workspaceId),
          eq(messages.environmentId, environmentId),
        ),
      )
      .where(and(...conditions))
      .groupBy(messageExecutionLogs.status);

    for (const stat of statusStats) {
      byStatus[stat.status] = (byStatus[stat.status] || 0) + Number(stat.count);
    }

    const httpStats = await db
      .select({
        httpStatus: messageExecutionLogs.responseStatus,
        count: sql<number>`count(*)`,
      })
      .from(messageExecutionLogs)
      .innerJoin(
        messages,
        and(
          eq(messages.messageId, messageExecutionLogs.messageId),
          eq(messages.workspaceId, workspaceId),
          eq(messages.environmentId, environmentId),
        ),
      )
      .where(and(...conditions))
      .groupBy(messageExecutionLogs.responseStatus);

    for (const stat of httpStats) {
      if (stat.httpStatus) {
        byHttpStatus[stat.httpStatus.toString()] = Number(stat.count);
      }
    }

    const errorStats = await db
      .select({
        errorCode: messageExecutionLogs.errorCode,
        count: sql<number>`count(*)`,
      })
      .from(messageExecutionLogs)
      .innerJoin(
        messages,
        and(
          eq(messages.messageId, messageExecutionLogs.messageId),
          eq(messages.workspaceId, workspaceId),
          eq(messages.environmentId, environmentId),
        ),
      )
      .where(and(...conditions, sql`${messageExecutionLogs.errorCode} IS NOT NULL`))
      .groupBy(messageExecutionLogs.errorCode);

    for (const stat of errorStats) {
      if (stat.errorCode) {
        byErrorCode[stat.errorCode] = Number(stat.count);
      }
    }

    const durationResults = await db
      .select({ duration: messageExecutionLogs.duration })
      .from(messageExecutionLogs)
      .innerJoin(
        messages,
        and(
          eq(messages.messageId, messageExecutionLogs.messageId),
          eq(messages.workspaceId, workspaceId),
          eq(messages.environmentId, environmentId),
        ),
      )
      .where(and(...conditions, sql`${messageExecutionLogs.duration} IS NOT NULL`));

    durations = durations.concat(durationResults.map((r) => r.duration!).filter((d) => d !== null));
  }

  durations.sort((a, b) => a - b);
  const p50 = durations.length > 0 ? durations[Math.floor(durations.length * 0.5)] : 0;
  const p95 = durations.length > 0 ? durations[Math.floor(durations.length * 0.95)] : 0;
  const p99 = durations.length > 0 ? durations[Math.floor(durations.length * 0.99)] : 0;
  const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

  return {
    byStatus,
    byHttpStatus,
    byErrorCode,
    byHour,
    avgDuration,
    p50Duration: p50,
    p95Duration: p95,
    p99Duration: p99,
  };
}

export default logsRouter;
