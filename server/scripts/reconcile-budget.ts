import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../src/db/index.ts";
import { budgetPeriods } from "../src/db/schema/billing.ts";
import { apiKeys } from "../src/db/schema/workspaces.ts";
import { redis, RedisKeys, closeRedis } from "../src/lib/redis.ts";
import { BUDGET_DIMENSIONS, reconcileBudgetPeriod } from "../src/core/billing/budgets.ts";

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const quantity = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const importSchema = z.object({
  apiKeyId: z.string().uuid(), month: monthSchema,
  floor: z.object({ messages: quantity, eventPublishes: quantity, actionInvokes: quantity }).strict(),
  note: z.string().trim().min(1).max(2000),
}).strict();

async function inspect(apiKeyId: string, month: string) {
  const [key] = await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.id, apiKeyId));
  if (!key) throw new Error("API key not found");
  const [period] = await db.select().from(budgetPeriods).where(and(eq(budgetPeriods.apiKeyId, apiKeyId), eq(budgetPeriods.month, month)));
  const counters = await redis.mget(...BUDGET_DIMENSIONS.map(d => RedisKeys.keyBudgetCounter(apiKeyId, d, month)));
  const legacy = Object.fromEntries(BUDGET_DIMENSIONS.map((d, i) => [d, counters[i]]));
  return { apiKeyId, month, durable: period ?? null, legacyCounters: legacy,
    warning: "Redis values are evidence inputs only. Null means unknown. Verify every floor from retained evidence with old writers stopped." };
}

async function main() {
  const [mode, argument, extra, ...rest] = process.argv.slice(2);
  if (rest.length) throw new Error("Unexpected arguments");
  if (mode === "inspect") {
    const report = await inspect(z.string().uuid().parse(argument), monthSchema.parse(extra));
    console.log(JSON.stringify(report, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
    return;
  }
  if ((mode !== "plan" && mode !== "apply") || !argument || (mode === "plan" && extra) || (mode === "apply" && extra !== "--writers-quiesced")) {
    throw new Error("Usage: reconcile-budget.ts inspect KEY_UUID YYYY-MM | plan FILE.json | apply FILE.json --writers-quiesced");
  }
  if ((await stat(argument)).size > 64 * 1024) throw new Error("Import file exceeds 64 KiB");
  const input = importSchema.parse(JSON.parse(await readFile(argument, "utf8")));
  const report = await inspect(input.apiKeyId, input.month);
  for (const dimension of BUDGET_DIMENSIONS) {
    const raw = report.legacyCounters[dimension];
    if (raw !== null && (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))) {
      throw new Error(`Invalid legacy ${dimension} counter; investigate before import`);
    }
    if (raw !== null && input.floor[dimension] < Number(raw)) {
      throw new Error(`Verified ${dimension} floor is lower than retained Redis usage`);
    }
  }
  console.log(JSON.stringify({ mode, ...report, verifiedImport: input }, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
  if (mode === "apply") {
    await reconcileBudgetPeriod(input.apiKeyId, input.month, input.floor, input.note);
    console.log("Verified floor imported. Known durable usage was not reduced.");
  }
}

try { await main(); }
catch (error) { console.error(error instanceof Error ? error.message : "Budget reconciliation failed"); process.exitCode = 1; }
finally { await pool.end(); await closeRedis(); }
