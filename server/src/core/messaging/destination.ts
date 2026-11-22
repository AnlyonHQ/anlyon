import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { messages } from "../../db/schema/messages.ts";
import { queues } from "../../db/schema/queues.ts";
import { RedisKeys } from "../../lib/redis.ts";

export interface MessageDestination {
  streamKey: string;
  pendingIndexKey: string;
  pendingIndexMember: string;
  queue: { queueId: string; name: string } | null;
}

export async function resolveMessageDestination(
  workspaceId: string,
  messageId: string,
): Promise<MessageDestination | null> {
  const [row] = await db
    .select({ queueInternalId: messages.queueId })
    .from(messages)
    .where(and(eq(messages.workspaceId, workspaceId), eq(messages.messageId, messageId)))
    .limit(1);

  if (!row) return null;

  if (row.queueInternalId) {
    const [queue] = await db
      .select({ queueId: queues.queueId, name: queues.name })
      .from(queues)
      .where(eq(queues.id, row.queueInternalId));

    if (queue) {
      return {
        streamKey: RedisKeys.queuePendingStream(workspaceId, queue.queueId),
        pendingIndexKey: RedisKeys.activeQueuesPending(),
        pendingIndexMember: `${workspaceId}:${queue.queueId}`,
        queue,
      };
    }
  }

  return {
    streamKey: RedisKeys.pendingStream(workspaceId),
    pendingIndexKey: RedisKeys.activeWorkspacesPending(),
    pendingIndexMember: workspaceId,
    queue: null,
  };
}
