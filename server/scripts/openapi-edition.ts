import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringify } from "yaml";
import { EDITIONS, type Edition } from "../src/core/edition/edition.ts";
import { enabledModules, filterOpenApiPaths } from "../src/core/edition/modules.ts";
import { defineExtensionModules } from "../src/core/extensions/directory.ts";
import { loadContract } from "./contract.ts";

const [editionArg, outFile] = process.argv.slice(2);
if (!EDITIONS.includes(editionArg as Edition)) {
  console.error(`Usage: openapi-edition <${EDITIONS.join("|")}> [output file]`);
  process.exit(2);
}
const edition = editionArg as Edition;
await defineExtensionModules();

const source = loadContract(process.cwd());
const filtered = filterOpenApiPaths(source, edition);
const output = stringify(filtered, { lineWidth: 0 });

if (outFile) {
  writeFileSync(resolve(process.cwd(), outFile), output);
  console.error(
    `${edition}: kept ${Object.keys(filtered.paths ?? {}).length} of ${Object.keys(source.paths ?? {}).length} paths ` +
      `(modules: ${enabledModules(edition).join(", ")}) -> ${outFile}`,
  );
} else {
  process.stdout.write(output);
}
