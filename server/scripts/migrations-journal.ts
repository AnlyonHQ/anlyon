import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { assertKnownHistory, migrationStreams } from "../src/db/migration-streams.ts";

type JournalEntry = { idx: number; when: number; tag: string };

function checkStream(name: string, MIGRATIONS: string): string[] {
  const JOURNAL = resolve(MIGRATIONS, "meta/_journal.json");
  if (!existsSync(JOURNAL)) return [`${name}: meta/_journal.json is missing in ${MIGRATIONS}.`];
  const journal = JSON.parse(readFileSync(JOURNAL, "utf8")) as { entries: JournalEntry[] };
  const entries = journal.entries ?? [];

  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.replace(/\.sql$/, ""))
    .sort();

  const registered = new Set(entries.map((entry) => entry.tag));
  const problems: string[] = [];

  const unregistered = files.filter((tag) => !registered.has(tag));
  for (const tag of unregistered) {
    problems.push(
      `${tag}.sql is not in meta/_journal.json  the deploy migrator will never apply it.`,
    );
  }

  const missingFile = entries.filter((entry) => !files.includes(entry.tag));
  for (const entry of missingFile) {
    problems.push(`meta/_journal.json lists "${entry.tag}" but ${entry.tag}.sql does not exist.`);
  }

  const ordered = [...entries].sort((a, b) => a.idx - b.idx);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].when <= ordered[i - 1].when) {
      problems.push(
        `meta/_journal.json: "${ordered[i].tag}" has when=${ordered[i].when}, which is not greater than "${ordered[i - 1].tag}" (${ordered[i - 1].when}). A database at the earlier migration would skip it.`,
      );
    }
  }

  const latest = ordered[ordered.length - 1];
  if (latest) {
    const snapshot = resolve(MIGRATIONS, `meta/${String(latest.idx).padStart(4, "0")}_snapshot.json`);
    if (!existsSync(snapshot)) {
      problems.push(
        `meta/${String(latest.idx).padStart(4, "0")}_snapshot.json is missing for the newest migration ("${latest.tag}"). ` +
          `The next 'pnpm db:generate' will diff against an older snapshot and re-emit every change since then, ` +
          `including CREATE TABLE for tables that already exist. Generate the migration with 'pnpm db:generate' ` +
          `(it writes the snapshot too) rather than hand-writing the .sql.`,
      );
    }
  }

  console.log(`Migration stream: ${name} (${relative(process.cwd(), MIGRATIONS)})`);
  console.log(`  Migration files:     ${files.length}`);
  console.log(`  Journal entries:     ${entries.length}`);
  console.log(`  Newest snapshot:     ${latest ? String(latest.idx).padStart(4, "0") : "n/a"}`);
  console.log(`  Problems:            ${problems.length}`);
  return problems.map((problem) => `${name}: ${problem}`);
}

function check(): void {
  const { streams, historyFolder } = migrationStreams();
  const problems: string[] = [];
  console.log("Anlyon migration journal");
  for (const stream of streams) {
    problems.push(...checkStream(stream.name, stream.folder));
    const journal = resolve(stream.folder, "meta/_journal.json");
    if (existsSync(journal) && (JSON.parse(readFileSync(journal, "utf8")) as { entries: JournalEntry[] }).entries.length === 0) {
      problems.push(`${stream.name}: the stream has no baseline (its journal is empty).`);
    }
  }
  if (historyFolder) {
    problems.push(...checkStream("earlier history (frozen)", historyFolder));
    try {
      assertKnownHistory(historyFolder);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (problems.length > 0) {
    console.error("\nMigration journal gate failed:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("\nRegister the migration (pnpm db:generate writes both) and re-run.");
    process.exit(1);
  }

  console.log("\nMigration journal gate passed.");
}

check();
