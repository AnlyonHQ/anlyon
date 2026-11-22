import { Pool } from "pg";
import { MESSAGE_EXECUTION_LOGS, type PartitionedLogSpec } from "../core/archival/partitioned-logs.ts";
import { setUpLogPartitions } from "../core/archival/partition-setup.ts";
import { extensionDatabaseManifests } from "../core/extensions/directory.ts";

if (process.env.NODE_ENV !== "production") {
  const dotenv = await import("dotenv");
  dotenv.config();
}

const DRY_RUN = process.argv.includes("--dry-run");
const SKIP_MIGRATION = process.argv.includes("--skip-migration");

function partitionedLogsToSetUp(): PartitionedLogSpec[] {
  const specs = [MESSAGE_EXECUTION_LOGS];
  for (const { manifest } of extensionDatabaseManifests()) specs.push(...(manifest.partitionedLogs ?? []));
  return specs;
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    statement_timeout: 300000,
  });

  console.log("=".repeat(70));
  console.log("PostgreSQL Log Partitioning Setup");
  console.log("=".repeat(70));
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE"}`);
  console.log(`Data Migration: ${SKIP_MIGRATION ? "SKIPPED" : "ENABLED"}`);
  console.log("");

  try {
    const specs = partitionedLogsToSetUp();
    console.log(`Partitioned logs: ${specs.map((spec) => spec.table).join(", ")}\n`);
    const result = await setUpLogPartitions(pool, specs, { dryRun: DRY_RUN, skipMigration: SKIP_MIGRATION, log: (line) => console.log(line) });
    const converted = Object.entries(result.tables).filter(([, state]) => state === "converted").map(([table]) => table);

    console.log("=".repeat(70));
    console.log("Setup Complete!");
    console.log("=".repeat(70));

    if (DRY_RUN) {
      console.log("\n⚠️  DRY RUN: No changes were made.");
      console.log("Run without --dry-run to execute.");
    } else if (SKIP_MIGRATION) {
      console.log("\nPartitioned tables created. Data migration was skipped.");
      console.log("Run without --skip-migration to migrate existing data.");
    } else if (converted.length > 0) {
      console.log("\nPartitioned tables are now active!");
      console.log("\nNext steps:");
      console.log("  1. Verify application works correctly");
      console.log("  2. After verification, drop old tables:");
      for (const table of converted) console.log(`     DROP TABLE IF EXISTS ${table}_old;`);
    }
  } catch (error) {
    console.error("\n❌ Setup failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
