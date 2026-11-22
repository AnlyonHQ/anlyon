import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { extensionFiles, loadContract, loadFragments, mergeContract, unresolvedRefs } from "./contract.ts";

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const MUTATIONS = new Set(["post", "put", "patch", "delete"]);
const REQUEST_ID_REF = "#/components/parameters/RequestId";
const IDEMPOTENCY_KEY_REF = "#/components/parameters/IdempotencyKey";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Problem = { operationId?: string; message: string };
type SdkLanguage = "typescript" | "python";

function resolveRef(root: any, value: any): any {
  const seen = new Set<string>();
  while (value && typeof value === "object" && typeof value.$ref === "string") {
    const ref = value.$ref;
    if (!ref.startsWith("#/") || seen.has(ref)) return value;
    seen.add(ref);
    value = ref
      .slice(2)
      .split("/")
      .map((part: string) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce((current: any, part: string) => current?.[part], root);
    if (value === undefined) throw new Error(`Unresolved OpenAPI reference: ${ref}`);
  }
  return value;
}

function operationEntries(api: any): Array<{ path: string; method: string; operation: any; pathItem: any }> {
  return Object.entries(api.paths ?? {}).flatMap(([path, pathItem]: [string, any]) =>
    Object.entries(pathItem)
      .filter(([method]) => METHODS.has(method))
      .map(([method, operation]) => ({ path, method, operation, pathItem })),
  );
}

function parameterRefs(parameters: any[]): Set<string> {
  return new Set(parameters.flatMap((parameter) => typeof parameter?.$ref === "string" ? [parameter.$ref] : []));
}

function effectiveParameters(pathItem: any, operation: any): any[] {
  return [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
}

function effectiveSecurity(api: any, operation: any): any[] {
  return operation.security === undefined ? (api.security ?? []) : operation.security;
}

function successResponses(operation: any): Array<[string, any]> {
  return Object.entries(operation.responses ?? {}).filter(([status]) => /^[23]/.test(status));
}

function jsonMedia(root: any, responseOrRequestBody: any): any | undefined {
  const resolved = resolveRef(root, responseOrRequestBody);
  return resolved?.content?.["application/json"] ?? resolved?.content?.["multipart/form-data"];
}

function objectProperties(root: any, schema: any): Record<string, any> {
  schema = resolveRef(root, schema);
  const properties = { ...(schema?.properties ?? {}) };
  for (const part of schema?.allOf ?? []) Object.assign(properties, objectProperties(root, part));
  return properties;
}

function knownPatternValue(pattern: string): string {
  if (pattern.startsWith("^https://discord")) return "https://discord.com/api/webhooks/123/token";
  if (pattern.startsWith("^anlyon_live_")) return "anlyon_live_example";
  if (pattern.includes("[A-Z0-9_]")) return "EXAMPLE";
  if (pattern.includes("\\*")) return "*";
  const prefix = pattern.match(/\^([A-Za-z]+_)/)?.[1];
  if (prefix && pattern.includes("{21}")) return `${prefix}${"a".repeat(21)}`;
  if (prefix) return `${prefix}example`;
  if (pattern.includes("\\d{3}")) return "200";
  if (pattern.includes("(?::")) return "tenant:example";
  if (pattern.includes("\\.")) return "example.event";
  return "example";
}

function stringExample(schema: any): string {
  if (schema.pattern) return knownPatternValue(schema.pattern);
  if (schema.format === "uuid") return "123e4567-e89b-42d3-a456-426614174000";
  if (schema.format === "date-time") return "2026-07-13T12:00:00.000Z";
  if (schema.format === "date") return "2026-07-13";
  if (schema.format === "email") return "developer@example.com";
  if (schema.format === "uri" || schema.format === "url") return "https://example.com/webhook";
  const minimum = Math.max(schema.minLength ?? 0, 1);
  return "example".padEnd(minimum, "x").slice(0, schema.maxLength ?? Number.POSITIVE_INFINITY);
}

function generateExample(root: any, input: any, mode: "request" | "response", trail = new Set<string>()): Json {
  if (input?.$ref) {
    if (trail.has(input.$ref)) return null;
    trail = new Set(trail).add(input.$ref);
  }
  const schema = resolveRef(root, input) ?? {};
  if (schema.example !== undefined) return structuredClone(schema.example);
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.const !== undefined) return structuredClone(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return structuredClone(schema.enum[0]);
  if (schema.oneOf?.length) return generateExample(root, schema.oneOf[0], mode, trail);
  if (schema.anyOf?.length) return generateExample(root, schema.anyOf[0], mode, trail);
  if (schema.allOf?.length) {
    const values = schema.allOf.map((part: any) => generateExample(root, part, mode, trail));
    if (values.every((value: Json) => value && typeof value === "object" && !Array.isArray(value))) {
      return Object.assign({}, ...values);
    }
    return values.at(-1) ?? null;
  }

  const inferredType = schema.type ?? (schema.properties ? "object" : schema.items ? "array" : undefined);
  if (inferredType === "object") {
    const output: Record<string, Json> = {};
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      const resolvedProperty = resolveRef(root, property);
      if (mode === "request" && resolvedProperty?.readOnly) continue;
      if (mode === "response" && resolvedProperty?.writeOnly) continue;
      output[name] = generateExample(root, property, mode, trail);
    }
    return output;
  }
  if (inferredType === "array") {
    if (schema.maxItems === 0) return [];
    return [generateExample(root, schema.items ?? {}, mode, trail)];
  }
  if (inferredType === "string") return stringExample(schema);
  if (inferredType === "integer") return Math.ceil(schema.minimum ?? 0);
  if (inferredType === "number") return schema.minimum ?? 0;
  if (inferredType === "boolean") return true;
  if (schema.nullable) return null;
  return {};
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateExample(root: any, input: any, value: any, path = "example", trail = new Set<string>()): string[] {
  if (input?.$ref) {
    if (trail.has(input.$ref)) return [];
    trail = new Set(trail).add(input.$ref);
  }
  const schema = resolveRef(root, input) ?? {};
  if (value === null && schema.nullable) return [];
  if (schema.allOf) return schema.allOf.flatMap((part: any) => validateExample(root, part, value, path, trail));
  if (schema.oneOf || schema.anyOf) {
    const choices = schema.oneOf ?? schema.anyOf;
    if (choices.some((choice: any) => validateExample(root, choice, value, path, trail).length === 0)) return [];
    return [`${path} does not satisfy any allowed schema`];
  }
  if (schema.enum && !schema.enum.some((candidate: unknown) => sameJson(candidate, value))) {
    return [`${path} is not one of the allowed values`];
  }

  const type = schema.type ?? (schema.properties ? "object" : schema.items ? "array" : undefined);
  const errors: string[] = [];
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path} must be an object`];
    for (const required of schema.required ?? []) {
      if (!(required in value)) errors.push(`${path}.${required} is required`);
    }
    for (const [name, child] of Object.entries(value)) {
      if (schema.properties?.[name]) errors.push(...validateExample(root, schema.properties[name], child, `${path}.${name}`, trail));
      else if (schema.additionalProperties === false) errors.push(`${path}.${name} is not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validateExample(root, schema.additionalProperties, child, `${path}.${name}`, trail));
      }
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} has fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} has more than ${schema.maxItems} items`);
    value.forEach((child, index) => errors.push(...validateExample(root, schema.items ?? {}, child, `${path}[${index}]`, trail)));
  } else if (type === "string") {
    if (typeof value !== "string") return [`${path} must be a string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} is shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} does not match ${schema.pattern}`);
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) errors.push(`${path} is not a date-time`);
    if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors.push(`${path} is not a date`);
    if ((schema.format === "uri" || schema.format === "url") && !URL.canParse(value)) errors.push(`${path} is not a URI`);
    if (schema.format === "email" && !/^[^@]+@[^@]+\.[^@]+$/.test(value)) errors.push(`${path} is not an email`);
    if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) errors.push(`${path} is not a UUID`);
  } else if (type === "integer" || type === "number") {
    if (typeof value !== "number" || (type === "integer" && !Number.isInteger(value))) return [`${path} must be a ${type}`];
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} is below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} is above ${schema.maximum}`);
  } else if (type === "boolean" && typeof value !== "boolean") {
    errors.push(`${path} must be a boolean`);
  }
  return errors;
}

function validateEmbeddedSchemaExamples(root: any, input: any, label: string, problems: Problem[], seen = new Set<any>()): void {
  if (!input || typeof input !== "object" || seen.has(input)) return;
  seen.add(input);
  if (input.example !== undefined && (input.type || input.properties || input.items || input.$ref || input.oneOf || input.allOf)) {
    for (const message of validateExample(root, input, input.example, label)) problems.push({ message });
  }
  for (const [key, child] of Object.entries(input)) {
    if (key !== "example" && key !== "examples") validateEmbeddedSchemaExamples(root, child, `${label}.${key}`, problems, seen);
  }
}

function validateDeprecations(input: any, label: string, problems: Problem[], seen = new Set<any>()): void {
  if (!input || typeof input !== "object" || seen.has(input)) return;
  seen.add(input);
  if (input.deprecated === true) {
    if (typeof input["x-anlyon-replacement"] !== "string" || input["x-anlyon-replacement"].trim() === "") {
      problems.push({ message: `${label} is deprecated without x-anlyon-replacement` });
    }
    const removalDate = input["x-anlyon-removal-date"];
    if (typeof removalDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(removalDate)) {
      problems.push({ message: `${label} is deprecated without an ISO x-anlyon-removal-date` });
    } else if (Date.parse(`${removalDate}T23:59:59Z`) <= Date.now()) {
      problems.push({ message: `${label} has passed its deprecation removal date; remove it only in a new API version or extend the announced compatibility window` });
    }
  }
  for (const [key, child] of Object.entries(input)) validateDeprecations(child, `${label}.${key}`, problems, seen);
}

function buildExamples(api: any, problems: Problem[]): Record<string, Json> {
  const examples: Record<string, Json> = {};
  for (const { operation, pathItem } of operationEntries(api).sort((a, b) => a.operation.operationId.localeCompare(b.operation.operationId))) {
    const operationId = operation.operationId;
    const request: Record<string, Json> = {};
    const parameters: Record<string, Json> = {};
    for (const parameterInput of effectiveParameters(pathItem, operation)) {
      const parameter = resolveRef(api, parameterInput);
      if (!parameter?.schema || parameter.$ref === REQUEST_ID_REF) continue;
      parameters[`${parameter.in}.${parameter.name}`] = generateExample(api, parameter.schema, "request");
    }
    if (Object.keys(parameters).length > 0) request.parameters = parameters;
    if (operation.requestBody) {
      const media = jsonMedia(api, operation.requestBody);
      if (media?.schema) {
        const body = generateExample(api, media.schema, "request");
        request.body = body;
        for (const message of validateExample(api, media.schema, body, `${operationId}.request.body`)) problems.push({ operationId, message });
      }
    }

    const responses: Record<string, Json> = {};
    for (const [status, responseInput] of successResponses(operation)) {
      const response = resolveRef(api, responseInput);
      const media = jsonMedia(api, response);
      if (media?.schema) {
        const body = generateExample(api, media.schema, "response");
        responses[status] = body;
        for (const message of validateExample(api, media.schema, body, `${operationId}.responses.${status}`)) problems.push({ operationId, message });
      } else if (response?.headers) {
        responses[status] = Object.fromEntries(Object.entries(response.headers).map(([name, header]: [string, any]) => {
          const resolved = resolveRef(api, header);
          return [name, generateExample(api, resolved.schema ?? {}, "response")];
        }));
      } else {
        responses[status] = null;
      }
    }
    examples[operationId] = { request, responses };
  }
  return examples;
}

function qualityProblems(api: any): Problem[] {
  const problems: Problem[] = [];
  const ids = new Set<string>();
  for (const { path, method, operation, pathItem } of operationEntries(api)) {
    const operationId = operation.operationId;
    const prefix = `${method.toUpperCase()} ${path}`;
    if (!operationId) problems.push({ message: `${prefix} is missing operationId` });
    else if (ids.has(operationId)) problems.push({ operationId, message: "Duplicate operationId" });
    else ids.add(operationId);
    if (operation["x-anlyon-audience"] === undefined) problems.push({ operationId, message: "Missing x-anlyon-audience" });
    if (!Array.isArray(operation["x-anlyon-scopes"])) problems.push({ operationId, message: "Missing x-anlyon-scopes array" });

    const parameters = effectiveParameters(pathItem, operation);
    const refs = parameterRefs(parameters);
    if (!refs.has(REQUEST_ID_REF)) problems.push({ operationId, message: "Missing X-Request-Id parameter" });
    for (const parameterInput of parameters) {
      const parameter = resolveRef(api, parameterInput);
      if (!parameter?.schema) problems.push({ operationId, message: `Parameter ${parameter?.name ?? "unknown"} is missing a schema` });
    }

    const security = effectiveSecurity(api, operation);
    if (security.length > 0 && !operation.responses?.["401"]) problems.push({ operationId, message: "Authenticated operation is missing standard 401 response" });
    if ((operation["x-anlyon-scopes"]?.length ?? 0) > 0 && !operation.responses?.["403"]) problems.push({ operationId, message: "Scoped operation is missing standard 403 response" });

    if (MUTATIONS.has(method)) {
      const policy = operation["x-anlyon-idempotency"];
      if (policy !== "supported" && policy !== "unsupported") problems.push({ operationId, message: "Mutation is missing an idempotency policy" });
      if (policy === "supported" && !refs.has(IDEMPOTENCY_KEY_REF)) problems.push({ operationId, message: "Supported mutation is missing Idempotency-Key" });
      if (policy === "unsupported" && refs.has(IDEMPOTENCY_KEY_REF)) problems.push({ operationId, message: "Unsupported mutation advertises Idempotency-Key" });
    }
    if (operation.requestBody && !jsonMedia(api, operation.requestBody)?.schema) problems.push({ operationId, message: "Request body is missing a schema" });

    const successes = successResponses(operation);
    if (successes.length === 0) problems.push({ operationId, message: "Operation has no documented success response" });
    for (const [status, responseInput] of successes) {
      const response = resolveRef(api, responseInput);
      const media = jsonMedia(api, response);
      const isRedirect = status.startsWith("3") && response?.headers?.Location;
      const isNoContent = status === "204";
      const envelope = operation["x-anlyon-response-envelope"];
      const isRawExport = envelope === "raw-export" || envelope === "html-page" || envelope === "scim";
      if (!media?.schema && !isRedirect && !isNoContent && !isRawExport) {
        problems.push({ operationId, message: `${status} success response is missing a schema` });
      }
      if (media?.schema && status.startsWith("2")) {
        const properties = objectProperties(api, media.schema);
        if (!properties.success && !isRawExport) {
          problems.push({ operationId, message: `${status} JSON response is missing the success envelope` });
        }
        const pagination = properties.pagination;
        if (pagination?.$ref === "#/components/schemas/Pagination") problems.push({ operationId, message: "Uses deprecated Pagination instead of OffsetPagination" });
      }
    }
  }
  validateEmbeddedSchemaExamples(api, api, "openapi", problems);
  validateDeprecations(api, "openapi", problems);
  return problems;
}

function idempotencySupportProblems(api: any, manifest: any): Problem[] {
  const required = operationEntries(api)
    .filter(
      ({ operation }) =>
        operation["x-anlyon-audience"] === "public" &&
        operation["x-anlyon-idempotency"] === "supported",
    )
    .map(({ operation }) => operation.operationId)
    .filter((operationId): operationId is string => typeof operationId === "string")
    .sort();

  const declared = manifest.idempotency;
  if (typeof declared !== "object" || declared === null) {
    return [{ message: "SDK support manifest is missing the idempotency section" }];
  }

  const problems: Problem[] = [];
  for (const language of ["typescript", "python"] as const satisfies readonly SdkLanguage[]) {
    const ids = declared[language];
    if (!Array.isArray(ids) || ids.some((value: unknown) => typeof value !== "string")) {
      problems.push({ message: `idempotency support manifest is missing a valid ${language} array` });
      continue;
    }
    const missing = required.filter((id) => !ids.includes(id));
    const stale = ids.filter((id: string) => !required.includes(id));
    if (missing.length > 0) {
      problems.push({ message: `${language} SDK does not accept an idempotency key for: ${missing.join(", ")}` });
    }
    if (stale.length > 0) {
      problems.push({ message: `${language} SDK declares idempotency for non-idempotent operations: ${stale.join(", ")}` });
    }
    if (JSON.stringify(ids) !== JSON.stringify([...ids].sort())) {
      problems.push({ message: `${language} idempotency operation IDs must be sorted` });
    }
  }
  return problems;
}

const SDK_MANIFEST = "contracts/sdk-operation-support.json";

function loadSdkManifest(root: string): { manifest?: any; problems: Problem[] } {
  const main = resolve(root, SDK_MANIFEST);
  if (!existsSync(main)) return { problems: [{ message: `Missing ${SDK_MANIFEST}` }] };
  const files = [{ name: "core", file: main }, ...extensionFiles(root, SDK_MANIFEST)];
  const problems: Problem[] = [];
  const parts: Array<{ label: string; data: any }> = [];
  for (const { file } of files) {
    const label = relative(root, file);
    try {
      parts.push({ label, data: JSON.parse(readFileSync(file, "utf8")) });
    } catch (error) {
      return { problems: [{ message: `Invalid SDK operation support manifest ${label}: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
  const union = (pick: (data: any) => unknown, list: string): unknown => {
    const lists = parts.map(({ label, data }) => ({ label, ids: pick(data) }));
    if (lists.some(({ ids }) => !Array.isArray(ids))) return lists[0].ids;
    const seen = new Map<string, string>();
    for (const { label, ids } of lists as Array<{ label: string; ids: unknown[] }>) {
      if (JSON.stringify(ids) !== JSON.stringify([...ids].sort())) problems.push({ message: `${label}: ${list} operation IDs must be sorted` });
      for (const id of ids) {
        if (typeof id !== "string") continue;
        if (seen.has(id) && seen.get(id) !== label) problems.push({ message: `${id} is listed for ${list} in both ${seen.get(id)} and ${label}` });
        seen.set(id, label);
      }
    }
    return lists.flatMap(({ ids }) => ids as unknown[]).sort();
  };
  const manifest = {
    ...parts[0].data,
    typescript: union((data) => data.typescript ?? [], "typescript"),
    python: union((data) => data.python ?? [], "python"),
    idempotency: parts[0].data.idempotency && {
      typescript: union((data) => data.idempotency?.typescript ?? [], "idempotency.typescript"),
      python: union((data) => data.idempotency?.python ?? [], "idempotency.python"),
    },
  };
  return { manifest, problems };
}

function sdkSupportProblems(api: any, manifest: any): Problem[] {
  const publicIds = operationEntries(api)
    .filter(({ operation }) => operation["x-anlyon-audience"] === "public")
    .map(({ operation }) => operation.operationId)
    .filter((operationId): operationId is string => typeof operationId === "string")
    .sort();
  const publicSet = new Set(publicIds);
  const problems: Problem[] = [];
  for (const language of ["typescript", "python"] as const satisfies readonly SdkLanguage[]) {
    const declared = manifest[language];
    if (!Array.isArray(declared)) {
      problems.push({ message: `SDK support manifest is missing the ${language} operation array` });
      continue;
    }
    const invalid = declared.filter((value: unknown) => typeof value !== "string");
    if (invalid.length > 0) problems.push({ message: `${language} SDK support contains non-string operation IDs` });
    const ids = declared.filter((value: unknown): value is string => typeof value === "string");
    const duplicates = ids.filter((id: string, index: number) => ids.indexOf(id) !== index);
    if (duplicates.length > 0) problems.push({ message: `${language} SDK support repeats: ${[...new Set(duplicates)].join(", ")}` });
    const missing = publicIds.filter((id) => !ids.includes(id));
    const stale = ids.filter((id) => !publicSet.has(id));
    if (missing.length > 0) problems.push({ message: `${language} SDK is missing public operations: ${missing.join(", ")}` });
    if (stale.length > 0) problems.push({ message: `${language} SDK declares removed/non-public operations: ${stale.join(", ")}` });
    if (JSON.stringify(ids) !== JSON.stringify([...ids].sort())) problems.push({ message: `${language} SDK operation IDs must be sorted` });
  }

  problems.push(...idempotencySupportProblems(api, manifest));
  return problems;
}

type ExamplesArtifact = { path: string; examples: Record<string, Json> };

function exampleArtifacts(root: string, core: any, api: any, problems: Problem[]): ExamplesArtifact[] {
  const coreExamples = buildExamples(core, problems);
  const artifacts: ExamplesArtifact[] = [{ path: resolve(root, "docs/generated/api-examples.json"), examples: coreExamples }];
  const overlaid: Record<string, Json> = { ...coreExamples };
  for (const fragment of loadFragments(root)) {
    const withExtension = buildExamples(mergeContract(core, [fragment]), problems);
    const share = Object.fromEntries(
      Object.entries(withExtension).filter(([id, example]) => !sameJson(coreExamples[id], example)),
    );
    Object.assign(overlaid, share);
    artifacts.push({ path: resolve(dirname(fragment.file), "docs/generated/api-examples.json"), examples: share });
  }
  const full = buildExamples(api, problems);
  if (!sameJson(Object.fromEntries(Object.entries(overlaid).sort(([a], [b]) => a.localeCompare(b))), full)) {
    problems.push({ message: "The core examples overlaid with each extension's share are not the full contract's examples (two extensions change the same operation?)" });
  }
  return artifacts;
}

function uniqueProblems(problems: Problem[]): Problem[] {
  const seen = new Set<string>();
  return problems.filter((problem) => {
    const key = `${problem.operationId ?? ""}\u0000${problem.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function main(): void {
  const root = resolve(process.cwd());
  const mode = process.argv[2] ?? "check";
  if (!new Set(["check", "generate", "report"]).has(mode)) throw new Error("Usage: tsx scripts/openapi-quality.ts [check|generate|report]");

  const api = loadContract(root);
  const core = loadContract(root, "core");
  const problems = qualityProblems(api);
  const coreRefs = unresolvedRefs(core);
  for (const ref of coreRefs) {
    problems.push({ message: `openapi.yaml refers to ${ref}, which it does not define; the core document must stand alone` });
  }
  const sdk = loadSdkManifest(root);
  problems.push(...sdk.problems);
  if (sdk.manifest) problems.push(...sdkSupportProblems(api, sdk.manifest));
  const exampleProblems: Problem[] = [];
  const artifacts = coreRefs.length > 0 ? [] : exampleArtifacts(root, core, api, exampleProblems);
  problems.push(...uniqueProblems(exampleProblems));
  const serialize = (examples: Record<string, Json>) => `${JSON.stringify(examples, null, 2)}\n`;

  if (mode === "generate") {
    if (problems.length > 0) throw new Error(`Cannot generate examples with contract problems:\n${problems.map((problem) => `- ${problem.operationId ? `${problem.operationId}: ` : ""}${problem.message}`).join("\n")}`);
    for (const { path, examples } of artifacts) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, serialize(examples));
      console.log(`Generated examples for ${Object.keys(examples).length} operations at ${relative(root, path)}`);
    }
    return;
  }

  for (const { path, examples } of artifacts) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== serialize(examples)) {
      problems.push({ message: `Generated API examples are stale (${relative(root, path)}); run \`pnpm api:contract:examples\`` });
    }
  }
  const examplesTotal = artifacts.reduce((sum, { examples }) => sum + Object.keys(examples).length, 0);
  console.log("Anlyon OpenAPI quality");
  console.log(`  Operations:          ${operationEntries(api).length} (core document: ${operationEntries(core).length})`);
  console.log(`  Generated examples:  ${examplesTotal} in ${artifacts.length} file(s)`);
  console.log(`  Public SDK surface:  ${operationEntries(api).filter(({ operation }) => operation["x-anlyon-audience"] === "public").length} operations/language`);
  console.log(`  Problems:            ${problems.length}`);
  for (const problem of problems) console.log(`  - ${problem.operationId ? `${problem.operationId}: ` : ""}${problem.message}`);
  if (problems.length === 0) console.log("\nOpenAPI quality gate passed.");
  else if (mode === "check") process.exitCode = 1;
}

main();
