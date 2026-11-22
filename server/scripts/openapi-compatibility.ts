import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extensionFiles, loadContract, loadContractAtRef, parseContract } from "./contract.ts";

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);
type Change = { operationId?: string; path: string; message: string };

function load(source: string): any {
  if (existsSync(source)) return parseContract(readFileSync(source, "utf8"), source);
  return loadContractAtRef(source, process.cwd());
}

function resolveRef(root: any, input: any): any {
  const seen = new Set<string>();
  while (input?.$ref?.startsWith("#/") && !seen.has(input.$ref)) {
    seen.add(input.$ref);
    input = input.$ref.slice(2).split("/").reduce((value: any, key: string) => value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], root);
  }
  return input ?? {};
}

function operations(api: any): Map<string, { operation: any; pathItem: any }> {
  const result = new Map<string, { operation: any; pathItem: any }>();
  for (const [path, pathItem] of Object.entries(api.paths ?? {}) as Array<[string, any]>) {
    for (const [method, operation] of Object.entries(pathItem) as Array<[string, any]>) {
      if (METHODS.has(method)) result.set(`${method.toUpperCase()} ${path}`, { operation, pathItem });
    }
  }
  return result;
}

function schemaType(schema: any): string | undefined {
  return schema.type ?? (schema.properties ? "object" : schema.items ? "array" : undefined);
}

function compareSchema(oldRoot: any, newRoot: any, oldInput: any, newInput: any, path: string, mode: "request" | "response", changes: Change[], operationId?: string): void {
  const oldSchema = resolveRef(oldRoot, oldInput);
  const newSchema = resolveRef(newRoot, newInput);
  if (!newInput) { changes.push({ operationId, path, message: "schema was removed" }); return; }
  const oldType = schemaType(oldSchema);
  const newType = schemaType(newSchema);
  if (oldType && newType && oldType !== newType) changes.push({ operationId, path, message: `type changed from ${oldType} to ${newType}` });
  if (oldSchema.enum) {
    const oldValues = oldSchema.enum.map(JSON.stringify);
    const newValues = (newSchema.enum ?? []).map(JSON.stringify);
    const removed = oldValues.filter((value: string) => !newValues.includes(value));
    const added = newValues.filter((value: string) => !oldValues.includes(value));
    if (removed.length > 0 || (mode === "response" && added.length > 0)) changes.push({ operationId, path, message: `enum compatibility changed (removed ${removed.length}, added ${added.length})` });
  }
  if (mode === "request") {
    if (oldSchema.nullable && !newSchema.nullable) changes.push({ operationId, path, message: "no longer accepts null" });
    if ((newSchema.minimum ?? -Infinity) > (oldSchema.minimum ?? -Infinity)) changes.push({ operationId, path, message: "minimum was increased" });
    if ((newSchema.maximum ?? Infinity) < (oldSchema.maximum ?? Infinity)) changes.push({ operationId, path, message: "maximum was decreased" });
    if ((newSchema.minLength ?? 0) > (oldSchema.minLength ?? 0)) changes.push({ operationId, path, message: "minimum length was increased" });
    if ((newSchema.maxLength ?? Infinity) < (oldSchema.maxLength ?? Infinity)) changes.push({ operationId, path, message: "maximum length was decreased" });
  } else {
    if (!oldSchema.nullable && newSchema.nullable) changes.push({ operationId, path, message: "response may now be null" });
    if ((newSchema.minimum ?? -Infinity) < (oldSchema.minimum ?? -Infinity)) changes.push({ operationId, path, message: "response minimum was broadened" });
    if ((newSchema.maximum ?? Infinity) > (oldSchema.maximum ?? Infinity)) changes.push({ operationId, path, message: "response maximum was broadened" });
  }
  if (oldType === "object") {
    const oldProperties = oldSchema.properties ?? {};
    const newProperties = newSchema.properties ?? {};
    for (const [name, child] of Object.entries(oldProperties)) {
      if (!(name in newProperties)) changes.push({ operationId, path: `${path}.${name}`, message: `${mode} property was removed` });
      else compareSchema(oldRoot, newRoot, child, newProperties[name], `${path}.${name}`, mode, changes, operationId);
    }
    if (mode === "request") {
      const oldRequired = new Set(oldSchema.required ?? []);
      for (const name of newSchema.required ?? []) if (!oldRequired.has(name)) changes.push({ operationId, path: `${path}.${name}`, message: "request property became required" });
    }
  }
  if (oldType === "array") compareSchema(oldRoot, newRoot, oldSchema.items, newSchema.items, `${path}[]`, mode, changes, operationId);
}

function mediaSchema(root: any, input: any): any {
  const resolved = resolveRef(root, input);
  return resolved?.content?.["application/json"]?.schema ?? resolved?.content?.["multipart/form-data"]?.schema;
}

function parameters(root: any, pathItem: any, operation: any): Map<string, any> {
  return new Map([...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].map((input: any) => {
    const value = resolveRef(root, input);
    return [`${value.in}:${value.name}`, value];
  }));
}

export function findBreakingChanges(oldApi: any, newApi: any): Change[] {
  const changes: Change[] = [];
  const oldOperations = operations(oldApi);
  const newOperations = operations(newApi);
  for (const [route, oldEntry] of oldOperations) {
    const operationId = oldEntry.operation.operationId;
    const newEntry = newOperations.get(route);
    if (!newEntry) { changes.push({ operationId, path: route, message: "operation was removed" }); continue; }
    if (newEntry.operation.operationId !== operationId) changes.push({ operationId, path: route, message: "operationId changed" });
    for (const key of ["security", "x-anlyon-audience", "x-anlyon-scopes"] as const) {
      const oldValue = oldEntry.operation[key] ?? oldApi[key];
      const newValue = newEntry.operation[key] ?? newApi[key];
      if (JSON.stringify(oldValue ?? null) !== JSON.stringify(newValue ?? null)) changes.push({ operationId, path: route, message: `${key} changed` });
    }
    const oldParameters = parameters(oldApi, oldEntry.pathItem, oldEntry.operation);
    const newParameters = parameters(newApi, newEntry.pathItem, newEntry.operation);
    for (const [key, oldParameter] of oldParameters) {
      const next = newParameters.get(key);
      if (!next) changes.push({ operationId, path: `${route} parameter ${key}`, message: "parameter was removed" });
      else compareSchema(oldApi, newApi, oldParameter.schema, next.schema, `${route} parameter ${key}`, "request", changes, operationId);
    }
    for (const [key, parameter] of newParameters) if (parameter.required && !oldParameters.get(key)?.required) changes.push({ operationId, path: `${route} parameter ${key}`, message: "parameter became required" });
    const oldBody = resolveRef(oldApi, oldEntry.operation.requestBody);
    const newBody = resolveRef(newApi, newEntry.operation.requestBody);
    if (oldBody?.required !== true && newBody?.required === true) changes.push({ operationId, path: `${route} requestBody`, message: "request body became required" });
    const oldRequestSchema = mediaSchema(oldApi, oldEntry.operation.requestBody);
    if (oldRequestSchema) compareSchema(oldApi, newApi, oldRequestSchema, mediaSchema(newApi, newEntry.operation.requestBody), `${route} request`, "request", changes, operationId);
    for (const [status, oldResponse] of Object.entries(oldEntry.operation.responses ?? {}) as Array<[string, any]>) {
      if (!/^[23]/.test(status)) continue;
      const newResponse = newEntry.operation.responses?.[status];
      if (!newResponse) { changes.push({ operationId, path: `${route} response ${status}`, message: "success response was removed" }); continue; }
      const oldResponseSchema = mediaSchema(oldApi, oldResponse);
      if (oldResponseSchema) compareSchema(oldApi, newApi, oldResponseSchema, mediaSchema(newApi, newResponse), `${route} response ${status}`, "response", changes, operationId);
    }
  }
  return changes;
}

type Acknowledgement = {
  operationId: string;
  path: string;
  message: string;
  reason: string;
  disclosedOn: string;
};

const ACKNOWLEDGEMENTS_FILE = "contracts/breaking-change-acknowledgements.json";

function loadAcknowledgements(): Acknowledgement[] {
  const root = process.cwd();
  const files = [resolve(root, ACKNOWLEDGEMENTS_FILE), ...extensionFiles(root, ACKNOWLEDGEMENTS_FILE).map(({ file }) => file)];
  return files.filter((path) => existsSync(path)).flatMap((path) => {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed.acknowledged) ? parsed.acknowledged : [];
  });
}

function matches(change: Change, ack: Acknowledgement): boolean {
  return (
    change.operationId === ack.operationId &&
    change.path === ack.path &&
    change.message.includes(ack.message)
  );
}

export function classifyChanges(
  baseChanges: Change[],
  releaseChanges: Change[],
  acknowledgements: Acknowledgement[],
  unreleased: ReadonlySet<string> = new Set(),
  releasedPaths?: ReadonlySet<string>,
) {
  const toUnreleased = baseChanges.filter((change) =>
    (change.operationId !== undefined && unreleased.has(change.operationId)) || (releasedPaths !== undefined && !releasedPaths.has(change.path)));
  const judged = baseChanges.filter((change) => !toUnreleased.includes(change));
  const acknowledged = judged.filter((change) => acknowledgements.some((ack) => matches(change, ack)));
  const changes = judged.filter((change) => !acknowledged.includes(change));
  const stale = acknowledgements.filter((ack) => !releaseChanges.some((change) => matches(change, ack)));
  return { acknowledged, changes, stale, unreleased: toUnreleased };
}

export function schemaPaths(api: any): Set<string> {
  const paths = new Set<string>();
  const walk = (input: any, path: string, refs: ReadonlySet<string>): void => {
    paths.add(path);
    const ref = input?.$ref;
    if (typeof ref === "string") {
      if (refs.has(ref)) return;
      refs = new Set([...refs, ref]);
    }
    const schema = resolveRef(api, input);
    const type = schemaType(schema);
    if (type === "object") for (const [name, child] of Object.entries(schema.properties ?? {})) walk(child, `${path}.${name}`, refs);
    if (type === "array" && schema.items) walk(schema.items, `${path}[]`, refs);
  };
  for (const [route, { operation, pathItem }] of operations(api)) {
    paths.add(route);
    paths.add(`${route} requestBody`);
    for (const [key, parameter] of parameters(api, pathItem, operation)) walk(parameter.schema, `${route} parameter ${key}`, new Set());
    const request = mediaSchema(api, operation.requestBody);
    if (request) walk(request, `${route} request`, new Set());
    for (const [status, response] of Object.entries(operation.responses ?? {}) as Array<[string, any]>) {
      paths.add(`${route} response ${status}`);
      const schema = mediaSchema(api, response);
      if (schema) walk(schema, `${route} response ${status}`, new Set());
    }
  }
  return paths;
}

export function unreleasedOperations(release: any, current: any): Set<string> {
  const released = operations(release);
  return new Set(
    [...operations(current)]
      .filter(([route]) => !released.has(route))
      .map(([, entry]) => entry.operation.operationId)
      .filter((operationId): operationId is string => typeof operationId === "string"),
  );
}

function main(): void {
  const base = process.argv[2] ?? "origin/main";
  const current = process.argv[3];
  const releaseBase = process.env.ANLYON_CONTRACT_RELEASE_BASE ?? "origin/main";
  const currentApi = current === undefined ? loadContract(process.cwd()) : load(current);
  const all = findBreakingChanges(load(base), currentApi);
  const releaseApi = releaseBase === base ? null : load(releaseBase);
  const released = releaseApi ? findBreakingChanges(releaseApi, currentApi) : all;
  const acknowledgements = loadAcknowledgements();

  const { acknowledged, changes, stale, unreleased } = classifyChanges(
    all,
    released,
    acknowledgements,
    releaseApi ? unreleasedOperations(releaseApi, currentApi) : new Set(),
    releaseApi ? schemaPaths(releaseApi) : undefined,
  );

  console.log("Anlyon OpenAPI compatibility");
  console.log(`  Base:             ${base}`);
  if (releaseBase !== base) console.log(`  Release base:     ${releaseBase} (staleness is judged against it)`);
  console.log(`  Breaking changes: ${changes.length}`);
  for (const change of changes) console.log(`  - ${change.operationId ? `${change.operationId}: ` : ""}${change.path}  ${change.message}`);

  if (acknowledged.length > 0) {
    console.log(`  Acknowledged:     ${acknowledged.length} (see ${ACKNOWLEDGEMENTS_FILE} and src/extensions/*/${ACKNOWLEDGEMENTS_FILE})`);
    for (const change of acknowledged) {
      const ack = acknowledgements.find((candidate) => matches(change, candidate));
      console.log(`  ~ ${change.operationId}: ${change.path}  ${change.message}`);
      console.log(`      ${ack?.reason} (disclosed ${ack?.disclosedOn})`);
    }
  }

  if (unreleased.length > 0) {
    console.log(`  Unreleased:       ${unreleased.length} (operations or fields ${releaseBase} does not have yet; not breaking)`);
    for (const change of unreleased) console.log(`  · ${change.operationId}: ${change.path}  ${change.message}`);
  }

  if (stale.length > 0) {
    console.log(`\n  Stale acknowledgements: ${stale.length}`);
    for (const ack of stale) console.log(`  ! ${ack.operationId}: ${ack.path}  ${ack.message}`);
    console.log(`\nRemove these from ${ACKNOWLEDGEMENTS_FILE}. They no longer describe a change against`);
    console.log(`${releaseBase}, so they are a standing pre-approval for whatever lands on that path next.`);
    process.exitCode = 1;
    return;
  }

  if (changes.length > 0) {
    console.log("\nIf one of these is deliberate, record it in");
    console.log(`${ACKNOWLEDGEMENTS_FILE} with a reason and the changelog date that discloses it.`);
    console.log("Do not weaken this gate.");
    process.exitCode = 1;
    return;
  }

  console.log("\nOpenAPI compatibility gate passed.");
}

if (process.argv[1]?.endsWith("openapi-compatibility.ts")) main();
