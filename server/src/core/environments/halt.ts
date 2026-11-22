import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { environments, type Environment } from "../../db/schema/environments.ts";
import { dbUtcNow } from "../../db/clock.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { redis, RedisKeys } from "../../lib/redis.ts";
import { ConflictError, NotFoundError } from "../../utils/errors.ts";
import { emitEvent } from "../events/emitter.ts";
import { writeAuditEvents } from "../audit/outbox.ts";
import { haltRecord, resumeRecord } from "../audit/records.ts";
import type { StoredAuditContext } from "../audit/event-schema.ts";
import { captureMilestoneOnce } from "../../lib/product-events.ts";
import { createLogger } from "../../lib/logger.ts";
import { getEnvironment } from "./service.ts";
import { withSweepLock } from "../billing/sweep-lock.ts";

const logger = createLogger({ module: "environments-halt" });

export async function haltEnvironment(
  workspaceId: string,
  environmentId: string,
  opts: { reason?: string; actor?: string; context?: StoredAuditContext } = {},
): Promise<Environment> {
  const env = await getEnvironment(workspaceId, environmentId);
  if (env.haltedAt) {
    throw new ConflictError("Environment is already halted.");
  }
  const updated = await db.transaction(async (tx) => {
    const [halted] = await tx
      .update(environments)
      .set({
        haltedAt: new Date(),
        haltedReason: opts.reason ?? null,
        haltedBy: opts.actor ?? null,
        updatedAt: nextVersion(),
      })
      .where(and(eq(environments.workspaceId, workspaceId), eq(environments.id, environmentId)))
      .returning();
    const record = haltRecord(halted, { context: opts.context });
    if (record) await writeAuditEvents(tx, [record]);
    return halted;
  });
  await publishHaltState(environmentId, true, updated.updatedAt);
  logger.warn({ workspaceId, environmentId, reason: opts.reason }, "Environment halted");
  captureMilestoneOnce(workspaceId, "first_environment_halted");
  emitEvent(workspaceId, "environment.halted", {
    environmentId,
    slug: updated.slug,
    reason: opts.reason ?? null,
  });

  return updated;
}

export async function resumeEnvironment(
  workspaceId: string,
  environmentId: string,
  opts: { actor?: string; context?: StoredAuditContext } = {},
): Promise<Environment> {
  const updated = await db.transaction(async tx => {
  await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
  const [env] = await tx.select().from(environments)
    .where(and(eq(environments.workspaceId, workspaceId), eq(environments.id, environmentId))).for("update");
  if (!env) throw new NotFoundError("Environment");
  if (!env.haltedAt) throw new ConflictError("Environment is not halted.");
  const [result] = await tx
    .update(environments)
    .set({ haltedAt: null, haltedReason: null, haltedBy: null, updatedAt: nextVersion() })
    .where(and(eq(environments.workspaceId, workspaceId), eq(environments.id, environmentId)))
    .returning();
  await writeAuditEvents(tx, [resumeRecord(result, opts.actor, opts.context)]);
  return result;
  });
  await publishHaltState(environmentId, false, updated.updatedAt);
  logger.info({ workspaceId, environmentId, actor: opts.actor }, "Environment resumed");
  emitEvent(workspaceId, "environment.resumed", { environmentId, slug: updated.slug });

  return updated;
}

export async function isEnvironmentHalted(environmentId: string): Promise<boolean> {
  let cached: string | null;
  try {
    cached = await redis.get(RedisKeys.environmentHalt(environmentId));
  } catch {
    return (await readHaltState(environmentId)).halted;
  }

  if (cached !== null && cached.startsWith("1:")) return true;
  if (cached !== null && cached.startsWith("0:")) return false;

  const state = await readHaltState(environmentId);
  if (state.version !== null) {
    publishHaltState(environmentId, state.halted, state.version).catch(() => {});
  }
  return state.halted;
}

async function readHaltState(environmentId: string): Promise<{ halted: boolean; version: Date | null }> {
  try {
    const [row] = await db
      .select({ haltedAt: environments.haltedAt, updatedAt: environments.updatedAt })
      .from(environments)
      .where(eq(environments.id, environmentId))
      .limit(1);
    return { halted: row?.haltedAt != null, version: row?.updatedAt ?? null };
  } catch (error) {
    logger.error(
      { environmentId, err: error },
      "Halt state unreadable from Redis and Postgres; treating the environment as halted"
    );
    return { halted: true, version: null };
  }
}

function nextVersion() {
  return sql`greatest(${dbUtcNow()}, ${environments.updatedAt} + interval '1 millisecond')`;
}

const PUBLISH_HALT_STATE = `
local current = redis.call('GET', KEYS[1])
if current then
  local stored = tonumber(string.match(current, ':(%d+)$'))
  if stored and stored > tonumber(ARGV[2]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1] .. ':' .. ARGV[2])
return 1
`;

export async function publishHaltState(environmentId: string, halted: boolean, version: Date): Promise<void> {
  try {
    await redis.eval(PUBLISH_HALT_STATE, 1, RedisKeys.environmentHalt(environmentId), halted ? "1" : "0", String(version.getTime()));
  } catch (error) {
    await redis.del(RedisKeys.environmentHalt(environmentId)).catch(() => {});
    logger.error({ environmentId, err: error }, "Could not publish halt state to Redis; checks fall back to Postgres");
  }
}

export const HALT_RESYNC_CHUNK = 500;

export const HALT_RESYNC_LOCK_SECONDS = 55;

function haltCopyNeedsRepair(cached: string | null, halted: boolean): boolean {
  if (cached === null) return halted;
  if (cached.startsWith("1:")) return !halted;
  if (cached.startsWith("0:")) return halted;
  return true;
}

export async function syncHaltedEnvironments(): Promise<number> {
  const rows = await db
    .select({ id: environments.id, haltedAt: environments.haltedAt, updatedAt: environments.updatedAt })
    .from(environments);

  let halted = 0;
  let repaired = 0;
  for (let i = 0; i < rows.length; i += HALT_RESYNC_CHUNK) {
    const chunk = rows.slice(i, i + HALT_RESYNC_CHUNK);
    const cached = await redis.mget(chunk.map((env) => RedisKeys.environmentHalt(env.id)));

    const pipeline = redis.pipeline();
    let writes = 0;
    chunk.forEach((env, j) => {
      const isHalted = env.haltedAt != null;
      if (isHalted) halted++;
      if (!haltCopyNeedsRepair(cached[j] ?? null, isHalted)) return;
      pipeline.eval(
        PUBLISH_HALT_STATE, 1, RedisKeys.environmentHalt(env.id),
        isHalted ? "1" : "0", String(env.updatedAt.getTime()),
      );
      writes++;
    });
    if (writes > 0) await pipeline.exec();
    repaired += writes;
  }

  if (repaired > 0) {
    logger.warn({ halted, repaired, total: rows.length }, "Repaired environment halt state in Redis from DB");
  } else {
    logger.debug({ halted, total: rows.length }, "Environment halt state in Redis matches DB");
  }
  return halted;
}

export async function resyncHaltStateSweep(): Promise<boolean> {
  return withSweepLock(
    "halt-state-resync",
    HALT_RESYNC_LOCK_SECONDS,
    async () => { await syncHaltedEnvironments(); },
    { holdOnSuccess: true },
  );
}
