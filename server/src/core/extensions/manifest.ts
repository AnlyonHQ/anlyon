import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);

export const DECLARABLE_EDITIONS = ["cloud"] as const;
export type DeclarableEdition = (typeof DECLARABLE_EDITIONS)[number];

export interface ExtensionManifest {
  edition?: DeclarableEdition;
}

export function defaultExtensionsDir(): string {
  const here = dirname(HERE);
  if (here.endsWith(`${sep}core${sep}extensions`)) return resolve(here, "..", "..", "extensions");
  let dir = here;
  for (let depth = 0; depth < 3; depth++) {
    if (basename(dir) === "dist") return join(dir, "extensions");
    dir = dirname(dir);
  }
  return join(here, "extensions");
}

export function extensionsDisabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.ANLYON_EXTENSIONS?.trim().toLowerCase() === "none";
}

function extensionNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isDirectory() && !item.name.startsWith(".") && !item.name.startsWith("_"))
    .map((item) => item.name)
    .sort();
}

export function extensionFiles(dir: string, base: string): { name: string; entry: string }[] {
  const names = HERE.endsWith(".ts") ? [`${base}.ts`, `${base}.js`] : [`${base}.js`, `${base}.ts`];
  return extensionNames(dir).flatMap((name) => {
    const file = names.map((candidate) => join(dir, name, candidate)).find((path) => existsSync(path));
    return file ? [{ name, entry: file }] : [];
  });
}

export function extensionManifests(dir: string = defaultExtensionsDir()): { name: string; manifest: ExtensionManifest }[] {
  return extensionFiles(dir, "index").flatMap(({ name }) => {
    const file = join(dir, name, "extension.json");
    if (!existsSync(file)) return [];
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`Extension "${name}" (${file}) is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
      throw new Error(`Extension "${name}" (${file}) must hold a JSON object`);
    }
    const { edition, ...rest } = manifest as Record<string, unknown>;
    const unknown = Object.keys(rest);
    if (unknown.length > 0) throw new Error(`Extension "${name}" (${file}) has unknown keys: ${unknown.join(", ")}`);
    if (edition !== undefined && !DECLARABLE_EDITIONS.includes(edition as DeclarableEdition)) {
      throw new Error(`Extension "${name}" (${file}) declares the edition ${JSON.stringify(edition)}; only ${DECLARABLE_EDITIONS.join(", ")} can be declared`);
    }
    return [{ name, manifest: edition === undefined ? {} : { edition: edition as DeclarableEdition } }];
  });
}

export function cloudEditionDeclaredBy(dir: string = defaultExtensionsDir(), source: NodeJS.ProcessEnv = process.env): string[] {
  if (extensionsDisabled(source)) return [];
  return extensionManifests(dir).filter(({ manifest }) => manifest.edition === "cloud").map(({ name }) => name);
}
