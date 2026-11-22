import { Hono, type Context } from "hono";
import { requireApiKey, requireApiKeyResourceScopes } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateQuery } from "../middleware/validation.ts";
import { paginationSchema } from "../../utils/validation.ts";
import {
  listDLQMessages,
  getDLQMessage,
  retryDLQMessage,
  retryAllDLQMessages,
  deleteDLQMessage,
  clearDLQ,
  getDLQStats,
} from "../../core/messaging/dlq.ts";
import { buildPaginatedResponse } from "../../utils/pagination.ts";
import type { DLQScope } from "../../core/messaging/dlq.ts";
import { pathParam } from "../params.ts";

const dlq = new Hono();

const scopeOf = (c: Context): DLQScope => ({
  workspaceId: c.get("workspaceId"),
  environmentId: c.get("environmentId"),
});

dlq.use("*", requireApiKey);
dlq.use("*", requireApiKeyResourceScopes("dlq:read", "dlq:write"));
dlq.use("*", rateLimitByWorkspace);

dlq.get("/", validateQuery(paginationSchema), async (c:Context) => {
  const { page, limit } = c.get("validatedQuery");

  const result = await listDLQMessages(scopeOf(c), { page, limit });

  return c.json({
    success: true,
    ...buildPaginatedResponse(result.messages, result.total, page, limit),
  });
});

dlq.get("/stats", async (c:Context) => {
  const stats = await getDLQStats(scopeOf(c));

  return c.json({
    success: true,
    data: stats,
  });
});

dlq.get("/:messageId", async (c:Context) => {
  const messageId = pathParam(c, "messageId");

  const message = await getDLQMessage(scopeOf(c), messageId);

  return c.json({
    success: true,
    data: message,
  });
});

dlq.post("/:messageId/retry", async (c:Context) => {
  const messageId = pathParam(c, "messageId");

  const message = await retryDLQMessage(scopeOf(c), messageId);

  return c.json({
    success: true,
    data: {
      message: "Message queued for retry",
      messageId: message.messageId,
    },
  });
});

dlq.post("/retry-all", async (c:Context) => {
  const { retriedCount, remaining } = await retryAllDLQMessages(scopeOf(c));

  return c.json({
    success: true,
    data: {
      message: "Messages queued for retry",
      retriedCount,
      remaining,
    },
  });
});

dlq.delete("/:messageId", async (c:Context) => {
  const messageId = pathParam(c, "messageId");

  await deleteDLQMessage(scopeOf(c), messageId);

  return c.json({
    success: true,
    data: {
      message: "Message deleted from DLQ",
    },
  });
});

dlq.delete("/", async (c:Context) => {
  const { deletedCount, remaining } = await clearDLQ(scopeOf(c));

  return c.json({
    success: true,
    data: {
      message: "DLQ cleared",
      deletedCount,
      remaining,
    },
  });
});

export default dlq;
