import { redis, redisBlocking, RedisKeys } from "../../lib/redis.ts";
import { createLogger } from "../../lib/logger.ts";

const logger = createLogger({ module: "realtime" });

const STREAM_MAXLEN = 1000;

export const REALTIME_SCHEMA_VERSION = 1;

export interface RealtimeEvent {
  id: string;
  v: number;
  type: string;
  environmentId: string | null;
  data: Record<string, unknown>;
  ts: number;
}

export function publishRealtime(
  workspaceId: string,
  event: { type: string; environmentId?: string | null; data: Record<string, unknown> },
): void {
  void (async () => {
    try {
      await redis.xadd(
        RedisKeys.realtimeStream(workspaceId),
        "MAXLEN",
        "~",
        STREAM_MAXLEN,
        "*",
        "type",
        event.type,
        "env",
        event.environmentId ?? "",
        "data",
        JSON.stringify(event.data ?? {}),
      );
    } catch (error) {
      logger.warn(
        { workspaceId, type: event.type, error: error instanceof Error ? error.message : error },
        "Failed to publish realtime event",
      );
    }
  })();
}

function parseEntry(id: string, fields: string[]): RealtimeEvent {
  const map: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) map[fields[i]] = fields[i + 1];
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(map.data ?? "{}");
  } catch {
    data = {};
  }
  const ts = Number(id.split("-")[0]) || Date.now();
  return { id, v: REALTIME_SCHEMA_VERSION, type: map.type ?? "unknown", environmentId: map.env || null, data, ts };
}

export async function replaySince(
  workspaceId: string,
  cursor: string | null,
  count = 500,
): Promise<RealtimeEvent[]> {
  const start = cursor ? `(${cursor}` : "-";
  const entries = (await redis.xrange(RedisKeys.realtimeStream(workspaceId), start, "+", "COUNT", count)) as [
    string,
    string[],
  ][];
  return entries.map(([id, fields]) => parseEntry(id, fields));
}

export interface RealtimeTailer {
  next: (lastId: string, blockMs?: number) => Promise<RealtimeEvent[]>;
  close: () => void;
}

export function createTailer(workspaceId: string): RealtimeTailer {
  const conn = redisBlocking.duplicate();
  return {
    async next(lastId: string, blockMs = 15000): Promise<RealtimeEvent[]> {
      const result = (await conn.xread(
        "BLOCK",
        blockMs,
        "STREAMS",
        RedisKeys.realtimeStream(workspaceId),
        lastId,
      )) as [string, [string, string[]][]][] | null;
      if (!result) return [];
      const [, entries] = result[0];
      return entries.map(([id, fields]) => parseEntry(id, fields));
    },
    close() {
      conn.disconnect();
    },
  };
}

export async function tailAfter(
  workspaceId: string,
  lastId: string,
  blockMs = 15000,
): Promise<RealtimeEvent[]> {
  const tailer = createTailer(workspaceId);
  try {
    return await tailer.next(lastId, blockMs);
  } finally {
    tailer.close();
  }
}
