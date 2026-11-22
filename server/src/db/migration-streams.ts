import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { extensionDatabaseManifests, extensionSourceDir } from "../core/extensions/directory.ts";

export const MIGRATIONS_SCHEMA = "drizzle";

export const EARLIER_HISTORY = {
  table: "__drizzle_migrations",
  migrations: 118,
  last: {
    tag: "0119_mcp_upstream_end_user_key",
    when: 1794257324378,
    hash: "f321975ec29a99a2dce28f451f24d32a51c698f5c8e2856a18c583eed809c745",
  },
} as const;

export interface MigrationStream {
  name: string;
  folder: string;
  table: string;
  baselineOfHistory: boolean;
}

export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

export const serverRoot = (): string => process.cwd();

export function coreStream(root: string = serverRoot()): MigrationStream {
  return { name: "core", folder: resolve(root, "src/db/migrations"), table: "__core_migrations", baselineOfHistory: true };
}

export interface Streams {
  streams: MigrationStream[];
  historyFolder: string | null;
}

export function migrationStreams(options: { root?: string; extensionsDir?: string } = {}): Streams {
  const root = options.root ?? serverRoot();
  const manifests = extensionDatabaseManifests(options.extensionsDir ?? extensionSourceDir(root));
  const streams = [coreStream(root)];
  for (const { name, dbDir, manifest } of manifests) {
    if (!manifest.migrations) continue;
    streams.push({ name, folder: join(dbDir, manifest.migrations.folder), table: manifest.migrations.table, baselineOfHistory: manifest.migrations.baselineOfHistory === true });
  }
  const tables = streams.map((stream) => stream.table);
  if (new Set([...tables, EARLIER_HISTORY.table]).size !== tables.length + 1) throw new Error(`Two migration streams share a bookkeeping table: ${tables.join(", ")}`);
  const histories = manifests.filter(({ manifest }) => manifest.history);
  if (histories.length > 1) throw new Error(`More than one extension keeps the earlier history: ${histories.map(({ name }) => name).join(", ")}`);
  const historyFolder = histories[0] ? join(histories[0].dbDir, histories[0].manifest.history!.folder) : null;
  return { streams, historyFolder };
}

export function readJournal(folder: string): JournalEntry[] {
  const file = join(folder, "meta", "_journal.json");
  if (!existsSync(file)) throw new Error(`No migration journal at ${file}`);
  return (JSON.parse(readFileSync(file, "utf8")) as { entries: JournalEntry[] }).entries;
}

export function migrationRecord(folder: string, entry: JournalEntry): { hash: string; when: number } {
  const text = readFileSync(join(folder, `${entry.tag}.sql`)).toString();
  return { hash: createHash("sha256").update(text).digest("hex"), when: entry.when };
}

export function assertKnownHistory(folder: string): void {
  const entries = readJournal(folder);
  const last = entries[entries.length - 1];
  const record = last ? migrationRecord(folder, last) : null;
  if (entries.length !== EARLIER_HISTORY.migrations || last?.tag !== EARLIER_HISTORY.last.tag
    || record?.when !== EARLIER_HISTORY.last.when || record?.hash !== EARLIER_HISTORY.last.hash) {
    throw new Error(
      `The earlier migration history at ${folder} is not the one the streams were split from ` +
        `(${EARLIER_HISTORY.migrations} migrations ending at ${EARLIER_HISTORY.last.tag}). It is frozen: ` +
        "add a migration to a stream instead.",
    );
  }
}

export type HistoryState =
  | { state: "absent" }
  | { state: "complete"; rows: number }
  | { state: "incomplete"; rows: number; lastWhen: number | null };

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const bookkeeping = (table: string) => `${ident(MIGRATIONS_SCHEMA)}.${ident(table)}`;

async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const { rows } = await pool.query<{ found: string | null }>("SELECT to_regclass($1) AS found", [`${MIGRATIONS_SCHEMA}.${table}`]);
  return rows[0]?.found !== null && rows[0]?.found !== undefined;
}

export async function recordedCount(pool: Pool, table: string): Promise<number> {
  if (!(await tableExists(pool, table))) return 0;
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${bookkeeping(table)}`);
  return Number(rows[0]?.n ?? 0);
}

export async function historyState(pool: Pool): Promise<HistoryState> {
  const rows = await recordedCount(pool, EARLIER_HISTORY.table);
  if (rows === 0) return { state: "absent" };
  const { rows: [newest] } = await pool.query<{ hash: string; created_at: string | null }>(
    `SELECT hash, created_at FROM ${bookkeeping(EARLIER_HISTORY.table)} ORDER BY created_at DESC NULLS LAST LIMIT 1`,
  );
  const lastWhen = newest?.created_at === null || newest?.created_at === undefined ? null : Number(newest.created_at);
  if (lastWhen === EARLIER_HISTORY.last.when && newest?.hash === EARLIER_HISTORY.last.hash) return { state: "complete", rows };
  return { state: "incomplete", rows, lastWhen };
}

export interface MigrateReport {
  history: HistoryState["state"];
  historyApplied: number;
  adopted: string[];
  applied: Record<string, number>;
}

async function adoptBaselines(pool: Pool, streams: MigrationStream[]): Promise<string[]> {
  const adopted: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const stream of streams) {
      if (!stream.baselineOfHistory) continue;
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${ident(MIGRATIONS_SCHEMA)}`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${bookkeeping(stream.table)} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
      const { rows: [{ n }] } = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${bookkeeping(stream.table)}`);
      if (Number(n) > 0) continue;
      const [baseline] = readJournal(stream.folder);
      if (!baseline) throw new Error(`Migration stream "${stream.name}" has no baseline`);
      const record = migrationRecord(stream.folder, baseline);
      await client.query(`INSERT INTO ${bookkeeping(stream.table)} (hash, created_at) VALUES ($1, $2)`, [record.hash, record.when]);
      adopted.push(stream.name);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return adopted;
}

export async function migrateDatabase(pool: Pool, options: { root?: string; extensionsDir?: string } = {}): Promise<MigrateReport> {
  const { streams, historyFolder } = migrationStreams(options);
  for (const stream of streams) readJournal(stream.folder);
  if (historyFolder) assertKnownHistory(historyFolder);
  const db = drizzle(pool);
  const core = streams[0]!;
  const report: MigrateReport = { history: "absent", historyApplied: 0, adopted: [], applied: {} };

  if (historyFolder && (await recordedCount(pool, core.table)) === 0) {
    const before = await recordedCount(pool, EARLIER_HISTORY.table);
    await migrate(db, { migrationsFolder: historyFolder });
    report.historyApplied = (await recordedCount(pool, EARLIER_HISTORY.table)) - before;
  }

  const history = await historyState(pool);
  report.history = history.state;
  if (history.state === "incomplete" && (await recordedCount(pool, core.table)) === 0) {
    throw new Error(
      `This database applied ${history.rows} of the ${EARLIER_HISTORY.migrations} migrations of the earlier single history ` +
        `(drizzle.${EARLIER_HISTORY.table}; newest created_at ${history.lastWhen ?? "unknown"}, expected ${EARLIER_HISTORY.last.when}). ` +
        "Upgrade it with a release from before the migration split first, which finishes that history.",
    );
  }
  if (history.state === "complete") report.adopted = await adoptBaselines(pool, streams);

  for (const stream of streams) {
    const before = await recordedCount(pool, stream.table);
    await migrate(db, { migrationsFolder: stream.folder, migrationsTable: stream.table, migrationsSchema: MIGRATIONS_SCHEMA });
    report.applied[stream.name] = (await recordedCount(pool, stream.table)) - before;
  }
  return report;
}
