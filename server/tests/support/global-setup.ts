import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import { resolveTestTargets } from "./test-target.ts";

let fileEnv: Record<string, string> = {};
try {
  fileEnv = parse(readFileSync(new URL("../../.env", import.meta.url)));
} catch {
}
const testVar = (name: string) => process.env[name] ?? fileEnv[name];

export default async function setup() {
  const targets = resolveTestTargets({
    TEST_DATABASE_URL: testVar("TEST_DATABASE_URL"),
    TEST_REDIS_URL: testVar("TEST_REDIS_URL"),
    TEST_TARGETS_DISPOSABLE: testVar("TEST_TARGETS_DISPOSABLE"),
    TEST_DATABASE_NAME_ACK: testVar("TEST_DATABASE_NAME_ACK"),
    TEST_REDIS_SHARED_ACK: testVar("TEST_REDIS_SHARED_ACK"),
    TEST_REDIS_SCOPED_ACK: process.env.TEST_REDIS_SCOPED_ACK,
    DATABASE_URL: fileEnv.DATABASE_URL,
    REDIS_URL: fileEnv.REDIS_URL,
  });

  if (!targets.ok) {
    const message = `Integration tests have no valid test target and will be SKIPPED, not passed. ${targets.reason}`;
    if (process.env.ANLYON_REQUIRE_TEST_TARGETS === "1") throw new Error(message);
    console.warn(`\n[test-target] ${message}\n`);
    return;
  }

  const pool = new Pool({ connectionString: targets.databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const { rows } = await pool.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
    if (rows.length === 0) {
      throw new Error(
        "The test database has no pgvector extension enabled. Run src/scripts/setup-pgvector.ts against it first. " +
          "Migrations are applied unchanged; vector columns are never replaced.",
      );
    }
  } finally {
    await pool.end().catch(() => {});
  }
}
