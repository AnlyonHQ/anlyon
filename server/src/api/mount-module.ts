import type { Hono } from "hono";
import { currentEdition, type Edition } from "../core/edition/edition.ts";
import { isModuleEnabled, moduleDefinition, type ModuleId } from "../core/edition/modules.ts";

// biome-ignore lint/suspicious/noExplicitAny: Hono's generic parameters differ per router.
export function mountModule(app: Hono<any, any, any>, id: ModuleId, path: string, router: Hono<any, any, any>, edition: Edition = currentEdition()): boolean {
  const definition = moduleDefinition(id);
  if (!definition) throw new Error(`Module "${id}" is not defined`);
  const declared = definition.paths;
  const base = path === "/" ? "" : path;
  if (!declared.some((pattern) => pattern === base || pattern.startsWith(`${base}/`))) {
    throw new Error(`Module "${id}" is mounted at ${path}, which it does not declare in core/edition/modules.ts`);
  }
  if (!isModuleEnabled(id, edition)) return false;
  app.route(path, router);
  return true;
}
