import { createRequire } from "node:module";
import { parse as parseJavaScript } from "acorn";
import type { FunctionLanguage } from "../../db/schema/functions.ts";

export type RiskyApiCategory = "network" | "file" | "process" | "environment" | "eval";

export interface SourceFindings {
  language: FunctionLanguage;
  parsed: boolean;
  parseError: string | null;
  calls: Array<{ kind: "invoke" | "read"; action: string; line: number }>;
  proposedAllowedActions: string[];
  computedActionNames: Array<{ kind: "invoke" | "read"; line: number }>;
  risky: Array<{ api: string; category: RiskyApiCategory; line: number }>;
  writesInLoop: Array<{ action: string | null; line: number }>;
}

const BINDING_METHODS = new Set(["invoke", "read"]);

function empty(language: FunctionLanguage, parseError: string | null): SourceFindings {
  return { language, parsed: parseError === null, parseError, calls: [], proposedAllowedActions: [], computedActionNames: [], risky: [], writesInLoop: [] };
}

function finish(findings: SourceFindings): SourceFindings {
  findings.proposedAllowedActions = [...new Set(findings.calls.map((call) => call.action))].sort();
  const seen = new Set<string>();
  findings.risky = findings.risky.filter((risk) => !seen.has(`${risk.api}:${risk.line}`) && seen.add(`${risk.api}:${risk.line}`));
  return findings;
}

type JsNode = { type: string; start: number; loc?: { start: { line: number } } } & Record<string, unknown>;

const JS_NETWORK = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "connect", "navigator"]);
const JS_EVAL = new Set(["eval", "Function"]);
const JS_MODULES: Record<string, RiskyApiCategory> = {
  "cloudflare:sockets": "network",
  net: "network", "node:net": "network", http: "network", "node:http": "network", https: "network", "node:https": "network",
  dgram: "network", "node:dgram": "network", tls: "network", "node:tls": "network",
  fs: "file", "node:fs": "file", "fs/promises": "file", "node:fs/promises": "file",
  child_process: "process", "node:child_process": "process", worker_threads: "process", "node:worker_threads": "process",
  "cloudflare:workers": "environment",
};
const JS_LOOPS = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const PER_ITEM = new Set(["map", "forEach", "flatMap", "filter", "reduce", "some", "every"]);

function isNode(value: unknown): value is JsNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function children(node: JsNode): JsNode[] {
  const out: JsNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc") continue;
    if (Array.isArray(value)) for (const item of value) { if (isNode(item)) out.push(item); }
    else if (isNode(value)) out.push(value);
  }
  return out;
}

function literalString(node: JsNode | undefined): string | null {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0) {
    const [quasi] = node.quasis as Array<{ value: { cooked: string | null } }>;
    return quasi?.value.cooked ?? null;
  }
  return null;
}

function propertyName(member: JsNode): string | null {
  const property = member.property as JsNode;
  if (!member.computed && property.type === "Identifier") return property.name as string;
  return member.computed ? literalString(property) : null;
}

function jsBindingNames(program: JsNode): Set<string> {
  const names = new Set(["anlyon"]);
  for (const statement of program.body as JsNode[]) {
    if (statement.type !== "ExportDefaultDeclaration") continue;
    const declaration = statement.declaration as JsNode;
    const params = (declaration.params as JsNode[] | undefined) ?? [];
    if (params[1]?.type === "Identifier") names.add(params[1].name as string);
  }
  return names;
}

function analyzeJavaScript(source: string): SourceFindings {
  let program: JsNode;
  try {
    program = parseJavaScript(source, { ecmaVersion: "latest", sourceType: "module", locations: true, allowAwaitOutsideFunction: true }) as unknown as JsNode;
  } catch (error) {
    return empty("javascript", (error as Error).message);
  }
  const findings = empty("javascript", null);
  const bindings = jsBindingNames(program);
  const line = (node: JsNode) => node.loc?.start.line ?? 0;

  const visit = (node: JsNode, inLoop: boolean) => {
    const loop = inLoop || JS_LOOPS.has(node.type);

    if (node.type === "ImportDeclaration" || node.type === "ImportExpression") {
      const from = literalString(node.source as JsNode);
      if (from && JS_MODULES[from]) findings.risky.push({ api: `import "${from}"`, category: JS_MODULES[from]!, line: line(node) });
      if (node.type === "ImportExpression" && !from) findings.risky.push({ api: "import()", category: "eval", line: line(node) });
    }
    if (node.type === "Identifier" && JS_NETWORK.has(node.name as string)) {
      findings.risky.push({ api: node.name as string, category: "network", line: line(node) });
    }
    if (node.type === "MemberExpression") {
      const object = node.object as JsNode;
      const name = propertyName(node);
      if (object.type === "Identifier" && object.name === "process" && name === "env") {
        findings.risky.push({ api: "process.env", category: "environment", line: line(node) });
      }
    }
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const callee = node.callee as JsNode;
      if (callee.type === "Identifier" && JS_EVAL.has(callee.name as string)) {
        findings.risky.push({ api: callee.name as string, category: "eval", line: line(node) });
      }
      if (callee.type === "Identifier" && callee.name === "require") {
        const from = literalString((node.arguments as JsNode[])[0]);
        findings.risky.push({ api: `require(${from ? `"${from}"` : "…"})`, category: from && JS_MODULES[from] ? JS_MODULES[from]! : "eval", line: line(node) });
      }
      if (node.type === "CallExpression" && callee.type === "MemberExpression") {
        const method = propertyName(callee);
        const object = callee.object as JsNode;
        if (method && BINDING_METHODS.has(method) && object.type === "Identifier" && bindings.has(object.name as string)) {
          const kind = method as "invoke" | "read";
          const action = literalString((node.arguments as JsNode[])[0]);
          if (action !== null) findings.calls.push({ kind, action, line: line(node) });
          else findings.computedActionNames.push({ kind, line: line(node) });
          if (kind === "invoke" && loop) findings.writesInLoop.push({ action, line: line(node) });
        }
        if (method && PER_ITEM.has(method)) {
          for (const argument of node.arguments as JsNode[]) visit(argument, true);
          visit(callee, loop);
          return;
        }
      }
    }
    if (node.type === "MemberExpression" && !node.computed) return visit(node.object as JsNode, loop);
    if (node.type === "Property" && !node.computed) return visit(node.value as JsNode, loop);
    for (const child of children(node)) visit(child, loop);
  };
  visit(program, false);
  return finish(findings);
}

type TsNode = {
  type: string;
  text: string;
  startPosition: { row: number };
  namedChildren: TsNode[];
  childForFieldName(name: string): TsNode | null;
  hasError: boolean;
};
type TsParser = { parse(source: string): { rootNode: TsNode; delete(): void } | null };

const PY_MODULES: Record<string, RiskyApiCategory> = {
  socket: "network", ssl: "network", urllib: "network", http: "network", requests: "network", httpx: "network",
  aiohttp: "network", pyodide: "network", js: "network",
  os: "environment", sys: "process", subprocess: "process", multiprocessing: "process",
  shutil: "file", pathlib: "file", io: "file", tempfile: "file",
};
const PY_EVAL = new Set(["eval", "exec", "compile", "__import__"]);
const PY_LOOPS = new Set(["for_statement", "while_statement", "list_comprehension", "set_comprehension", "dictionary_comprehension", "generator_expression"]);

let pythonParser: Promise<TsParser> | null = null;

function loadPythonParser(): Promise<TsParser> {
  pythonParser ??= (async () => {
    const require = createRequire(import.meta.url);
    const { Parser, Language } = await import("web-tree-sitter");
    await Parser.init({ locateFile: () => require.resolve("web-tree-sitter/tree-sitter.wasm") });
    const language = await Language.load(require.resolve("tree-sitter-python/tree-sitter-python.wasm"));
    const parser = new Parser();
    parser.setLanguage(language);
    return parser as unknown as TsParser;
  })().catch((error) => {
    pythonParser = null;
    throw error;
  });
  return pythonParser;
}

function pythonLiteral(node: TsNode | undefined): string | null {
  if (!node || node.type !== "string") return null;
  if (node.namedChildren.some((child) => child.type === "interpolation")) return null;
  const match = /^[rRuU]?("""|'''|"|')([\s\S]*)\1$/.exec(node.text);
  return match ? match[2]! : null;
}

async function analyzePython(source: string): Promise<SourceFindings> {
  let parser: TsParser;
  try {
    parser = await loadPythonParser();
  } catch (error) {
    return empty("python", `The Python grammar could not be loaded: ${(error as Error).message}`);
  }
  const tree = parser.parse(source);
  if (!tree) return empty("python", "The source could not be parsed.");
  try {
    const root = tree.rootNode;
    if (root.hasError) return empty("python", "The source has a syntax error.");
    const findings = empty("python", null);
    const line = (node: TsNode) => node.startPosition.row + 1;

    const bindings = new Set(["anlyon"]);
    for (const statement of root.namedChildren) {
      const definition = statement.type === "decorated_definition" ? statement.childForFieldName("definition") : statement;
      if (definition?.type !== "function_definition" || definition.childForFieldName("name")?.text !== "run") continue;
      const second = definition.childForFieldName("parameters")?.namedChildren[1];
      const name = second?.type === "identifier" ? second.text : second?.childForFieldName("name")?.text;
      if (name) bindings.add(name);
    }

    const visit = (node: TsNode, inLoop: boolean) => {
      const loop = inLoop || PY_LOOPS.has(node.type);
      if (node.type === "import_statement" || node.type === "import_from_statement") {
        const names = node.type === "import_from_statement"
          ? [node.childForFieldName("module_name")?.text ?? ""]
          : node.namedChildren.map((child) => (child.type === "aliased_import" ? child.childForFieldName("name")?.text ?? "" : child.text));
        for (const name of names) {
          const top = name.split(".")[0]!;
          if (PY_MODULES[top]) findings.risky.push({ api: `import ${name}`, category: PY_MODULES[top]!, line: line(node) });
        }
      }
      if (node.type === "call") {
        const fn = node.childForFieldName("function");
        if (fn?.type === "identifier" && (PY_EVAL.has(fn.text) || fn.text === "open")) {
          findings.risky.push({ api: fn.text, category: fn.text === "open" ? "file" : "eval", line: line(node) });
        }
        if (fn?.type === "attribute") {
          const object = fn.childForFieldName("object");
          const method = fn.childForFieldName("attribute")?.text;
          if (object?.type === "identifier" && bindings.has(object.text) && method && BINDING_METHODS.has(method)) {
            const kind = method as "invoke" | "read";
            const action = pythonLiteral(node.childForFieldName("arguments")?.namedChildren[0]);
            if (action !== null) findings.calls.push({ kind, action, line: line(node) });
            else findings.computedActionNames.push({ kind, line: line(node) });
            if (kind === "invoke" && loop) findings.writesInLoop.push({ action, line: line(node) });
          }
        }
      }
      if (node.type === "attribute" && node.text === "os.environ") {
        findings.risky.push({ api: "os.environ", category: "environment", line: line(node) });
      }
      for (const child of node.namedChildren) visit(child, loop);
    };
    visit(root, false);
    return finish(findings);
  } finally {
    tree.delete();
  }
}

export async function analyzeSource(language: FunctionLanguage, source: string): Promise<SourceFindings> {
  return language === "javascript" ? analyzeJavaScript(source) : analyzePython(source);
}
