import { pathToFileURL } from "node:url";
import { createLogger } from "../../lib/logger.ts";
import { defaultExtensionsDir, extensionFiles, extensionsDisabled } from "./manifest.ts";
import { registerExtension, type ServerExtension } from "./registry.ts";

export { defaultExtensionsDir };

const logger = createLogger({ module: "extensions" });

export function discoverExtensions(dir: string = defaultExtensionsDir()): { name: string; entry: string }[] {
  return extensionFiles(dir, "index");
}

function isServerExtension(value: unknown): value is ServerExtension {
  return typeof value === "object" && value !== null
    && typeof (value as ServerExtension).name === "string"
    && typeof (value as ServerExtension).register === "function";
}

export async function loadExtensions(dir: string = defaultExtensionsDir()): Promise<string[]> {
  const loaded: string[] = [];
  if (extensionsDisabled()) {
    logger.info("ANLYON_EXTENSIONS=none: no extensions loaded, the core runs alone");
    return loaded;
  }
  for (const { name, entry } of discoverExtensions(dir)) {
    const module = (await import(pathToFileURL(entry).href)) as { default?: unknown };
    if (!isServerExtension(module.default)) {
      throw new Error(`Extension "${name}" (${entry}) does not default-export a ServerExtension`);
    }
    await registerExtension(module.default);
    loaded.push(module.default.name);
  }
  logger.info({ extensions: loaded }, loaded.length ? "Extensions loaded" : "No extensions");
  return loaded;
}
