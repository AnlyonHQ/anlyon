import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";

export type Contract = Record<string, any>;
export type Fragment = { name: string; file: string; document: Contract };

export const CORE_CONTRACT = "openapi.yaml";
const EXTENSIONS_DIR = "src/extensions";
const FRAGMENT_KEYS = new Set(["tags", "paths", "components", "x-anlyon-extends"]);
const METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);

export function parseContract(text: string, label: string): Contract {
  const document = parseDocument(text, { merge: false, uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`${label}: ${document.errors.map((error) => error.message).join("\n")}`);
  return document.toJS({ maxAliasCount: 1000 }) ?? {};
}

export function extensionNames(projectRoot: string): string[] {
  const dir = resolve(projectRoot, EXTENSIONS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isDirectory() && !item.name.startsWith(".") && !item.name.startsWith("_"))
    .map((item) => item.name)
    .sort();
}

export function extensionFiles(projectRoot: string, relative: string): Array<{ name: string; file: string }> {
  return extensionNames(projectRoot)
    .map((name) => ({ name, file: resolve(projectRoot, EXTENSIONS_DIR, name, relative) }))
    .filter(({ file }) => existsSync(file));
}

export function contractFiles(projectRoot: string): Array<{ name: string; file: string }> {
  return [{ name: "core", file: resolve(projectRoot, CORE_CONTRACT) }, ...extensionFiles(projectRoot, CORE_CONTRACT)];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function pointer(document: Contract, ref: string): { parent: any; key: string; value: any } {
  if (!ref.startsWith("#/")) throw new Error(`Not a local reference: ${ref}`);
  const parts = ref.slice(2).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let parent: any = document;
  for (const part of parts.slice(0, -1)) {
    parent = parent?.[part];
    if (parent === undefined || parent === null || typeof parent !== "object") throw new Error(`${ref} does not exist`);
  }
  const key = parts.at(-1)!;
  if (!(key in parent)) throw new Error(`${ref} does not exist`);
  return { parent, key, value: parent[key] };
}

function extend(target: any, add: any, after: unknown, where: string): any {
  if (Array.isArray(target)) {
    if (!Array.isArray(add)) throw new Error(`${where}: an array is extended with an array`);
    const identity = (value: any): string => (value && typeof value === "object" && typeof value.name === "string" ? `name:${value.name}` : JSON.stringify(value));
    const present = new Set(target.map(identity));
    for (const value of add) if (present.has(identity(value))) throw new Error(`${where}: ${identity(value)} is already there`);
    const anchor = typeof after === "string" && target.some((value) => identity(value) === `name:${after}`) ? `name:${after}` : JSON.stringify(after);
    const at = after === undefined ? target.length : target.findIndex((value) => identity(value) === anchor) + 1;
    if (at === 0) throw new Error(`${where}: ${JSON.stringify(after)} is not there`);
    return [...target.slice(0, at), ...clone(add), ...target.slice(at)];
  }
  if (target && typeof target === "object") {
    if (!add || typeof add !== "object" || Array.isArray(add)) throw new Error(`${where}: an object is extended with an object`);
    for (const key of Object.keys(add)) if (key in target) throw new Error(`${where}: ${key} is already there`);
    const keys = Object.keys(target);
    const at = after === undefined ? keys.length : keys.indexOf(String(after)) + 1;
    if (at === 0) throw new Error(`${where}: ${String(after)} is not there`);
    return Object.fromEntries([
      ...keys.slice(0, at).map((key) => [key, target[key]]),
      ...Object.entries(clone(add)),
      ...keys.slice(at).map((key) => [key, target[key]]),
    ]);
  }
  throw new Error(`${where}: only an array or an object can be extended`);
}

export function mergeContract(core: Contract, fragments: Fragment[]): Contract {
  const merged = clone(core);
  for (const { name, document } of fragments) {
    const where = `extension ${name}`;
    for (const key of Object.keys(document)) {
      if (!FRAGMENT_KEYS.has(key)) throw new Error(`${where}: a contract fragment holds only ${[...FRAGMENT_KEYS].join(", ")}, not ${key}`);
    }

    const tags: Array<{ name: string }> = (merged.tags ??= []);
    for (const tag of document.tags ?? []) {
      if (tags.some((existing) => existing.name === tag.name)) throw new Error(`${where}: tag ${tag.name} is already defined`);
      tags.push(clone(tag));
    }

    merged.paths ??= {};
    for (const [path, item] of Object.entries<any>(document.paths ?? {})) {
      const existing = merged.paths[path];
      if (!existing) {
        merged.paths[path] = clone(item);
        continue;
      }
      for (const [key, value] of Object.entries(item)) {
        if (key in existing) throw new Error(`${where}: ${METHODS.has(key) ? key.toUpperCase() : key} ${path} is already defined`);
        existing[key] = clone(value);
      }
    }

    for (const [section, entries] of Object.entries<Record<string, unknown>>(document.components ?? {})) {
      const into = ((merged.components ??= {})[section] ??= {});
      for (const [component, value] of Object.entries(entries ?? {})) {
        if (component in into) throw new Error(`${where}: components.${section}.${component} is already defined`);
        into[component] = clone(value);
      }
    }

    for (const [index, entry] of (document["x-anlyon-extends"] ?? []).entries()) {
      const label = `${where}: x-anlyon-extends[${index}] (${entry?.target})`;
      if (typeof entry?.target !== "string" || entry.add === undefined) throw new Error(`${label}: needs target and add`);
      const { parent, key, value } = pointer(merged, entry.target);
      parent[key] = extend(value, entry.add, entry.after, label);
    }
  }
  return merged;
}

export function loadFragments(projectRoot: string): Fragment[] {
  return extensionFiles(projectRoot, CORE_CONTRACT).map(({ name, file }) => ({
    name,
    file,
    document: parseContract(readFileSync(file, "utf8"), file),
  }));
}

export function loadContract(projectRoot: string, scope: "full" | "core" = "full"): Contract {
  const file = resolve(projectRoot, CORE_CONTRACT);
  const core = parseContract(readFileSync(file, "utf8"), file);
  return scope === "core" ? core : mergeContract(core, loadFragments(projectRoot));
}

export function readAtRef(ref: string, relative: string, cwd: string): string | undefined {
  const result = spawnSync("git", ["show", `${ref}:./${relative}`], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : undefined;
}

export function loadContractAtRef(ref: string, projectRoot: string): Contract {
  const coreText = readAtRef(ref, CORE_CONTRACT, projectRoot);
  if (coreText === undefined) throw new Error(`Cannot load ${CORE_CONTRACT} at ${ref}`);
  const listing = spawnSync("git", ["ls-tree", "--full-tree", "-d", "--name-only", `${ref}:./${EXTENSIONS_DIR}`], { cwd: projectRoot, encoding: "utf8" });
  const names = listing.status === 0
    ? listing.stdout.split("\n").filter((name) => name && !name.startsWith(".") && !name.startsWith("_")).sort()
    : [];
  const fragments = names.flatMap((name) => {
    const relative = join(EXTENSIONS_DIR, name, CORE_CONTRACT);
    const text = readAtRef(ref, relative, projectRoot);
    return text === undefined ? [] : [{ name, file: `${ref}:${relative}`, document: parseContract(text, `${ref}:${relative}`) }];
  });
  return mergeContract(parseContract(coreText, `${ref}:${CORE_CONTRACT}`), fragments);
}

export function unresolvedRefs(document: Contract): string[] {
  const missing = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith("#/")) {
        try {
          pointer(document, value);
        } catch {
          missing.add(value);
        }
      } else {
        walk(value);
      }
    }
  };
  walk(document);
  return [...missing].sort();
}

export function contractOperations(document: Contract): Array<{ route: string; path: string; method: string; operation: any }> {
  return Object.entries<any>(document.paths ?? {}).flatMap(([path, item]) =>
    Object.entries<any>(item)
      .filter(([method]) => METHODS.has(method))
      .map(([method, operation]) => ({ route: `${method.toUpperCase()} ${path}`, path, method, operation })),
  );
}
