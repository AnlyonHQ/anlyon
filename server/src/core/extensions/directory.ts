import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { defineModule, type ModuleDefinition } from "../edition/modules.ts";
import { assertPartitionedLogSpec, type PartitionedLogSpec } from "../archival/partitioned-logs.ts";
import { defaultExtensionsDir, extensionFiles } from "./manifest.ts";

export { defaultExtensionsDir, extensionFiles };

export async function defineExtensionModules(dir: string = defaultExtensionsDir()): Promise<string[]> {
  const ids: string[] = [];
  for (const { name, entry } of extensionFiles(dir, "modules")) {
    const table = ((await import(pathToFileURL(entry).href)) as { default?: unknown }).default;
    if (!table || typeof table !== "object") throw new Error(`Extension "${name}" (${entry}) has no default-exported module table`);
    for (const [id, definition] of Object.entries(table as Record<string, ModuleDefinition>)) {
    defineModule(id, definition);
    ids.push(id);
    }
  }
  return ids;
}

export interface DatabaseManifest {
  migrations?: {
    folder: string;
    table: string;
    baselineOfHistory?: boolean;
  };
  history?: { folder: string };
  partitionedLogs?: PartitionedLogSpec[];
}

export function extensionSourceDir(root: string = process.cwd()): string {
  return resolve(root, "src", "extensions");
}

const STREAM_TABLE = /^__[a-z][a-z0-9_]*_migrations$/;

function insideDir(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !rel.includes(`..${sep}`) && !rel.startsWith(sep);
}

export function extensionDatabaseManifests(dir: string = extensionSourceDir()): { name: string; dbDir: string; manifest: DatabaseManifest }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isDirectory() && !item.name.startsWith(".") && !item.name.startsWith("_"))
    .map((item) => item.name)
    .sort()
    .flatMap((name) => {
      const dbDir = join(dir, name, "db");
      const file = join(dbDir, "database.json");
      if (!existsSync(file)) return [];
      const manifest = JSON.parse(readFileSync(file, "utf8")) as DatabaseManifest;
      const where = `Extension "${name}" (${file})`;
      for (const folder of [manifest.migrations?.folder, manifest.history?.folder]) {
        if (folder !== undefined && !insideDir(dbDir, resolve(dbDir, folder))) throw new Error(`${where}: folder "${folder}" is outside its db directory`);
      }
      if (manifest.migrations && !STREAM_TABLE.test(manifest.migrations.table)) {
        throw new Error(`${where}: migrations table "${manifest.migrations.table}" must look like __<name>_migrations`);
      }
      for (const spec of manifest.partitionedLogs ?? []) assertPartitionedLogSpec(spec);
      return [{ name, dbDir, manifest }];
    });
}
