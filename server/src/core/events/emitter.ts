import { redis, RedisKeys } from "../../lib/redis.ts";
import { createLogger } from "../../lib/logger.ts";
import { publishEvent, RESERVED_TOPIC_NAME } from "./service.ts";
import { publishRealtime } from "../realtime/publisher.ts";
import { recordPlatformEvent } from "../audit/recorder.ts";

const logger = createLogger({ module: "events-emitter" });

export function emitEvent(
  workspaceId: string,
  type: string,
  data: Record<string, unknown>
): void {
  recordPlatformEvent(workspaceId, type, data);

  publishRealtime(workspaceId, {
    type,
    environmentId: typeof data.environmentId === "string" ? data.environmentId : null,
    data,
  });

  void (async () => {
    try {
      const hasSubs = await redis.exists(RedisKeys.eventsHasSubs(workspaceId));
      if (!hasSubs) return;

      await publishEvent(
        workspaceId,
        { topic: RESERVED_TOPIC_NAME, type, data },
        { allowReserved: true }
      );
    } catch (error) {
      logger.warn(
        { workspaceId, type, error: error instanceof Error ? error.message : error },
        "Failed to emit platform event"
      );
    }
  })();
}
