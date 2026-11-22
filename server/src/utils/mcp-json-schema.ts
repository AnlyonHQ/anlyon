import { dereference, format as libraryFormats, validate, type OutputUnit, type Schema, type SchemaDraft } from "@cfworker/json-schema";
import { FORMATS, MAX_PATTERN_SUBJECT_LENGTH, unsafePatternReason } from "./json-schema.ts";

export type SchemaCheck = "full" | "loose";

export const LOOSE_REASONS = [
  "remote_ref",
  "too_large",
  "unsafe_pattern",
  "invalid_schema",
  "unsupported_keyword",
  "unknown_dialect",
  "ref_cycle",
] as const;
export type LooseReason = (typeof LOOSE_REASONS)[number];

export type SchemaAssessment =
  | { check: "full"; reason: null; detail: null }
  | { check: "loose"; reason: LooseReason; detail: string };

export const MAX_SCHEMA_BYTES = 256 * 1024;
export const MAX_SCHEMA_DEPTH = 64;
export const MAX_SUBSCHEMAS = 10_000;
export const MAX_REFS = 1_000;
export const MAX_IN_PLACE = 10_000;
export const MAX_MCP_VISITS = 200_000;
export const MAX_LOOSE_ARGUMENT_BYTES = 256 * 1024;

const BASE_URI = new URL("https://schema.anlyon.invalid/tool");

Object.assign(libraryFormats, FORMATS);

type Kind =
  | "schema" | "items" | "schemaArray" | "schemaMap" | "patternMap" | "dependencies" | "requiredMap"
  | "type" | "array" | "any" | "names" | "count" | "number" | "positive" | "exclusive" | "boolean"
  | "pattern" | "format" | "ref" | "string" | "unsupported";

const KEYWORDS = new Map<string, Kind>([
  ["not", "schema"], ["if", "schema"], ["then", "schema"], ["else", "schema"], ["contains", "schema"],
  ["propertyNames", "schema"], ["additionalProperties", "schema"], ["unevaluatedProperties", "schema"],
  ["unevaluatedItems", "schema"], ["additionalItems", "schema"],
  ["items", "items"],
  ["allOf", "schemaArray"], ["anyOf", "schemaArray"], ["oneOf", "schemaArray"], ["prefixItems", "schemaArray"],
  ["properties", "schemaMap"], ["$defs", "schemaMap"], ["definitions", "schemaMap"], ["dependentSchemas", "schemaMap"],
  ["patternProperties", "patternMap"],
  ["dependencies", "dependencies"],
  ["dependentRequired", "requiredMap"],
  ["type", "type"], ["enum", "array"], ["const", "any"], ["required", "names"],
  ["minLength", "count"], ["maxLength", "count"], ["minItems", "count"], ["maxItems", "count"],
  ["minProperties", "count"], ["maxProperties", "count"], ["minContains", "count"], ["maxContains", "count"],
  ["minimum", "number"], ["maximum", "number"], ["multipleOf", "positive"],
  ["exclusiveMinimum", "exclusive"], ["exclusiveMaximum", "exclusive"],
  ["uniqueItems", "boolean"],
  ["pattern", "pattern"], ["format", "format"], ["$ref", "ref"],
  ["$id", "string"], ["id", "string"], ["$anchor", "string"],
  ["$dynamicRef", "unsupported"], ["$dynamicAnchor", "unsupported"], ["$recursiveRef", "unsupported"], ["$recursiveAnchor", "unsupported"],
]);

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

class Loose extends Error {
  constructor(readonly reason: LooseReason, readonly detail: string) {
    super(detail);
  }
}

interface Node {
  schema: Record<string, unknown>;
  inPlace: Array<Record<string, unknown> | boolean>;
  ref: string | null;
}

interface Prepared {
  root: Schema | boolean;
  draft: SchemaDraft;
  lookup: Record<string, Schema | boolean>;
}

let budget: { left: number } | null = null;
const WORK_LIMIT = Symbol("mcp-schema-work-limit");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function draftOf(raw: unknown): SchemaDraft {
  if (raw === undefined) return "2020-12";
  if (typeof raw !== "string") throw new Loose("invalid_schema", "$schema is not a string");
  if (/json-schema\.org\/draft\/2020-12\/schema/.test(raw)) return "2020-12";
  if (/json-schema\.org\/draft\/2019-09\/schema/.test(raw)) return "2019-09";
  if (/json-schema\.org\/draft-0[67]\/schema/.test(raw)) return "7";
  if (/json-schema\.org\/draft-04\/schema/.test(raw)) return "4";
  throw new Loose("unknown_dialect", "$schema names a dialect Anlyon does not check");
}

function depthOf(value: unknown): number {
  let deepest = 0;
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [item, depth] = stack.pop()!;
    if (typeof item !== "object" || item === null) continue;
    if (depth > deepest) deepest = depth;
    if (deepest > MAX_SCHEMA_DEPTH) return deepest;
    for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
  return deepest;
}

const IDENTITY_ESCAPE_OK = new Set("^$\\.*+?()[]{}|/".split(""));
const ESCAPE_LETTERS = new Set("bBdDwWsSfnrtv0cxukpP123456789".split(""));

export function unicodePattern(pattern: string): string | null {
  try {
    new RegExp(pattern, "u");
    return pattern;
  } catch {
  }
  try {
    new RegExp(pattern);
  } catch {
    return null;
  }
  let out = "";
  let inClass = false;
  let lastWasSet = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = pattern[i + 1] ?? "";
      i++;
      out += IDENTITY_ESCAPE_OK.has(next) || ESCAPE_LETTERS.has(next) || (inClass && next === "-") ? `\\${next}` : next;
      lastWasSet = inClass && /[dDwWsS]/.test(next);
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      if (ch === "-" && (lastWasSet || /^\\[dDwWsS]/.test(pattern.slice(i + 1)))) out += "\\-";
      else out += ch;
      lastWasSet = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      lastWasSet = false;
      out += ch;
      if (pattern[i + 1] === "^") out += pattern[++i];
      continue;
    }
    if (ch === "{") {
      const quantifier = /^\{\d+(,\d*)?\}/.exec(pattern.slice(i));
      if (quantifier) {
        out += quantifier[0];
        i += quantifier[0].length - 1;
      } else {
        out += "\\{";
      }
      continue;
    }
    if (ch === "}" || ch === "]") {
      out += `\\${ch}`;
      continue;
    }
    out += ch;
  }
  try {
    new RegExp(out, "u");
    return out;
  } catch {
    return null;
  }
}

function guardedPattern(pattern: unknown, where: string): string {
  if (typeof pattern !== "string") throw new Loose("invalid_schema", `${where} is not a string`);
  const unsafe = unsafePatternReason(pattern);
  if (unsafe) throw new Loose("unsafe_pattern", `${where} is refused: ${unsafe}`);
  const unicode = unicodePattern(pattern);
  if (unicode === null) throw new Loose("invalid_schema", `${where} is not a regular expression`);
  const guarded = `^(?=[\\s\\S]{0,${MAX_PATTERN_SUBJECT_LENGTH}}$)[\\s\\S]*?(?:${unicode})`;
  try {
    new RegExp(guarded, "u");
  } catch {
    throw new Loose("invalid_schema", `${where} is not a regular expression`);
  }
  return guarded;
}

function copy(value: unknown, where: string, draft: SchemaDraft, nodes: Node[]): Record<string, unknown> | boolean {
  if (typeof value === "boolean") return value;
  if (!isObject(value)) throw new Loose("invalid_schema", `${where} is not a schema`);
  if (nodes.length >= MAX_SUBSCHEMAS) throw new Loose("too_large", `the schema holds more than ${MAX_SUBSCHEMAS} sub-schemas`);
  const out: Record<string, unknown> = {};
  const node: Node = { schema: out, inPlace: [], ref: null };
  nodes.push(node);
  const set = (key: string, v: unknown) => Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
  const sub = (v: unknown, at: string) => copy(v, at, draft, nodes);
  const map = (v: unknown, at: string, each: (item: unknown, key: string) => unknown) => {
    if (!isObject(v)) throw new Loose("invalid_schema", `${at} is not an object`);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(v)) {
      Object.defineProperty(result, key, { value: each(v[key], key), enumerable: true, writable: true, configurable: true });
    }
    return result;
  };
  const names = (v: unknown, at: string) => {
    if (!Array.isArray(v) || v.some((n) => typeof n !== "string")) throw new Loose("invalid_schema", `${at} is not a list of property names`);
    return v;
  };

  for (const key of Object.keys(value)) {
    const kind = KEYWORDS.get(key);
    if (kind === undefined || (key === "id" && draft !== "4")) continue;
    const v = value[key];
    const at = `${where}.${key}`;
    switch (kind) {
      case "schema": {
        const s = sub(v, at);
        set(key, s);
        if (key === "not" || key === "if" || key === "then" || key === "else") node.inPlace.push(s);
        break;
      }
      case "items":
        if (Array.isArray(v)) {
          if (draft === "2020-12") throw new Loose("invalid_schema", `${at} is a list, which draft 2020-12 spells prefixItems`);
          set(key, v.map((item, i) => sub(item, `${at}[${i}]`)));
        } else {
          set(key, sub(v, at));
        }
        break;
      case "schemaArray": {
        if (!Array.isArray(v) || v.length === 0) throw new Loose("invalid_schema", `${at} is not a non-empty list of schemas`);
        const list = v.map((item, i) => sub(item, `${at}[${i}]`));
        set(key, list);
        if (key !== "prefixItems") node.inPlace.push(...list);
        break;
      }
      case "schemaMap": {
        const m = map(v, at, (item, name) => sub(item, `${at}.${name}`));
        set(key, m);
        if (key === "dependentSchemas") node.inPlace.push(...(Object.values(m) as Array<Record<string, unknown> | boolean>));
        break;
      }
      case "patternMap": {
        if (!isObject(v)) throw new Loose("invalid_schema", `${at} is not an object`);
        const m: Record<string, unknown> = {};
        for (const pattern of Object.keys(v)) {
          const guarded = guardedPattern(pattern, `a pattern of ${at}`);
          if (Object.hasOwn(m, guarded)) throw new Loose("invalid_schema", `${at} names one pattern twice`);
          Object.defineProperty(m, guarded, {
            value: sub(v[pattern], `${at}[${JSON.stringify(pattern).slice(0, 40)}]`),
            enumerable: true, writable: true, configurable: true,
          });
        }
        set(key, m);
        break;
      }
      case "dependencies":
        set(key, map(v, at, (item, name) => {
          if (Array.isArray(item)) return names(item, `${at}.${name}`);
          const s = sub(item, `${at}.${name}`);
          node.inPlace.push(s);
          return s;
        }));
        break;
      case "requiredMap":
        set(key, map(v, at, (item, name) => names(item, `${at}.${name}`)));
        break;
      case "type": {
        const list = Array.isArray(v) ? v : [v];
        if (list.length === 0 || new Set(list).size !== list.length || list.some((t) => typeof t !== "string" || !TYPES.has(t))) {
          throw new Loose("invalid_schema", `${at} is not a type or a list of distinct types`);
        }
        set(key, v);
        break;
      }
      case "array":
        if (!Array.isArray(v)) throw new Loose("invalid_schema", `${at} is not a list`);
        set(key, v);
        break;
      case "any":
        set(key, v);
        break;
      case "names":
        set(key, names(v, at));
        break;
      case "count":
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Loose("invalid_schema", `${at} is not a non-negative integer`);
        set(key, v);
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) throw new Loose("invalid_schema", `${at} is not a number`);
        set(key, v);
        break;
      case "positive":
        if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Loose("invalid_schema", `${at} is not a number above zero`);
        set(key, v);
        break;
      case "exclusive":
        if (draft === "4" ? typeof v !== "boolean" : typeof v !== "number" || !Number.isFinite(v)) {
          throw new Loose("invalid_schema", `${at} is not a ${draft === "4" ? "boolean" : "number"}`);
        }
        set(key, v);
        break;
      case "boolean":
        if (typeof v !== "boolean") throw new Loose("invalid_schema", `${at} is not a boolean`);
        set(key, v);
        break;
      case "pattern":
        set(key, guardedPattern(v, at));
        break;
      case "format":
        if (typeof v !== "string") throw new Loose("invalid_schema", `${at} is not a string`);
        if (Object.hasOwn(FORMATS, v)) set(key, v);
        break;
      case "ref":
        if (typeof v !== "string") throw new Loose("invalid_schema", `${at} is not a string`);
        node.ref = v;
        break;
      case "string":
        if (typeof v !== "string") throw new Loose("invalid_schema", `${at} is not a string`);
        set(key, v);
        break;
      case "unsupported":
        throw new Loose("unsupported_keyword", `${at} is not checked by Anlyon`);
    }
  }

  const ref = node.ref;
  Object.defineProperty(out, "$ref", {
    enumerable: false,
    get() {
      if (budget !== null && --budget.left < 0) throw WORK_LIMIT;
      return ref ?? undefined;
    },
  });
  return out;
}

function assertBoundedInPlace(nodes: Node[], lookup: Record<string, Schema | boolean>): void {
  const byObject = new Map<unknown, Node>(nodes.map((n) => [n.schema, n]));
  const edges = new Map<Node, Node[]>();
  let refs = 0;
  for (const n of nodes) {
    const out: Node[] = [];
    for (const child of n.inPlace) {
      const target = byObject.get(child);
      if (target) out.push(target);
    }
    if (n.ref !== null) {
      if (++refs > MAX_REFS) throw new Loose("too_large", `the schema holds more than ${MAX_REFS} references`);
      const absolute = (n.schema as { __absolute_ref__?: string }).__absolute_ref__ ?? n.ref;
      const target = Object.hasOwn(lookup, absolute) ? lookup[absolute] : undefined;
      if (target === undefined) {
        const local = absolute.split("#")[0] === BASE_URI.href || n.ref.startsWith("#");
        throw new Loose(local ? "invalid_schema" : "remote_ref", local ? "a $ref points at nothing in the schema" : "a $ref points outside the schema");
      }
      const node = byObject.get(target);
      if (node) out.push(node);
    }
    edges.set(n, out);
  }

  const size = new Map<Node, number>();
  const open = new Set<Node>();
  for (const start of nodes) {
    if (size.has(start)) continue;
    const stack: Array<{ node: Node; next: number }> = [{ node: start, next: 0 }];
    open.add(start);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = edges.get(frame.node)!;
      if (frame.next < children.length) {
        const child = children[frame.next++]!;
        if (open.has(child)) throw new Loose("ref_cycle", "a $ref leads back to itself without moving into the value");
        if (!size.has(child)) {
          open.add(child);
          stack.push({ node: child, next: 0 });
        }
        continue;
      }
      let total = 1;
      for (const child of children) total += size.get(child)!;
      if (total > MAX_IN_PLACE) throw new Loose("too_large", `more than ${MAX_IN_PLACE} sub-schemas can apply at one place in a value`);
      size.set(frame.node, total);
      open.delete(frame.node);
      stack.pop();
    }
  }
}

const preparedCache = new WeakMap<object, Prepared | SchemaAssessment>();

function prepare(schema: unknown): Prepared | SchemaAssessment {
  const cacheable = typeof schema === "object" && schema !== null;
  if (cacheable) {
    const hit = preparedCache.get(schema);
    if (hit) return hit;
  }
  const result = prepareUncached(schema);
  if (cacheable) preparedCache.set(schema, result);
  return result;
}

function prepareUncached(schema: unknown): Prepared | SchemaAssessment {
  try {
    let json: string;
    try {
      json = JSON.stringify(schema);
    } catch {
      throw new Loose("invalid_schema", "the schema is not JSON");
    }
    if (json === undefined) throw new Loose("invalid_schema", "the schema is not JSON");
    if (Buffer.byteLength(json, "utf8") > MAX_SCHEMA_BYTES) throw new Loose("too_large", `the schema is larger than ${MAX_SCHEMA_BYTES} bytes`);
    const doc: unknown = JSON.parse(json);
    if (depthOf(doc) > MAX_SCHEMA_DEPTH) throw new Loose("too_large", `the schema nests deeper than ${MAX_SCHEMA_DEPTH} levels`);
    const draft = draftOf(isObject(doc) ? doc.$schema : undefined);
    const nodes: Node[] = [];
    const root = copy(doc, "schema", draft, nodes) as Schema | boolean;
    let lookup: Record<string, Schema | boolean>;
    try {
      lookup = dereference(root, Object.create(null), BASE_URI);
    } catch {
      throw new Loose("invalid_schema", "the schema's $id or $anchor values do not resolve");
    }
    assertBoundedInPlace(nodes, lookup);
    return { root, draft, lookup };
  } catch (error) {
    if (error instanceof Loose) return { check: "loose", reason: error.reason, detail: error.detail };
    throw error;
  }
}

export function assessMcpSchema(schema: unknown): SchemaAssessment {
  const prepared = prepare(schema);
  return "check" in prepared ? prepared : { check: "full", reason: null, detail: null };
}

export interface ArgumentsCheck {
  valid: boolean;
  errors: string[];
}

function pathOf(base: string, pointer: string): string {
  const parts = pointer.replace(/^#/, "").split("/").slice(1);
  let out = base;
  for (const raw of parts) {
    let part = raw;
    try {
      part = decodeURI(raw);
    } catch {
    }
    part = part.replace(/~1/g, "/").replace(/~0/g, "~");
    out += /^\d+$/.test(part) ? `[${part}]` : `.${part}`;
  }
  return out;
}

const WRAPPERS = new Set(["$ref", "properties", "patternProperties", "items", "prefixItems", "additionalItems", "dependentSchemas"]);
const MAX_ERRORS = 5;

function describe(errors: OutputUnit[], base: string): string[] {
  const specific = errors.filter((e) => !WRAPPERS.has(e.keyword));
  const shown = (specific.length > 0 ? specific : errors).slice(0, MAX_ERRORS);
  return shown.map((e) => {
    const text = `${pathOf(base, e.instanceLocation)}: ${e.error}`;
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  });
}

export function validateMcpArguments(schema: unknown, args: unknown, check: SchemaCheck, path = "input"): ArgumentsCheck {
  let copyOfArgs: unknown;
  let bytes: number;
  try {
    const json = JSON.stringify(args);
    if (json === undefined) return { valid: false, errors: [`${path}: must be a JSON object`] };
    bytes = Buffer.byteLength(json, "utf8");
    copyOfArgs = JSON.parse(json);
  } catch {
    return { valid: false, errors: [`${path}: must be JSON`] };
  }

  if (check === "loose") {
    if (!isObject(copyOfArgs)) return { valid: false, errors: [`${path}: must be a JSON object`] };
    if (bytes > MAX_LOOSE_ARGUMENT_BYTES) {
      return { valid: false, errors: [`${path}: is ${bytes} bytes, more than the ${MAX_LOOSE_ARGUMENT_BYTES} a loosely checked tool accepts`] };
    }
    return { valid: true, errors: [] };
  }

  const prepared = prepare(schema);
  if ("check" in prepared) {
    return {
      valid: false,
      errors: [`${path}: cannot be checked, because the tool's input schema can no longer be checked in full (${prepared.reason}). Nothing was sent.`],
    };
  }

  budget = { left: MAX_MCP_VISITS };
  try {
    const result = validate(copyOfArgs, prepared.root, prepared.draft, prepared.lookup, true);
    return result.valid ? { valid: true, errors: [] } : { valid: false, errors: describe(result.errors, path) };
  } catch (error) {
    if (error === WORK_LIMIT || error instanceof RangeError) {
      return { valid: false, errors: [`${path}: is too large for the tool's schema to check`] };
    }
    return { valid: false, errors: [`${path}: could not be checked against the tool's schema`] };
  } finally {
    budget = null;
  }
}
