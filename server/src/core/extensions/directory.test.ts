import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { extensionDatabaseManifests } from "./directory.ts";
import { migrationStreams } from "../../db/migration-streams.ts";

const fixtures = (name: string) => fileURLToPath(new URL(`./fixtures/databases/${name}`, import.meta.url));

describe("extension database manifests", () => {
  it("are read from <name>/db/database.json in name order, skipping _ and . directories", () => {
    const manifests = extensionDatabaseManifests(fixtures("ok"));
    expect(manifests.map((m) => m.name)).toEqual(["beta"]);
    expect(manifests[0]!.manifest.partitionedLogs?.[0]?.table).toBe("beta_event_logs");
    expect(extensionDatabaseManifests(fixtures("does-not-exist"))).toEqual([]);
  });

  it("refuse a folder outside the extension's db directory, and a bookkeeping table not named __<name>_migrations", () => {
    expect(() => extensionDatabaseManifests(fixtures("outside"))).toThrow(/outside its db directory/);
    expect(() => extensionDatabaseManifests(fixtures("badtable"))).toThrow(/must look like __<name>_migrations/);
  });

  it("make the migration streams: core's first, then each extension's", () => {
    const { streams, historyFolder } = migrationStreams({ extensionsDir: fixtures("ok") });
    expect(streams.map((s) => [s.name, s.table, s.baselineOfHistory])).toEqual([
      ["core", "__core_migrations", true],
      ["beta", "__beta_migrations", false],
    ]);
    expect(streams[1]!.folder).toBe(join(fixtures("ok"), "beta", "db", "migrations"));
    expect(historyFolder).toBeNull();
    expect(migrationStreams({ extensionsDir: fixtures("does-not-exist") }).streams.map((s) => s.name)).toEqual(["core"]);
  });
});
