import { checkSchemaDefinition, unsafePatternReason } from "../../utils/json-schema.ts";
import type { ImpactDeclarationInput } from "../effects/declarations.ts";
import { suggestForOperation, type ImportSuggestion } from "./import-suggestions.ts";
import type { ActionMethod, CreateActionInput } from "./service.ts";

export const METHODS: ActionMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const ANNOTATION_KEYWORDS = new Set([
  "format",
  "example",
  "examples",
  "multipleOf",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "nullable",
  "readOnly",
  "writeOnly",
  "deprecated",
  "xml",
  "externalDocs",
  "discriminator",
]);

const MAX_REF_DEPTH = 5;

export interface ImportAuthOption {
  headerName: string;
  secretName: string;
  valueTemplate?: string;
}

export interface TranslateOptions {
  auth?: ImportAuthOption;
  requiresApproval?: boolean;
  governed?: boolean;
}

export interface OperationChoice {
  requiresApproval?: boolean;
  impact?: ImpactDeclarationInput | null;
}

export interface ProposedVerify {
  url: string;
  status: number;
  match: Array<{ path: string; equals: string }>;
}

export type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveRefs(node: unknown, spec: Json, depth = 0): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => resolveRefs(item, spec, depth));
  }
  if (!isObject(node)) return node;

  if (typeof node.$ref === "string") {
    if (depth >= MAX_REF_DEPTH) {
      throw new UnsupportedOperation(
        `schema follows more than ${MAX_REF_DEPTH} $ref hops (recursive schema?)`
      );
    }
    return resolveRefs(lookupRef(node.$ref, spec), spec, depth + 1);
  }

  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = resolveRefs(value, spec, depth);
  }
  return out;
}

function lookupRef(ref: string, spec: Json): Json {
  if (!ref.startsWith("#/")) {
    throw new UnsupportedOperation(`external $ref "${ref}"  only local refs are supported`);
  }

  let node: unknown = spec;
  for (const segment of ref.slice(2).split("/")) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(node) || !(key in node)) {
      throw new UnsupportedOperation(`$ref "${ref}" does not resolve`);
    }
    node = node[key];
  }

  if (!isObject(node)) {
    throw new UnsupportedOperation(`$ref "${ref}" is not a schema object`);
  }
  return node;
}

export class UnsupportedOperation extends Error {}

function toSupportedSchema(schema: unknown, path: string, warnings: string[]): Json {
  if (!isObject(schema)) {
    throw new UnsupportedOperation(`${path}: schema is not an object`);
  }

  const out: Json = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === "oneOf" || key === "anyOf" || key === "allOf" || key === "not") {
      throw new UnsupportedOperation(
        `${path}: "${key}" is not supported  Anlyon validates a JSON-Schema subset (see docs), define this action by hand`
      );
    }

    if (ANNOTATION_KEYWORDS.has(key)) {
      warnings.push(`${path}: dropped "${key}" (not enforced by Anlyon's schema subset)`);
      continue;
    }

    switch (key) {
      case "type": {
        if (Array.isArray(value)) {
          throw new UnsupportedOperation(`${path}.type: type unions are not supported`);
        }
        out.type = value;
        break;
      }
      case "properties": {
        if (!isObject(value)) break;
        const properties: Json = {};
        for (const [name, sub] of Object.entries(value)) {
          properties[name] = toSupportedSchema(sub, `${path}.${name}`, warnings);
        }
        out.properties = properties;
        break;
      }
      case "items": {
        out.items = toSupportedSchema(value, `${path}[]`, warnings);
        break;
      }
      case "title":
      case "description":
      case "required":
      case "additionalProperties":
      case "pattern": {
        const unsafe = typeof value === "string" ? unsafePatternReason(value) : null;
        if (unsafe) {
          warnings.push(`${path}: dropped "pattern" (${unsafe})`);
          break;
        }
        out[key] = value;
        break;
      }
      case "enum":
      case "default": {
        out[key] = value;
        break;
      }
      case "minLength":
      case "maxLength":
      case "minItems":
      case "maxItems": {
        if (typeof value === "number" && Number.isInteger(value) && value >= 0) out[key] = value;
        else warnings.push(`${path}: dropped "${key}" (not a non-negative integer)`);
        break;
      }
      case "minimum":
      case "maximum": {
        if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
        else warnings.push(`${path}: dropped "${key}" (not a number)`);
        break;
      }
      case "exclusiveMinimum":
      case "exclusiveMaximum": {
        if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
        else if (typeof value !== "boolean") warnings.push(`${path}: dropped "${key}" (not a number)`);
        break;
      }
      default: {
        if (key.startsWith("x-")) {
          warnings.push(`${path}: dropped vendor extension "${key}"`);
          break;
        }
        throw new UnsupportedOperation(`${path}: unsupported keyword "${key}"`);
      }
    }
  }

  for (const [flag, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ] as const) {
    if (schema[flag] === true && typeof out[bound] === "number") {
      out[flag] = out[bound];
      delete out[bound];
    }
  }

  return out;
}

function sanitizeName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function fallbackName(method: string, path: string): string {
  const slug = path
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/[{}]/g, ""))
    .join("-");
  return sanitizeName(`${method.toLowerCase()}_${slug || "root"}`);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export interface BuiltOperation {
  input: CreateActionInput;
  warnings: string[];
  governed: boolean;
  impact: ImpactDeclarationInput | null;
  suggestion: ImportSuggestion;
  proposedVerify: ProposedVerify | null;
  verifyNote: string | null;
}

const ONE_MUTATION = { dimension: "resource_mutations", amount: "1", bound: "exact" } as const;

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);
const MAX_PROPOSED_MATCHES = 3;

function successSchema(operation: Json, spec: Json): Json | null {
  const responses = isObject(operation.responses) ? operation.responses : {};
  const code = Object.keys(responses).filter((c) => /^2\d\d$/.test(c)).sort()[0];
  if (!code) return null;
  try {
    const response = resolveRefs(responses[code], spec) as Json;
    const content = isObject(response.content) ? response.content : {};
    const json = content["application/json"];
    const schema = isObject(json) ? json.schema : null;
    return isObject(schema) ? schema : null;
  } catch {
    return null;
  }
}

function propertiesOf(schema: Json | null): Json {
  return schema && isObject(schema.properties) ? schema.properties : {};
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([a-zA-Z0-9_.-]+)\}/g)].map((m) => m[1]);
}

function proposeVerify(
  spec: Json,
  baseUrl: string,
  path: string,
  method: ActionMethod,
  operation: Json,
  bodyFields: Json,
): { proposedVerify: ProposedVerify | null; verifyNote: string } {
  const none = (verifyNote: string) => ({ proposedVerify: null, verifyNote });
  if (method === "DELETE") return none("A delete has nothing to read back: the resource is gone. Declare a verify rule by hand if the API keeps a tombstone.");

  const paths = isObject(spec.paths) ? spec.paths : {};
  const own = pathParams(path);
  let readPath: string;
  let idFrom: { param: string; responseField: string } | null = null;

  const samePath = isObject(paths[path]) ? (paths[path] as Json) : {};
  if (method !== "POST" && isObject(samePath.get)) {
    readPath = path;
  } else {
    const prefix = `${path.replace(/\/+$/, "")}/`;
    const item = Object.keys(paths).find((candidate) => {
      if (!candidate.startsWith(prefix)) return false;
      const rest = candidate.slice(prefix.length);
      return /^\{[a-zA-Z0-9_.-]+\}$/.test(rest) && isObject(paths[candidate]) && isObject((paths[candidate] as Json).get);
    });
    if (!item) return none("The spec has no GET that reads back what this write changes.");
    const param = pathParams(item).at(-1)!;
    const returned = propertiesOf(successSchema(operation, spec));
    const responseField = [param, "id"].find((name) => isObject(returned[name]) && SCALAR_TYPES.has(String((returned[name] as Json).type)));
    if (!responseField) return none(`The write's response does not return an id to read it back by (looked for "${param}" and "id").`);
    readPath = item;
    idFrom = { param, responseField };
  }

  const read = (paths[readPath] as Json).get as Json;
  const readParams = [
    ...(Array.isArray((paths[readPath] as Json).parameters) ? ((paths[readPath] as Json).parameters as unknown[]) : []),
    ...(Array.isArray(read.parameters) ? read.parameters : []),
  ];
  for (const raw of readParams) {
    let param: Json;
    try { param = resolveRefs(raw, spec) as Json; } catch { return none("The GET that would read this back has a parameter that could not be resolved."); }
    if (isObject(param) && param.in === "query" && param.required === true) {
      return none(`The GET that would read this back needs the query parameter "${String(param.name)}", which the write does not supply.`);
    }
  }

  const readable = propertiesOf(successSchema(read, spec));
  const match = Object.entries(bodyFields)
    .filter(([name, schema]) => isObject(schema) && SCALAR_TYPES.has(String(schema.type)) && isObject(readable[name]))
    .slice(0, MAX_PROPOSED_MATCHES)
    .map(([name]) => ({ path: name, equals: `{{input.${name}}}` }));
  if (match.length === 0) {
    return none("A GET reads this resource back, but none of the request's fields appears in its response under the same name, so there is nothing to match. Declare a verify rule by hand.");
  }

  const url = joinUrl(baseUrl, readPath).replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_m, param: string) =>
    idFrom && param === idFrom.param && !own.includes(param) ? `{{response.${idFrom.responseField}}}` : `{{input.${param}}}`);
  return {
    proposedVerify: { url, status: 200, match },
    verifyNote: "Proposed from the spec, not applied. Check that the GET returns the value this write set, and that a matching value could not already have been there, then add it as the action's verify rule.",
  };
}

export function buildOperation(
  spec: Json,
  baseUrl: string,
  path: string,
  method: ActionMethod,
  operation: Json,
  pathLevelParams: unknown[],
  options: TranslateOptions,
  choice: OperationChoice | undefined,
): BuiltOperation {
  const warnings: string[] = [];

  const name =
    typeof operation.operationId === "string" && sanitizeName(operation.operationId)
      ? sanitizeName(operation.operationId)
      : fallbackName(method, path);

  const rawParams = [
    ...(Array.isArray(pathLevelParams) ? pathLevelParams : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ];

  const properties: Json = {};
  const required: string[] = [];
  const queryKeys: string[] = [];

  for (const raw of rawParams) {
    const param = resolveRefs(raw, spec) as Json;
    if (!isObject(param) || typeof param.name !== "string") continue;

    const location = param.in;
    if (location !== "path" && location !== "query") {
      warnings.push(
        `parameter "${param.name}" (in: ${String(location)}) was not imported  use the auth option or edit the action`
      );
      continue;
    }

    const schema = param.schema
      ? toSupportedSchema(param.schema, `parameters.${param.name}`, warnings)
      : { type: "string" };

    if (typeof param.description === "string" && !schema.description) {
      schema.description = param.description;
    }

    properties[param.name] = schema;
    if (param.required === true || location === "path") {
      required.push(param.name);
    }
    if (location === "query") queryKeys.push(param.name);
  }

  const leftovers = path.replace(/\{[a-zA-Z0-9_.-]+\}/g, "");
  if (leftovers.includes("{") || leftovers.includes("}")) {
    throw new UnsupportedOperation(`path "${path}" has a placeholder we could not translate`);
  }

  let urlTemplate = joinUrl(baseUrl, path).replace(
    /\{([a-zA-Z0-9_.-]+)\}/g,
    (_match, param: string) => `{{input.${param}}}`
  );

  if (queryKeys.length > 0) {
    const query = queryKeys.map((key) => `${key}={{input.${key}}}`).join("&");
    urlTemplate += `${urlTemplate.includes("?") ? "&" : "?"}${query}`;
  }

  let bodyTemplate: Json | undefined;
  let bodySchema: Json | null = null;
  let formBody = false;

  const requestBody = operation.requestBody
    ? (resolveRefs(operation.requestBody, spec) as Json)
    : null;

  if (requestBody) {
    const content = isObject(requestBody.content) ? requestBody.content : {};
    const json = content["application/json"];
    const form = content["application/x-www-form-urlencoded"];
    const media = isObject(json) ? json : isObject(form) ? form : null;
    formBody = media !== null && media === form;

    if (media === null) {
      const types = Object.keys(content).join(", ") || "none";
      throw new UnsupportedOperation(
        `request body is not application/json or application/x-www-form-urlencoded (${types})`
      );
    }

    const schema = toSupportedSchema(media.schema, "body", warnings);
    bodySchema = schema;
    const bodyProps = isObject(schema.properties) ? schema.properties : {};

    if (formBody) {
      const encoding = isObject(media.encoding) ? media.encoding : {};
      for (const [key, sub] of Object.entries(bodyProps)) {
        const type = isObject(sub) ? sub.type : undefined;
        if (type !== "object" && type !== "array") continue;
        const rule = encoding[key];
        if (!isObject(rule) || rule.style !== "deepObject") {
          throw new UnsupportedOperation(
            `form field "${key}" is an ${String(type)} without \`style: deepObject\`  Anlyon sends nested form values in bracket notation`
          );
        }
      }
    }

    if (schema.type !== undefined && schema.type !== "object") {
      throw new UnsupportedOperation(
        `request body is a bare ${String(schema.type)}  only object bodies can be mapped to inputs`
      );
    }

    bodyTemplate = {};
    for (const [key, sub] of Object.entries(bodyProps)) {
      if (key in properties) {
        throw new UnsupportedOperation(
          `body field "${key}" collides with a path/query parameter of the same name`
        );
      }
      properties[key] = sub;
      bodyTemplate[key] = `{{input.${key}}}`;
    }

    if (Array.isArray(schema.required)) {
      required.push(...(schema.required as string[]).filter((k) => k in bodyProps));
    }

    if (requestBody.required === true && Object.keys(bodyProps).length === 0) {
      throw new UnsupportedOperation("request body is required but has no typed properties");
    }
  }

  const headers: Record<string, string> = {};
  if (options.auth) {
    const template = options.auth.valueTemplate
      ? options.auth.valueTemplate.replace("{{secret}}", `{{secret:${options.auth.secretName}}}`)
      : `{{secret:${options.auth.secretName}}}`;
    headers[options.auth.headerName] = template;
  }
  if (formBody && bodyTemplate && Object.keys(bodyTemplate).length > 0) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const inputSchema: Json = {
    type: "object",
    properties,
    ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
  };

  const problems = checkSchemaDefinition(inputSchema, "inputSchema");
  if (problems.length > 0) {
    throw new UnsupportedOperation(`translated schema is unsupported: ${problems.join("; ")}`);
  }

  const description =
    (typeof operation.summary === "string" && operation.summary) ||
    (typeof operation.description === "string" && operation.description) ||
    undefined;

  if (choice?.impact != null && options.governed === false) {
    throw new UnsupportedOperation("operations sets an impact for it, and governed: false imports plain template actions");
  }
  const governed = choice?.impact !== undefined ? choice.impact !== null : method !== "GET" && options.governed !== false;
  const impact: ImpactDeclarationInput | null = governed ? (choice?.impact ?? { ...ONE_MUTATION }) : null;
  const bodyFields: Json = {};
  for (const key of Object.keys(bodyTemplate ?? {})) bodyFields[key] = properties[key];
  const proposal = governed
    ? proposeVerify(spec, baseUrl, path, method, operation, bodyFields)
    : { proposedVerify: null, verifyNote: null };

  return {
    warnings,
    governed,
    impact,
    suggestion: suggestForOperation(method, path, operation, bodySchema),
    proposedVerify: proposal.proposedVerify,
    verifyNote: proposal.verifyNote,
    input: {
      name,
      description: description?.slice(0, 1000),
      method,
      urlTemplate,
      headers,
      ...(bodyTemplate && Object.keys(bodyTemplate).length > 0 ? { bodyTemplate } : {}),
      inputSchema,
      requiresApproval: choice?.requiresApproval ?? options.requiresApproval ?? false,
      enabled: true,
      ...(impact ? { impact: { ...impact } } : {}),
    },
  };
}


export interface DraftedOperation {
  key: string;
  operationId: string | null;
  method: ActionMethod;
  path: string;
  built: BuiltOperation;
}

export interface DraftResult {
  baseUrl: string;
  operations: DraftedOperation[];
  skipped: Array<{ key: string; reason: string }>;
  notFound: string[];
}

export function draftOperations(spec: Json, options: TranslateOptions & { baseUrl?: string; only: string[] }): DraftResult {
  if (typeof spec.openapi !== "string" || !spec.openapi.startsWith("3.")) {
    throw new Error('Only OpenAPI 3.x is supported (the spec must have an "openapi": "3.x.x" field).');
  }
  const servers = Array.isArray(spec.servers) ? spec.servers : [];
  const baseUrl = options.baseUrl ?? (isObject(servers[0]) && typeof servers[0].url === "string" ? servers[0].url : null);
  if (!baseUrl || !/^https:\/\//i.test(baseUrl)) throw new Error("The spec has no https servers[0].url. Pass a base URL.");
  const paths = isObject(spec.paths) ? spec.paths : {};
  const index = new Map<string, { path: string; method: ActionMethod; operation: Json; pathLevelParams: unknown[] }>();
  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    for (const method of METHODS) {
      const operation = item[method.toLowerCase()];
      if (!isObject(operation)) continue;
      const entry = { path, method, operation, pathLevelParams: Array.isArray(item.parameters) ? item.parameters : [] };
      index.set(`${method} ${path}`, entry);
      if (typeof operation.operationId === "string" && operation.operationId) index.set(operation.operationId, entry);
    }
  }
  const result: DraftResult = { baseUrl, operations: [], skipped: [], notFound: [] };
  for (const key of options.only) {
    const found = index.get(key);
    if (!found) {
      result.notFound.push(key);
      continue;
    }
    try {
      const built = buildOperation(spec, baseUrl, found.path, found.method, found.operation, found.pathLevelParams, options, undefined);
      const operationId = typeof found.operation.operationId === "string" ? found.operation.operationId : null;
      result.operations.push({ key, operationId, method: found.method, path: found.path, built });
    } catch (error) {
      if (!(error instanceof UnsupportedOperation)) throw error;
      result.skipped.push({ key, reason: error.message });
    }
  }
  return result;
}
