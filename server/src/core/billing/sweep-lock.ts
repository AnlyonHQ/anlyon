import { randomUUID } from "node:crypto";
import { redis } from "../../lib/redis.ts";

export async function withSweepLock(
  name: string,
  ttlSeconds: number,
  run: () => Promise<void>,
  opts: { holdOnSuccess?: boolean } = {},
) {
  const key = `billing:sweep:${name}`;
  const token = randomUUID();
  if (!await redis.set(key, token, "EX", ttlSeconds, "NX")) return false;
  let succeeded = false;
  try { await run(); succeeded = true; return true; }
  finally {
    if (!(opts.holdOnSuccess && succeeded)) {
      await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", 1, key, token);
    }
  }
}
