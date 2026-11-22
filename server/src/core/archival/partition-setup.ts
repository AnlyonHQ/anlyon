import type { Pool } from "pg";
import {
  SHARED_PARTITION_FUNCTIONS_SQL,
  assertPartitionedLogSpec,
  createPartitionedTableSql,
  partitionFunctionSql,
  type PartitionedLogSpec,
} from "./partitioned-logs.ts";

const BATCH_SIZE = 10000;

export interface SetupOptions {
  dryRun: boolean;
  skipMigration: boolean;
  log: (line: string) => void;
}

export interface SetupResult {
  tables: Record<string, "already_done" | "created" | "converted" | "conversion_started">;
}

export async function setUpLogPartitions(pool: Pool, specs: PartitionedLogSpec[], options: SetupOptions): Promise<SetupResult> {
  for (const spec of specs) assertPartitionedLogSpec(spec);
  const tables = specs.map((spec) => spec.table);
  if (new Set(tables).size !== tables.length) throw new Error(`A partitioned log is described twice: ${tables.join(", ")}`);
  const result: SetupResult = { tables: {} };
  let sharedFunctionsCreated = false;
  const ensureSharedFunctions = async () => {
    if (sharedFunctionsCreated) return;
    await runSql(pool, options, SHARED_PARTITION_FUNCTIONS_SQL, "Would create the shared partition functions");
    sharedFunctionsCreated = true;
  };

  for (const spec of specs) {
    options.log(`── ${spec.table} ──`);
    options.log("Step 1: Checking prerequisites...");
    const status = await checkPrerequisites(pool, spec);

    if (status === "already_done") {
      options.log("✓ Partitioning already set up. Nothing to do.\n");
      result.tables[spec.table] = "already_done";
      continue;
    }

    if (status === "fresh") {
      options.log("✓ Fresh deployment detected - creating partitioned table from scratch\n");

      options.log("Step 2: Creating partitioned table...");
      await runSql(pool, options, createPartitionedTableSql(spec), `Would create ${spec.table} (partitioned)`);
      options.log("✓ Partitioned table created\n");

      options.log("Step 3: Creating partition helper functions...");
      await ensureSharedFunctions();
      await runSql(pool, options, partitionFunctionSql(spec), `Would create ${spec.partitionFunction}`);
      options.log("✓ Helper functions created\n");

      options.log("Step 4: Creating initial partitions...");
      await createFreshInitialPartitions(pool, options, spec);
      options.log("✓ Initial partitions created\n");
      result.tables[spec.table] = "created";
      continue;
    }

    options.log("✓ Prerequisites met - converting the existing table\n");

    options.log("Step 2: Creating partitioned table...");
    await runSql(pool, options, createPartitionedTableSql(spec, `${spec.table}_partitioned`), `Would create ${spec.table}_partitioned`);
    options.log("✓ Partitioned table created\n");

    options.log("Step 3: Creating partition helper functions...");
    await ensureSharedFunctions();
    await runSql(pool, options, partitionFunctionSql(spec, `${spec.table}_partitioned`), `Would create ${spec.partitionFunction}`);
    options.log("✓ Helper functions created\n");

    options.log("Step 4: Creating initial partitions...");
    await createInitialPartitions(pool, options, spec);
    options.log("✓ Initial partitions created\n");

    result.tables[spec.table] = "conversion_started";
    if (!options.skipMigration) {
      options.log("Step 5: Migrating existing data...");
      await migrateTable(pool, options, spec);
      options.log("✓ Data migration complete\n");

      options.log("Step 6: Renaming tables...");
      await renameTables(pool, options, spec);
      options.log("✓ Tables renamed\n");
      result.tables[spec.table] = "converted";
    }
  }
  return result;
}

async function runSql(pool: Pool, options: SetupOptions, sql: string, dryRunNote: string): Promise<void> {
  if (options.dryRun) {
    options.log(`  [DRY RUN] ${dryRunNote}`);
    return;
  }
  await pool.query(sql);
}

async function checkPrerequisites(pool: Pool, spec: PartitionedLogSpec): Promise<"ready" | "already_done" | "fresh"> {
  const alreadyPartitioned = await pool.query(
    `SELECT relname FROM pg_class WHERE relname = $1 AND relkind = 'p'`,
    [spec.table],
  );

  if (alreadyPartitioned.rows.length > 0) {
    return "already_done";
  }

  const result = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [spec.table],
  );

  if (result.rows.length === 0) {
    return "fresh";
  }

  const partitionedCheck = await pool.query(
    `SELECT relname FROM pg_class WHERE relname = $1 AND relkind = 'p'`,
    [`${spec.table}_partitioned`],
  );

  if (partitionedCheck.rows.length > 0) {
    throw new Error(
      "Partitioned table exists but setup incomplete. Manual intervention required:\n" +
      `DROP TABLE IF EXISTS ${spec.table}_partitioned CASCADE;`
    );
  }

  return "ready";
}

async function createFreshInitialPartitions(pool: Pool, options: SetupOptions, spec: PartitionedLogSpec): Promise<void> {
  const today = new Date();
  const futureDate = new Date();
  futureDate.setDate(today.getDate() + 7);

  options.log(`  Date range: ${today.toISOString().split('T')[0]} to ${futureDate.toISOString().split('T')[0]}`);

  if (options.dryRun) {
    options.log(`  [DRY RUN] Would create 8 partitions`);
    return;
  }

  const currentDate = new Date(today);
  let partitionsCreated = 0;

  while (currentDate <= futureDate) {
    const dateStr = currentDate.toISOString().split('T')[0];
    const nextDate = new Date(currentDate);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateStr = nextDate.toISOString().split('T')[0];
    const partName = `${spec.table}_${dateStr.replace(/-/g, '')}`;

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${partName}
        PARTITION OF ${spec.table}
        FOR VALUES FROM ('${dateStr}') TO ('${nextDateStr}');
    `);

    partitionsCreated++;
    currentDate.setDate(currentDate.getDate() + 1);
  }

  options.log(`  Created ${partitionsCreated} partitions`);
}

async function createInitialPartitions(pool: Pool, options: SetupOptions, spec: PartitionedLogSpec): Promise<void> {
  const range = await pool.query(
    `SELECT MIN(${spec.partitionColumn})::date as min_date, MAX(${spec.partitionColumn})::date as max_date FROM ${spec.table}`,
  );

  const today = new Date();
  const futureDate = new Date();
  futureDate.setDate(today.getDate() + 7);

  let startDate = today;
  let endDate = futureDate;

  if (range.rows[0]?.min_date) {
    const min = new Date(range.rows[0].min_date);
    if (min < startDate) startDate = min;
  }
  if (range.rows[0]?.max_date) {
    const max = new Date(range.rows[0].max_date);
    if (max > endDate) endDate = max;
  }

  endDate = new Date(Math.max(endDate.getTime(), futureDate.getTime()));

  options.log(`  Date range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);

  if (options.dryRun) {
    const days = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    options.log(`  [DRY RUN] Would create ${days} partitions`);
    return;
  }

  const currentDate = new Date(startDate);
  let partitionsCreated = 0;

  while (currentDate <= endDate) {
    const dateStr = currentDate.toISOString().split('T')[0];
    await pool.query(`SELECT ${spec.partitionFunction}($1::date)`, [dateStr]);
    partitionsCreated++;
    currentDate.setDate(currentDate.getDate() + 1);
  }

  options.log(`  Created ${partitionsCreated} partitions`);
}

async function migrateTable(pool: Pool, options: SetupOptions, spec: PartitionedLogSpec): Promise<void> {
  const sourceTable = spec.table;
  const targetTable = `${spec.table}_partitioned`;
  const columns = spec.columns.map((column) => column.split(" ")[0]);
  options.log(`  Migrating ${sourceTable}...`);

  const countResult = await pool.query(`SELECT COUNT(*) as count FROM ${sourceTable}`);
  const totalRecords = parseInt(countResult.rows[0].count);

  if (totalRecords === 0) {
    options.log(`    No records in ${sourceTable}`);
    return;
  }

  options.log(`    ${totalRecords} records to migrate`);

  if (options.dryRun) {
    options.log(`    [DRY RUN] Would migrate ${totalRecords} records`);
    return;
  }

  const columnList = columns.join(", ");
  let migrated = 0;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    while (migrated < totalRecords) {
      const result = await client.query(`
        INSERT INTO ${targetTable} (${columnList})
        SELECT ${columnList}
        FROM ${sourceTable}
        ORDER BY id
        LIMIT ${BATCH_SIZE}
        OFFSET ${migrated}
      `);

      migrated += result.rowCount || 0;
      const progress = Math.round((migrated / totalRecords) * 100);
      options.log(`    Progress: ${migrated}/${totalRecords} (${progress}%)`);
    }

    await client.query("COMMIT");
    options.log("");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function renameTables(pool: Pool, options: SetupOptions, spec: PartitionedLogSpec): Promise<void> {
  if (options.dryRun) {
    options.log("  [DRY RUN] Would rename tables:");
    options.log(`    ${spec.table} → ${spec.table}_old`);
    options.log(`    ${spec.table}_partitioned → ${spec.table}`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`ALTER TABLE ${spec.table} RENAME TO ${spec.table}_old`);
    await client.query(`ALTER TABLE ${spec.table}_partitioned RENAME TO ${spec.table}`);

    await client.query(partitionFunctionSql(spec));

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

