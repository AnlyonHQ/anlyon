import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { EARLIER_HISTORY, coreStream, migrateDatabase, readJournal } from "../src/db/migration-streams.ts";
import { MESSAGE_EXECUTION_LOGS } from "../src/core/archival/partitioned-logs.ts";
import { setUpLogPartitions } from "../src/core/archival/partition-setup.ts";
import * as coreSchema from "../src/db/schema/index.ts";
import { messageExecutionLogs } from "../src/db/schema/execution-logs.ts";
import { createThrowawayDatabase, testServerPrivileges, type ThrowawayDatabase } from "./support/throwaway-database.ts";
import { fingerprintDiff, fingerprintTables, schemaFingerprint } from "./support/schema-fingerprint.ts";

const required = process.env.ANLYON_REQUIRE_TEST_TARGETS === "1";
const NO_EXTENSIONS = mkdtempSync(join(tmpdir(), "anlyon-no-extensions-"));

interface Snapshot {
  tables: Record<string, { columns: Record<string, { notNull: boolean }> }>;
  enums: Record<string, { name: string; values: string[] }>;
}
const core = coreStream();
const journal = readJournal(core.folder);
const snapshot = JSON.parse(readFileSync(join(core.folder, "meta", `${String(journal.at(-1)!.idx).padStart(4, "0")}_snapshot.json`), "utf8")) as Snapshot;

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("core migration stream (real databases)", () => {
  const databases: ThrowawayDatabase[] = [];
  let allowed = true;
  let publicDb: ThrowawayDatabase;

  beforeAll(async () => {
    const privileges = await testServerPrivileges();
    if (!privileges.createDatabases) {
      const message = "The test role cannot CREATE DATABASE, so the migration stream tests cannot make databases of their own.";
      if (required) throw new Error(message);
      console.warn(`\n[migration-streams] ${message} SKIPPED, not passed.\n`);
      allowed = false;
      return;
    }
    publicDb = await createThrowawayDatabase("core_public");
    databases.push(publicDb);
  });

  afterAll(async () => {
    for (const database of databases) await database.drop();
  });

  it("creates exactly core's schema on an empty database, and nothing on a second run", async ({ skip }) => {
    if (!allowed) skip();
    const report = await migrateDatabase(publicDb.pool, { extensionsDir: NO_EXTENSIONS });
    expect(report).toEqual({ history: "absent", historyApplied: 0, adopted: [], applied: { core: journal.length } });

    const fingerprint = await schemaFingerprint(publicDb.pool);
    const expectedTables = Object.keys(snapshot.tables).map((key) => key.replace(/^public\./, "")).sort();
    expect(fingerprintTables(fingerprint)).toEqual(expectedTables);

    const columns = fingerprint.lines.filter((line) => line.startsWith("column|")).map((line) => {
      const [, table, column, , notNull] = line.split("|");
      return `${table}.${column}:${notNull}`;
    }).sort();
    const declared = Object.entries(snapshot.tables).flatMap(([key, table]) =>
      Object.entries(table.columns).map(([column, spec]) => `${key.replace(/^public\./, "")}.${column}:${spec.notNull}`)).sort();
    expect(columns).toEqual(declared);

    const enums = fingerprint.lines.filter((line) => line.startsWith("enum|")).map((line) => line.slice("enum|".length)).sort();
    expect(enums).toEqual(Object.values(snapshot.enums).map((e) => `${e.name}|${e.values.join(",")}`).sort());

    const db = drizzle(publicDb.pool);
    const tables = Object.values(coreSchema).filter((value): value is PgTable => is(value, PgTable));
    expect(tables.map((table) => getTableName(table)).sort()).toEqual(expectedTables);
    for (const table of tables) {
      await expect(db.select(getTableColumns(table)).from(table).limit(0), getTableName(table)).resolves.toEqual([]);
    }

    const again = await migrateDatabase(publicDb.pool, { extensionsDir: NO_EXTENSIONS });
    expect(again.applied).toEqual({ core: 0 });
    expect(fingerprintDiff(fingerprint, await schemaFingerprint(publicDb.pool))).toEqual({ onlyInA: [], onlyInB: [] });
  });

  it("sets up core's partitioned log and no other", async ({ skip }) => {
    if (!allowed) skip();
    const result = await setUpLogPartitions(publicDb.pool, [MESSAGE_EXECUTION_LOGS], { dryRun: false, skipMigration: false, log: () => {} });
    expect(result.tables).toEqual({ message_execution_logs: "created" });
    const { rows } = await publicDb.pool.query<{ relname: string }>("SELECT relname FROM pg_class WHERE relkind = 'p' ORDER BY relname");
    expect(rows.map((row) => row.relname)).toEqual(["message_execution_logs"]);
    await expect(drizzle(publicDb.pool).select(getTableColumns(messageExecutionLogs)).from(messageExecutionLogs).limit(0)).resolves.toEqual([]);
    const second = await setUpLogPartitions(publicDb.pool, [MESSAGE_EXECUTION_LOGS], { dryRun: false, skipMigration: false, log: () => {} });
    expect(second.tables).toEqual({ message_execution_logs: "already_done" });
  });

  it("records the baseline of a database that applied the whole earlier history, running no DDL on its schema", async ({ skip }) => {
    if (!allowed) skip();
    const earlier = await createThrowawayDatabase("core_adopt");
    databases.push(earlier);
    await migrateDatabase(earlier.pool, { extensionsDir: NO_EXTENSIONS });
    await earlier.pool.query("DROP TABLE drizzle.__core_migrations");
    await earlier.pool.query(`CREATE TABLE drizzle.${EARLIER_HISTORY.table} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    await earlier.pool.query(`INSERT INTO drizzle.${EARLIER_HISTORY.table} (hash, created_at) VALUES ('older', 1700000000000), ($1, $2)`,
      [EARLIER_HISTORY.last.hash, EARLIER_HISTORY.last.when]);
    const before = await schemaFingerprint(earlier.pool);

    const report = await migrateDatabase(earlier.pool, { extensionsDir: NO_EXTENSIONS });
    expect(report).toEqual({ history: "complete", historyApplied: 0, adopted: ["core"], applied: { core: 0 } });
    expect(fingerprintDiff(before, await schemaFingerprint(earlier.pool))).toEqual({ onlyInA: [], onlyInB: [] });
    const { rows } = await earlier.pool.query<{ hash: string; created_at: string }>("SELECT hash, created_at FROM drizzle.__core_migrations");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.created_at)).toBe(journal[0]!.when);
  });

  it("refuses a database that applied only part of the earlier history", async ({ skip }) => {
    if (!allowed) skip();
    const behind = await createThrowawayDatabase("core_behind");
    databases.push(behind);
    await behind.pool.query("CREATE SCHEMA drizzle");
    await behind.pool.query(`CREATE TABLE drizzle.${EARLIER_HISTORY.table} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    await behind.pool.query(`INSERT INTO drizzle.${EARLIER_HISTORY.table} (hash, created_at) VALUES ('older', 1700000000000)`);
    await expect(migrateDatabase(behind.pool, { extensionsDir: NO_EXTENSIONS })).rejects.toThrow(/applied 1 of the 118 migrations/);
    const { rows } = await behind.pool.query("SELECT to_regclass('drizzle.__core_migrations') AS t, (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') AS n");
    expect(rows[0]).toEqual({ t: null, n: "0" });
  });
});
