import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.ts";
import { workspaces } from "../src/db/schema/workspaces.ts";
import { normalizePlan } from "../src/core/plans/limits.ts";
import { setContractRetention } from "../src/core/audit/lifecycle.ts";

const args = process.argv.slice(2);
const value = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const actor = process.env.RELEASE_ACTOR ?? process.env.USERNAME ?? process.env.USER ?? "operator";

async function main() {
  const workspaceId = value("workspace");
  const monthsArg = value("months");
  const reason = value("reason")?.trim();
  if (!workspaceId || !/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new Error("--workspace <uuid> is required.");
  if (!monthsArg || (monthsArg !== "default" && !/^\d+$/.test(monthsArg))) throw new Error("--months is required: a whole number of months (1 to 120), or default.");
  if (!reason) throw new Error("--reason \"<why>\" is required; it is written to the audit log.");

  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new Error("No workspace has that id. Nothing was changed.");
  if (normalizePlan(workspace.plan) !== "enterprise") {
    throw new Error("Contract retention applies to Enterprise workspaces only; this one is on another plan. Nothing was changed.");
  }

  const months = monthsArg === "default" ? null : Number(monthsArg);
  const { from, to } = await setContractRetention(workspaceId, months, actor, reason);
  console.log(JSON.stringify({ workspaceId, fromMonths: from, toMonths: to, reason, actor, audited: true }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Setting the audit retention failed.");
  process.exitCode = 1;
} finally {
  process.exit(process.exitCode ?? 0);
}
