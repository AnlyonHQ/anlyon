import { ValidationError } from "../../utils/errors.ts";
import { hasInputRef, INPUT_REF, SECRET_REF, secretRefText, urlTemplateAuthority, usesAccountHost, ACCOUNT_HOST_REF } from "../actions/template.ts";
import { ACCOUNT_HOST_PLACEHOLDER } from "../connections/catalogue.ts";
import { assertReadOnlyGraphqlQuery } from "./graphql.ts";
import type { ActionDeclarations, ActionImpactDeclaration, ActionVerifyDeclaration } from "../../db/schema/actions.ts";
import type { ImpactQuantity } from "./adapter.ts";

export type { ActionDeclarations };
export type ImpactDeclaration = ActionImpactDeclaration;
export type VerifyDeclaration = ActionVerifyDeclaration;
export type ImpactDeclarationInput = Omit<ImpactDeclaration, "unit"> & { unit?: string };
export type VerifyDeclarationInput = Omit<VerifyDeclaration, "match"> & { match?: VerifyDeclaration["match"] };

export const DECLARED_UNIT = /^[a-z][a-z0-9_]{0,31}$/;
const CURRENCY = /^[a-z]{3}$/;
const PATH = "(?:[a-zA-Z0-9_]+|\\*)(?:\\.(?:[a-zA-Z0-9_]+|\\*))*";
const MAX_VERIFY_MATCHES = 10;

export type JsonScalar = string | number | boolean | null;

function record(raw: unknown, label: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError(`${label} must be an object.`);
  return raw as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new ValidationError(`${label} does not accept: ${extra.join(", ")}.`);
}

export function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (Array.isArray(current)) {
      current = /^\d+$/.test(key) ? current[Number(key)] : undefined;
    } else if (current !== null && typeof current === "object") {
      current = Object.prototype.hasOwnProperty.call(current, key) ? (current as Record<string, unknown>)[key] : undefined;
    } else {
      return undefined;
    }
  }
  return current;
}

export function readPathAll(value: unknown, path: string): unknown[] {
  const walk = (current: unknown, keys: string[]): unknown[] => {
    if (keys.length === 0) return current === undefined ? [] : [current];
    const [key, ...rest] = keys as [string, ...string[]];
    if (key === "*") return Array.isArray(current) ? current.flatMap((item) => walk(item, rest)) : [];
    return walk(readPath(current, key), rest);
  };
  return walk(value, path.split("."));
}

export function declaredHost(urlTemplate: string): { host: string; hostname: string } {
  const authority = urlTemplateAuthority(urlTemplate);
  if (!/^https:\/\//i.test(urlTemplate.trim()) || !authority) {
    throw new ValidationError("A governed action must call an https URL with a host.");
  }
  if (usesAccountHost(urlTemplate)) return { host: ACCOUNT_HOST_PLACEHOLDER, hostname: ACCOUNT_HOST_PLACEHOLDER };
  if (hasInputRef(authority)) {
    throw new ValidationError(
      "A governed action must have a fixed host. Remove the {{input.*}} placeholder from the URL's host: an input may not choose where a governed request is sent."
    );
  }
  if (authority.includes("{{") || authority.includes("@")) {
    throw new ValidationError("A governed action must have a fixed host with no placeholder and no credentials in it.");
  }
  let url: URL;
  try {
    url = new URL(`https://${authority}/`);
  } catch {
    throw new ValidationError("A governed action must have a valid host.");
  }
  return { host: url.host.toLowerCase(), hostname: url.hostname.toLowerCase() };
}

export interface AmountExpression {
  term: { kind: "literal"; value: number } | { kind: "input"; path: string } | { kind: "count"; path: string };
  factor: number | null;
}

const AMOUNT = new RegExp(
  `^\\s*(?:(\\d{1,15})|input\\.(${PATH})|count\\(\\s*input\\.(${PATH})\\s*\\))\\s*(?:\\*\\s*(\\d{1,15}))?\\s*$`
);

export function parseAmountExpression(expression: string): AmountExpression {
  const match = AMOUNT.exec(expression);
  if (!match) {
    throw new ValidationError(
      "impact.amount must be an integer, input.<path> or count(input.<path>), optionally followed by * <integer>."
    );
  }
  const [, literal, inputPath, countPath, factor] = match;
  return {
    term: literal !== undefined
      ? { kind: "literal", value: Number(literal) }
      : inputPath !== undefined ? { kind: "input", path: inputPath } : { kind: "count", path: countPath },
    factor: factor === undefined ? null : Number(factor),
  };
}

export function evaluateAmount(expression: string, input: Record<string, unknown>): number | null {
  const { term, factor } = parseAmountExpression(expression);
  let base: number;
  if (term.kind === "literal") {
    base = term.value;
  } else {
    const value = readPath(input, term.path);
    if (value === undefined) return null;
    if (term.kind === "count") {
      if (!Array.isArray(value)) throw new ValidationError(`impact.amount counts input.${term.path}, which must be an array.`);
      base = value.length;
    } else {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new ValidationError(`impact.amount reads input.${term.path}, which must be a non-negative integer.`);
      }
      base = value;
    }
  }
  const amount = factor === null ? base : base * factor;
  if (!Number.isSafeInteger(amount)) throw new ValidationError("impact.amount is too large to count exactly.");
  return amount;
}

export function parseImpactDeclaration(raw: unknown): ImpactDeclaration {
  const value = record(raw, "impact");
  onlyKeys(value, ["dimension", "unit", "amount", "bound"], "impact");
  const { dimension, amount, bound } = value;
  if (typeof dimension !== "string" || !DECLARED_UNIT.test(dimension)) {
    throw new ValidationError("impact.dimension must be money, resource_mutations, or a unit of lowercase letters, digits and underscores (at most 32 characters).");
  }
  let unit: string;
  if (dimension === "money") {
    if (typeof value.unit !== "string" || !CURRENCY.test(value.unit)) {
      throw new ValidationError("impact.unit must be one lowercase ISO currency for money, for example usd.");
    }
    unit = value.unit;
  } else {
    if (value.unit !== undefined && value.unit !== dimension) {
      throw new ValidationError(`impact.unit must be "${dimension}", the dimension name, for anything that is not money.`);
    }
    unit = dimension;
  }
  if (typeof amount !== "string" || amount.length > 200) throw new ValidationError("impact.amount must be an expression of at most 200 characters.");
  parseAmountExpression(amount);
  if (bound !== "exact" && bound !== "upper_bound") throw new ValidationError("impact.bound must be exact or upper_bound.");
  return { dimension, unit, amount: amount.trim(), bound };
}

export function impactQuantity(impact: ImpactDeclaration, input: Record<string, unknown>): ImpactQuantity | null {
  const amount = evaluateAmount(impact.amount, input);
  if (amount === null) return null;
  return impact.dimension === "money"
    ? { dimension: "money", currency: impact.unit, amount, bound: impact.bound }
    : { dimension: impact.dimension, amount, bound: impact.bound };
}

const RESPONSE_REF = /\{\{\s*response\.([a-zA-Z0-9_.]+)\s*\}\}/g;
const WHOLE_REF = /^\{\{\s*(input|response)\.([a-zA-Z0-9_.]+)\s*\}\}$/;
const VERIFY_REF = new RegExp(`${INPUT_REF.source}|${RESPONSE_REF.source}|${SECRET_REF.source}`, "g");

function isScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

export function parseVerifyDeclaration(raw: unknown): VerifyDeclaration {
  const value = record(raw, "verify");
  onlyKeys(value, ["url", "status", "match", "graphql"], "verify");
  const { url, status } = value;
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) throw new ValidationError("verify.url must be a URL of at most 2048 characters.");
  declaredHost(url);
  if (/\{\{\s*input\.[a-zA-Z0-9_.]+:path\s*\}\}/.test(url)) throw new ValidationError("verify.url does not accept the :path modifier.");
  const stray = /\{\{[^}]*\}\}/.exec(url.replace(VERIFY_REF, "").replace(new RegExp(ACCOUNT_HOST_REF.source, "g"), ""));
  if (stray) {
    throw new ValidationError(`verify.url has an unrecognised placeholder ${stray[0]}. Use {{input.field}}, {{response.field}} or {{secret:NAME}}.`);
  }
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new ValidationError("verify.status must be the HTTP status the read-back is expected to answer with.");
  }
  const rawMatch = value.match ?? [];
  if (!Array.isArray(rawMatch) || rawMatch.length > MAX_VERIFY_MATCHES) {
    throw new ValidationError(`verify.match must be a list of at most ${MAX_VERIFY_MATCHES} checks.`);
  }
  const match = rawMatch.map((item, index) => {
    const check = record(item, `verify.match[${index}]`);
    onlyKeys(check, ["path", "equals", "absent"], `verify.match[${index}]`);
    if (check.absent !== undefined && typeof check.absent !== "boolean") {
      throw new ValidationError(`verify.match[${index}].absent must be true or false.`);
    }
    if (typeof check.path !== "string" || !new RegExp(`^${PATH}$`).test(check.path)) {
      throw new ValidationError(`verify.match[${index}].path must be a dotted JSON path such as data.status.`);
    }
    if (!("equals" in check) || !isScalar(check.equals)) {
      throw new ValidationError(`verify.match[${index}].equals must be a string, number, boolean or null.`);
    }
    if (typeof check.equals === "string" && check.equals.includes("{{") && !WHOLE_REF.test(check.equals)) {
      throw new ValidationError(`verify.match[${index}].equals may be a literal or exactly one {{input.field}} or {{response.field}}.`);
    }
    return { path: check.path, equals: check.equals, ...(check.absent === true ? { absent: true } : {}) };
  });
  const graphql = value.graphql === undefined ? null : parseVerifyGraphql(value.graphql);
  return { url, status, match, ...(graphql ? { graphql } : {}) };
}

const MAX_GRAPHQL_VARIABLES = 20;
const VARIABLE_NAME = /^[_A-Za-z][_0-9A-Za-z]{0,63}$/;

function parseVerifyGraphql(raw: unknown): NonNullable<VerifyDeclaration["graphql"]> {
  const value = record(raw, "verify.graphql");
  onlyKeys(value, ["query", "variables"], "verify.graphql");
  const query = assertReadOnlyGraphqlQuery(value.query, "verify.graphql.query");
  const rawVariables = value.variables === undefined ? {} : record(value.variables, "verify.graphql.variables");
  const entries = Object.entries(rawVariables);
  if (entries.length > MAX_GRAPHQL_VARIABLES) throw new ValidationError(`verify.graphql.variables takes at most ${MAX_GRAPHQL_VARIABLES} values.`);
  const variables: Record<string, JsonScalar> = {};
  for (const [name, variable] of entries) {
    if (!VARIABLE_NAME.test(name)) throw new ValidationError(`verify.graphql.variables: ${name} is not a GraphQL variable name.`);
    if (!isScalar(variable)) throw new ValidationError(`verify.graphql.variables.${name} must be a string, number, boolean or null.`);
    if (typeof variable === "string" && variable.includes("{{") && !WHOLE_REF.test(variable)) {
      throw new ValidationError(`verify.graphql.variables.${name} may be a literal or exactly one {{input.field}} or {{response.field}}.`);
    }
    variables[name] = variable;
  }
  return { query, ...(entries.length > 0 ? { variables } : {}) };
}

export interface NormalizedGraphql {
  query: string;
  variables: Record<string, { value: JsonScalar } | { response: string }>;
}

export interface NormalizedVerify {
  url: string;
  status: number;
  match: Array<({ path: string; equals: JsonScalar } | { path: string; equalsResponse: string }) & { absent?: true }>;
  graphql?: NormalizedGraphql;
}

export function normalizeVerify(verify: VerifyDeclaration, input: Record<string, unknown>): NormalizedVerify {
  const fromInput = (path: string): JsonScalar => {
    const value = readPath(input, path);
    if (value === undefined || !isScalar(value)) {
      throw new ValidationError(`The verify rule reads input.${path}, which must be supplied as a string, number, boolean or null.`);
    }
    return value;
  };
  const url = verify.url.replace(
    VERIFY_REF,
    (_m, inputPath: string | undefined, _modifier: string | undefined, responsePath: string | undefined, secretName: string | undefined) => {
      if (inputPath !== undefined) return encodeURIComponent(String(fromInput(inputPath)));
      return responsePath !== undefined ? `{{response.${responsePath}}}` : secretRefText(secretName as string);
    },
  );
  const match = verify.match.map(({ path, equals, absent }) => {
    const flag = absent === true ? { absent: true as const } : {};
    const ref = typeof equals === "string" ? WHOLE_REF.exec(equals) : null;
    if (!ref) return { path, equals, ...flag };
    return ref[1] === "input" ? { path, equals: fromInput(ref[2]), ...flag } : { path, equalsResponse: ref[2], ...flag };
  });
  if (!verify.graphql) return { url, status: verify.status, match };
  const variables: NormalizedGraphql["variables"] = {};
  for (const [name, variable] of Object.entries(verify.graphql.variables ?? {})) {
    const ref = typeof variable === "string" ? WHOLE_REF.exec(variable) : null;
    variables[name] = !ref ? { value: variable } : ref[1] === "input" ? { value: fromInput(ref[2]) } : { response: ref[2] };
  }
  return { url, status: verify.status, match, graphql: { query: verify.graphql.query, variables } };
}

export function verifyNeedsResponse(verify: VerifyDeclaration): boolean {
  return new RegExp(RESPONSE_REF.source).test(verify.url) ||
    verify.match.some((check) => typeof check.equals === "string" && WHOLE_REF.exec(check.equals)?.[1] === "response") ||
    Object.values(verify.graphql?.variables ?? {}).some((v) => typeof v === "string" && WHOLE_REF.exec(v)?.[1] === "response");
}

export function normalizedVerifyNeedsResponse(verify: NormalizedVerify): boolean {
  return new RegExp(RESPONSE_REF.source).test(verify.url) || verify.match.some((check) => "equalsResponse" in check) ||
    Object.values(verify.graphql?.variables ?? {}).some((v) => "response" in v);
}

export function resolveVerifyBody(verify: NormalizedVerify, response: unknown): { query: string; variables: Record<string, JsonScalar> } | null {
  if (!verify.graphql) return null;
  const variables: Record<string, JsonScalar> = {};
  for (const [name, variable] of Object.entries(verify.graphql.variables)) {
    if ("value" in variable) { variables[name] = variable.value; continue; }
    const value = readPath(response, variable.response);
    if (typeof value !== "string" && typeof value !== "number") return null;
    variables[name] = value;
  }
  return { query: verify.graphql.query, variables };
}

export function resolveVerifyUrl(verify: NormalizedVerify, response: unknown): string | null {
  let missing = false;
  const url = verify.url.replace(RESPONSE_REF, (_m, path: string) => {
    const value = readPath(response, path);
    if (typeof value !== "string" && typeof value !== "number") {
      missing = true;
      return "";
    }
    return encodeURIComponent(String(value));
  });
  return missing ? null : url;
}

export function verifyMismatches(
  verify: NormalizedVerify, readBack: { status: number; json: unknown }, response: unknown,
): string[] {
  if (readBack.status !== verify.status) return [`status ${readBack.status}, expected ${verify.status}`];
  const mismatches: string[] = [];
  for (const check of verify.match) {
    const expected = "equalsResponse" in check ? readPath(response, check.equalsResponse) : check.equals;
    const found = expected !== undefined && readPathAll(readBack.json, check.path).some((value) => value === expected);
    if (expected === undefined || found === (check.absent === true)) mismatches.push(check.path);
  }
  return mismatches;
}

export function parseDeclarations(
  raw: { governed?: boolean | null; impact?: unknown; verify?: unknown },
  urlTemplate: string,
): ActionDeclarations | null {
  const impact = raw.impact === undefined || raw.impact === null ? null : parseImpactDeclaration(raw.impact);
  const verify = raw.verify === undefined || raw.verify === null ? null : parseVerifyDeclaration(raw.verify);
  if (!impact && !verify && raw.governed !== true) return null;
  if (raw.governed === false) {
    throw new ValidationError("An action that declares impact or verify is governed. Remove both to set governed to false.");
  }
  const { host } = declaredHost(urlTemplate);
  if (verify && declaredHost(verify.url).host !== host) {
    throw new ValidationError(`verify.url must be on the action's own host, ${host}.`);
  }
  return { impact, verify };
}
