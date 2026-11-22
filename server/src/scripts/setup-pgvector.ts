import { Pool } from "pg";

if (process.env.NODE_ENV !== "production") {
  const dotenv = await import("dotenv");
  dotenv.config();
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    statement_timeout: 60000,
  });

  console.log("=".repeat(70));
  console.log("pgvector Extension Setup");
  console.log("=".repeat(70));

  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector;");

    const { rows } = await pool.query(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector';"
    );

    if (rows.length === 0) {
      throw new Error(
        "vector extension not found after CREATE EXTENSION  is this a pgvector-enabled Postgres image (pgvector/pgvector:pg16)?"
      );
    }

    console.log(`✓ vector extension ready (version ${rows[0].extversion})`);
    console.log("=".repeat(70));
    console.log("Setup complete");
    console.log("=".repeat(70));
  } catch (error) {
    console.error("❌ Failed to enable pgvector extension:");
    console.error(error instanceof Error ? error.message : error);
    console.error(
      "\nHint: the Postgres image must include pgvector. Use `pgvector/pgvector:pg16`,\n" +
        "or install the extension package in your managed Postgres."
    );
    await pool.end();
    process.exit(1);
  }

  await pool.end();
}

main();
