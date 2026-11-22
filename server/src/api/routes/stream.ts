import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { requireApiKey, requireApiKeyScope } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { RateLimitError } from "../../utils/errors.ts";
import { replaySince, createTailer, type RealtimeEvent } from "../../core/realtime/publisher.ts";
import { createLogger } from "../../lib/logger.ts";
import { streamStillAuthorized } from "../../core/workspace/access-revocation.ts";

const logger = createLogger({ module: "stream-route" });

const streamRouter = new Hono();

streamRouter.use("*", requireApiKey);
streamRouter.use("*", requireApiKeyScope("events:read"));
streamRouter.use("*", rateLimitByWorkspace);

export const MAX_STREAMS_PER_WORKSPACE = 20;
const openStreams = new Map<string, number>();

export function streamSlotsInUse(workspaceId: string): number {
  return openStreams.get(workspaceId) ?? 0;
}

function claimStreamSlot(workspaceId: string): () => void {
  const inUse = streamSlotsInUse(workspaceId);
  if (inUse >= MAX_STREAMS_PER_WORKSPACE) {
    throw new RateLimitError(
      `Too many open event streams for this workspace (limit ${MAX_STREAMS_PER_WORKSPACE}). Close an existing stream and retry.`,
    );
  }
  openStreams.set(workspaceId, inUse + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = streamSlotsInUse(workspaceId) - 1;
    if (remaining > 0) openStreams.set(workspaceId, remaining);
    else openStreams.delete(workspaceId);
  };
}

export function visibleToEnvironment(event: Pick<RealtimeEvent, "environmentId">, environmentId: string | undefined): boolean {
  return Boolean(environmentId) && event.environmentId === environmentId;
}

streamRouter.get("/", async (c: Context) => {
  const workspaceId = c.get("workspaceId") as string;
  const environmentId = c.get("environmentId") as string | undefined;
  const startCursor = c.req.header("Last-Event-ID") ?? c.req.query("cursor") ?? null;

  const wholeWorkspace = c.get("authType") === "session";
  const visible = (event: RealtimeEvent): boolean => wholeWorkspace || visibleToEnvironment(event, environmentId);
  const releaseSlot = claimStreamSlot(workspaceId);
  const credential = {
    authType: c.get("authType") as string | undefined,
    workspaceId,
    userId: c.get("userId") as string | undefined,
    sessionId: c.get("sessionId") as string | undefined,
    apiKeyId: c.get("apiKeyId") as string | undefined,
  };

  return streamSSE(c, async (stream) => {
    let lastId = startCursor ?? "0-0";
    let closed = false;
    const tailer = createTailer(workspaceId);
    stream.onAbort(() => {
      closed = true;
      tailer.close();
      releaseSlot();
    });

    try {
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ v: 1, cursor: startCursor }) });

      if (startCursor) {
        const missed = await replaySince(workspaceId, startCursor);
        for (const event of missed) {
          lastId = event.id;
          if (visible(event)) {
            await stream.writeSSE({ id: event.id, event: event.type, data: JSON.stringify(event) });
          }
        }
      } else {
        lastId = "$";
      }

      while (!closed) {
        let events: RealtimeEvent[];
        try {
          events = await tailer.next(lastId);
        } catch (error) {
          if (!closed) {
            logger.warn({ workspaceId, error: error instanceof Error ? error.message : error }, "Stream tail error");
          }
          break;
        }
        if (events.length === 0) {
          if (!(await streamStillAuthorized(credential))) {
            await stream.writeSSE({ event: "revoked", data: JSON.stringify({ reason: "access_revoked" }) });
            break;
          }
          await stream.writeSSE({ event: "heartbeat", data: `${Date.now()}` });
          continue;
        }
        for (const event of events) {
          lastId = event.id;
          if (visible(event)) {
            await stream.writeSSE({ id: event.id, event: event.type, data: JSON.stringify(event) });
          }
        }
      }
    } finally {
      tailer.close();
      releaseSlot();
    }
  });
});

export default streamRouter;
