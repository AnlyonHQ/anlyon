import { Pool } from "pg";
import { migrateDatabase } from "../src/db/migration-streams.ts";
import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import { resolveTestTargets } from "../tests/support/test-target.ts";

let fileEnv: Record<string, string> = {};
try {
  fileEnv = parse(readFileSync(new URL("../.env", import.meta.url)));
} catch {
}
const testVar = (name: string) => process.env[name] ?? fileEnv[name];

const targets = resolveTestTargets({
  TEST_DATABASE_URL: testVar("TEST_DATABASE_URL"),
  TEST_REDIS_URL: testVar("TEST_REDIS_URL"),
  TEST_TARGETS_DISPOSABLE: testVar("TEST_TARGETS_DISPOSABLE"),
  TEST_DATABASE_NAME_ACK: testVar("TEST_DATABASE_NAME_ACK"),
  TEST_REDIS_SHARED_ACK: testVar("TEST_REDIS_SHARED_ACK"),
  DATABASE_URL: process.env.DATABASE_URL ?? fileEnv.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL ?? fileEnv.REDIS_URL,
});
if (!targets.ok) {
  console.error(`Refusing to migrate: ${targets.reason}`);
  process.exit(2);
}

const pool = new Pool({ connectionString: targets.databaseUrl, max: 1 });
try {
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  const { rows } = await pool.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
  if (rows.length === 0) throw new Error("pgvector is not available on this database");
  const report = await migrateDatabase(pool);
  console.log(`Earlier history: ${report.history}; recorded baselines: ${report.adopted.join(", ") || "none"}; applied: ${JSON.stringify(report.applied)}.`);
  console.log("Migrations applied to the test database (pgvector enabled, migrations unchanged).");
} catch (error) {
  console.error("Migration failed:", error instanceof Error ? error.message : "error");
  process.exit(1);
} finally {
  await pool.end();
}
