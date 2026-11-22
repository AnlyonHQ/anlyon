import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { mcpUpstreams, type McpUpstream } from "../../db/schema/mcp-upstreams.ts";
import { createLogger } from "../../lib/logger.ts";
import { checkUpstream } from "./service.ts";
import { CHECK_LEASE_MS } from "./tool-changes.ts";

const logger = createLogger({ module: "mcp-tool-checks" });

export const SWEEP_INTERVAL_MS = 15 * 60_000;
export const SWEEP_BATCH = 20;
export const SWEEP_BUDGET_MS = 10 * 60_000;

export async function claimDueUpstream(now: Date): Promise<McpUpstream | null> {
  return db.transaction(async (tx) => {
    const [due] = await tx.select({ id: mcpUpstreams.id }).from(mcpUpstreams)
      .where(and(
        isNull(mcpUpstreams.archivedAt),
        lte(mcpUpstreams.nextCheckAt, now),
        sql`not (${mcpUpstreams.oauth} is not null and ${mcpUpstreams.operatorConnectionId} is null and ${mcpUpstreams.listedWith} is distinct from 'anonymous')`,
      ))
      .orderBy(asc(mcpUpstreams.nextCheckAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!due) return null;
    const [claimed] = await tx.update(mcpUpstreams)
      .set({ nextCheckAt: new Date(now.getTime() + CHECK_LEASE_MS) })
      .where(eq(mcpUpstreams.id, due.id))
      .returning();
    return claimed ?? null;
  });
}

export interface ToolCheckSweepResult {
  checked: number;
  failed: number;
  errored: number;
}

export async function sweepUpstreamToolChecks(clock: () => Date = () => new Date()): Promise<ToolCheckSweepResult> {
  const started = clock().getTime();
  const result: ToolCheckSweepResult = { checked: 0, failed: 0, errored: 0 };
  for (let i = 0; i < SWEEP_BATCH; i++) {
    const now = clock();
    if (now.getTime() - started >= SWEEP_BUDGET_MS) break;
    const upstream = await claimDueUpstream(now);
    if (!upstream) break;
    try {
      const after = await checkUpstream(upstream, "scheduled");
      if (after.lastError) result.failed++;
      else result.checked++;
    } catch (error) {
      result.errored++;
      logger.warn({ upstreamId: upstream.upstreamId, error: error instanceof Error ? error.message : String(error) }, "An MCP upstream could not be checked");
    }
  }
  if (result.checked + result.failed + result.errored > 0) logger.info({ ...result }, "MCP tool check sweep completed");
  return result;
}
