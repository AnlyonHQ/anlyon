import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { moduleDefinition, modulesOwningPath } from "../src/core/edition/modules.ts";
import { defineExtensionModules } from "../src/core/extensions/directory.ts";
import { contractFiles } from "./contract.ts";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);

type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "options" | "head";

type Route = {
  method: HttpMethod;
  path: string;
  source: string;
};

type ImportBinding = {
  importedName: "default" | string;
  source: string;
};

function parseTypeScript(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function stringLiteral(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function normalizePath(base: string, child: string): string {
  const normalizedBase = base === "/" ? "" : base.replace(/\/$/, "");
  const normalizedChild = child === "/" ? "" : child.startsWith("/") ? child : `/${child}`;
  const joined = `${normalizedBase}${normalizedChild}` || "/";
  return joined.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function importBindings(index: ts.SourceFile): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();

  for (const statement of index.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const source = stringLiteral(statement.moduleSpecifier);
    if (!source) continue;

    if (statement.importClause.name) {
      bindings.set(statement.importClause.name.text, { importedName: "default", source });
    }

    const namedBindings = statement.importClause.namedBindings;
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        bindings.set(element.name.text, {
          importedName: element.propertyName?.text ?? element.name.text,
          source,
        });
      }
    }
  }

  return bindings;
}

function resolveTypeScriptImport(fromFile: string, specifier: string): string {
  const candidate = resolve(dirname(fromFile), specifier);
  return candidate.endsWith(".ts") ? candidate : `${candidate}.ts`;
}

function exportedRouterName(source: ts.SourceFile, importedName: string): string {
  if (importedName !== "default") return importedName;

  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      return statement.expression.text;
    }
  }

  throw new Error(`Could not find a default router export in ${source.fileName}`);
}

function routerRoutes(filePath: string, importedName: string, mount: string): Route[] {
  const source = parseTypeScript(filePath);
  const routerName = exportedRouterName(source, importedName);
  const routes: Route[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      const method = node.expression.name.text.toLowerCase();
      if (ts.isIdentifier(receiver) && receiver.text === routerName && HTTP_METHODS.has(method)) {
        const childPath = stringLiteral(node.arguments[0]);
        if (childPath) {
          routes.push({
            method: method as HttpMethod,
            path: normalizePath(mount, childPath),
            source: `${filePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return routes;
}

function mountedRoutes(indexPath: string): Route[] {
  const index = parseTypeScript(indexPath);
  const bindings = importBindings(index);
  const routes: Route[] = [];

  function visit(node: ts.Node): void {
    const direct =
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "app" &&
      node.expression.name.text === "route";
    const gated = ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "mountModule";
    const extension =
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "mount" &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === "routes";
    if (direct || gated || extension) {
      const offset = gated || extension ? (gated ? 2 : 1) : 0;
      const mount = stringLiteral(node.arguments[offset]);
      const router = node.arguments[offset + 1];
      if (!mount?.startsWith("/api/v2") || !router || !ts.isIdentifier(router)) return;

      const binding = bindings.get(router.text);
      if (!binding || !binding.source.startsWith(".")) {
        throw new Error(`Could not resolve router ${router.text} mounted at ${mount}`);
      }

      routes.push(
        ...routerRoutes(resolveTypeScriptImport(indexPath, binding.source), binding.importedName, mount),
      );
    }
    ts.forEachChild(node, visit);
  }

  visit(index);
  return routes;
}

function extensionEntries(projectRoot: string): string[] {
  const dir = resolve(projectRoot, "src/extensions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isDirectory() && !item.name.startsWith(".") && !item.name.startsWith("_"))
    .map((item) => resolve(dir, item.name, "index.ts"))
    .filter((path) => existsSync(path))
    .sort();
}

export function backendPublicRoutes(projectRoot: string): Route[] {
  const routes = [resolve(projectRoot, "src/api/index.ts"), ...extensionEntries(projectRoot)].flatMap(mountedRoutes);
  const unique = new Map<string, Route>();
  for (const route of routes) unique.set(`${route.method} ${route.path}`, route);
  return [...unique.values()].sort((a, b) =>
    `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`),
  );
}

export function openApiRoutes(openApiPath: string): Route[] {
  const lines = readFileSync(openApiPath, "utf8").split(/\r?\n/);
  const routes: Route[] = [];
  let inPaths = false;
  let currentPath: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "paths:") {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    if (/^[A-Za-z][A-Za-z0-9_-]*:/.test(line)) break;

    const pathMatch = line.match(/^  (\/[^:]+):\s*(?:#.*)?$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }

    const methodMatch = line.match(/^    (get|post|put|patch|delete|options|head):\s*(?:#.*)?$/);
    if (currentPath && methodMatch) {
      routes.push({
        method: methodMatch[1] as HttpMethod,
        path: currentPath,
        source: `${openApiPath}:${index + 1}`,
      });
    }
  }

  return routes;
}

function duplicateOperationIds(openApiPaths: string[]): string[] {
  const ids = new Map<string, number>();
  for (const line of openApiPaths.flatMap((path) => readFileSync(path, "utf8").split(/\r?\n/))) {
    const match = line.match(/^\s+operationId:\s*([^\s#]+)\s*$/);
    if (match) ids.set(match[1], (ids.get(match[1]) ?? 0) + 1);
  }
  return [...ids.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort();
}

function isPrivatePath(path: string): boolean {
  const owners = modulesOwningPath(path);
  return owners.length > 0 && owners.every((id) => moduleDefinition(id)!.kind === "cloud");
}

function misplacedOperations(files: Array<{ name: string; routes: Route[] }>): string[] {
  const problems: string[] = [];
  for (const { name, routes } of files) {
    for (const route of routes) {
      const label = `${route.method.toUpperCase()} ${route.path}  ${route.source}`;
      if (name === "core" && isPrivatePath(route.path)) problems.push(`${label}: served only by cloud modules, so its contract belongs in an extension's openapi.yaml`);
      if (name !== "core" && !isPrivatePath(route.path)) problems.push(`${label}: served by a core module, so its contract belongs in openapi.yaml`);
    }
  }
  return problems;
}

function difference(left: Route[], right: Route[]): Route[] {
  const rightKeys = new Set(right.map((route) => `${route.method} ${route.path}`));
  return left.filter((route) => !rightKeys.has(`${route.method} ${route.path}`));
}

function printRoutes(title: string, routes: Route[]): void {
  console.log(`\n${title} (${routes.length})`);
  for (const route of routes) console.log(`  ${route.method.toUpperCase()} ${route.path}  ${route.source}`);
}

async function main(): Promise<void> {
  const projectRoot = resolve(process.cwd());
  const mode = process.argv[2] ?? "report";
  if (mode !== "report" && mode !== "check") {
    throw new Error("Usage: tsx scripts/api-contract.ts [report|check]");
  }

  await defineExtensionModules(resolve(projectRoot, "src/extensions"));
  const files = contractFiles(projectRoot).map(({ name, file }) => ({
    name,
    file,
    routes: openApiRoutes(file).map((route) => ({ ...route, source: relative(projectRoot, route.source) })),
  }));
  const rawContract = files.map(({ file }) => readFileSync(file, "utf8")).join("\n");
  const backend = backendPublicRoutes(projectRoot);
  const contract = files.flatMap(({ routes }) => routes);
  const undocumented = difference(backend, contract);
  const unimplemented = difference(contract, backend);
  const duplicateIds = duplicateOperationIds(files.map(({ file }) => file));
  const misplaced = misplacedOperations(files);
  const legacyAuth = rawContract.includes("X-API-Key") || rawContract.includes("ApiKeyAuth");

  console.log("Anlyon API contract coverage");
  console.log(`  Backend /api/v2 operations: ${backend.length}`);
  console.log(`  OpenAPI operations:        ${contract.length} (${files.map(({ name, routes }) => `${name} ${routes.length}`).join(", ")})`);
  console.log(`  Covered backend routes:    ${backend.length - undocumented.length}`);
  console.log(`  Coverage:                  ${((backend.length - undocumented.length) / backend.length * 100).toFixed(1)}%`);

  if (undocumented.length) printRoutes("Backend operations missing from OpenAPI", undocumented);
  if (unimplemented.length) printRoutes("OpenAPI operations missing from backend", unimplemented);
  if (duplicateIds.length) console.log(`\nDuplicate operationIds (${duplicateIds.length})\n  ${duplicateIds.join("\n  ")}`);
  if (misplaced.length) console.log(`\nOperations in the wrong contract document (${misplaced.length})\n  ${misplaced.join("\n  ")}`);
  if (legacyAuth) console.log("\nLegacy API-key authentication remains in the contract");

  const hasDrift = undocumented.length > 0 || unimplemented.length > 0 || duplicateIds.length > 0 || misplaced.length > 0 || legacyAuth;
  if (!hasDrift) {
    console.log("\nContract gate passed.");
    return;
  }

  if (mode === "check") process.exitCode = 1;
  else console.log("\nConvergence report only; use `pnpm api:contract:check` for a blocking gate.");
}

await main();
