import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { extensionDatabaseManifests, extensionSourceDir } from "../src/core/extensions/directory.ts";

const args = process.argv.slice(2);
const streamAt = args.indexOf("--stream");
const only = streamAt >= 0 ? args[streamAt + 1] : undefined;
const passThrough = streamAt >= 0 ? [...args.slice(0, streamAt), ...args.slice(streamAt + 2)] : args;

const configs: { stream: string; config: string }[] = [{ stream: "core", config: "drizzle.config.ts" }];
for (const { name, dbDir, manifest } of extensionDatabaseManifests(extensionSourceDir())) {
  if (!manifest.migrations) continue;
  const config = join(dbDir, "drizzle.config.ts");
  if (!existsSync(config)) throw new Error(`Extension "${name}" has a migration stream but no ${config}`);
  configs.push({ stream: name, config });
}

let failed = false;
for (const { stream, config } of configs) {
  if (only && only !== stream) continue;
  console.log(`\n── ${stream} (${config}) ──`);
  const run = spawnSync("pnpm", ["exec", "drizzle-kit", "generate", "--config", config, ...passThrough], { stdio: "inherit" });
  if (run.status !== 0) failed = true;
}
if (only && !configs.some(({ stream }) => stream === only)) {
  console.error(`No migration stream "${only}". Streams: ${configs.map(({ stream }) => stream).join(", ")}`);
  failed = true;
}
process.exit(failed ? 1 : 0);
