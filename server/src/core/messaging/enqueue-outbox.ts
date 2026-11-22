import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { messageEnqueueOutbox, messages } from "../../db/schema/messages.ts";
import { redis } from "../../lib/redis.ts";
import { createLogger } from "../../lib/logger.ts";

const logger = createLogger({ module: "message-enqueue-outbox" });

export const ENQUEUE_ONCE = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local commands = cjson.decode(ARGV[1])
local types = {hset='hash', expire='any', set='string', zadd='zset', sadd='set', xadd='stream'}
for _, command in ipairs(commands) do
  local expected = types[command[1]]
  if not expected then return redis.error_reply('Unsupported outbox command') end
  local actual = redis.call('TYPE', command[2]).ok
  if actual ~= 'none' and expected ~= 'any' and actual ~= expected then
    return redis.error_reply('Outbox key type mismatch')
  end
end
for _, command in ipairs(commands) do redis.call(unpack(command)) end
redis.call('SET', KEYS[1], '1')
return 1
`;

export async function dispatchMessageOutbox(messageId: string): Promise<void> {
  const marker = `message-enqueued:${messageId}`;
  await db.transaction(async tx => {
    const [message] = await tx.select({ status: messages.status }).from(messages)
      .where(eq(messages.messageId, messageId)).for("update");
    const [entry] = await tx.select().from(messageEnqueueOutbox)
      .where(eq(messageEnqueueOutbox.messageId, messageId)).for("update");
    if (!entry) return;
    if (message && (message.status === "pending" || message.status === "scheduled")) {
      await redis.eval(ENQUEUE_ONCE, 1, marker, JSON.stringify(entry.commands));
    }
    await tx.delete(messageEnqueueOutbox).where(eq(messageEnqueueOutbox.messageId, messageId));
  });
  await redis.expire(marker, 604800).catch(error =>
    logger.warn({ error, messageId }, "Could not expire acknowledged enqueue marker"));
}

export async function drainMessageOutbox(): Promise<void> {
  const entries = await db.select({ messageId: messageEnqueueOutbox.messageId })
    .from(messageEnqueueOutbox).orderBy(messageEnqueueOutbox.createdAt).limit(100);
  for (const entry of entries) {
    try { await dispatchMessageOutbox(entry.messageId); }
    catch (error) { logger.error({ error, messageId: entry.messageId }, "Message enqueue will retry"); }
  }
}
