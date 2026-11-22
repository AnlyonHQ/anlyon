import { pool } from "../db/index.ts";
import { backfillAuditHistory } from "../core/audit/backfill.ts";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const workspaceIndex = args.indexOf("--workspace");
  const workspaceId = workspaceIndex >= 0 ? args[workspaceIndex + 1] : undefined;
  if (workspaceIndex >= 0 && !workspaceId) {
    console.error("--workspace needs a workspace id");
    return 2;
  }

  const result = await backfillAuditHistory({ workspaceId, dryRun: !apply });
  console.log(apply ? "Audit history backfill" : "Audit history backfill (dry run, nothing written; pass --apply)");
  for (const [source, counts] of Object.entries(result.sources)) {
    console.log(`  ${source.padEnd(15)} built=${counts.built}${apply ? ` inserted=${counts.inserted}` : ""}`);
  }
  if (apply) console.log(`\n${result.inserted} record(s) inserted. Re-running inserts none.`);
  return 0;
}

main()
  .then(async (code) => {
    await pool.end().catch(() => {});
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await pool.end().catch(() => {});
    process.exit(1);
  });
