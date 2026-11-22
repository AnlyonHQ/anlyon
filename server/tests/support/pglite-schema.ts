import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

export const CORE_MIGRATIONS = new URL("../../src/db/migrations/", import.meta.url);

export async function migratedDatabase(options: { until?: string; folders?: URL[] } = {}): Promise<PGlite> {
  const folders = options.folders ?? [CORE_MIGRATIONS];
  const client = new PGlite();
  await client.exec("BEGIN");
  for (const [i, folder] of folders.entries()) {
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", folder), "utf8")) as { entries: { tag: string }[] };
    const isLast = i === folders.length - 1;
    const stop = isLast && options.until ? journal.entries.findIndex((entry) => entry.tag === options.until) : -1;
    if (isLast && options.until && stop < 0) throw new Error(`No migration ${options.until} in the journal`);
    for (const { tag } of stop >= 0 ? journal.entries.slice(0, stop) : journal.entries) {
      await runMigration(client, folder, tag);
    }
  }
  await client.exec("COMMIT");
  return client;
}

export async function applyMigration(client: PGlite, tag: string, folder: URL = CORE_MIGRATIONS): Promise<void> {
  await client.exec("BEGIN");
  await runMigration(client, folder, tag);
  await client.exec("COMMIT");
}

async function runMigration(client: PGlite, folder: URL, tag: string): Promise<void> {
  const sql = readFileSync(new URL(`${tag}.sql`, folder), "utf8")
    .replace(/(?:public\.)?vector\(\d+\)/g, "real[]")
    .replace(/CREATE INDEX[^;]*USING hnsw[^;]*;/gi, "");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.exec(statement);
  }
}
