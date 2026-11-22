import { redactValues } from "../../utils/redaction.ts";
import { ValidationError } from "../../utils/errors.ts";
import { ACCOUNT_HOST_PLACEHOLDER, isBareHostname } from "../connections/catalogue.ts";

export const SECRET_REF = /\{\{\s*(?:secret:)?((?<=secret:)[A-Z0-9_]+|(?<!secret:)connection:[a-z][a-z0-9-]{0,63})\s*\}\}/g;

const CONNECTION_PREFIX = "connection:";

export function isConnectionRef(name: string): boolean {
  return name.startsWith(CONNECTION_PREFIX);
}

export function connectionRefIntegration(name: string): string {
  return name.slice(CONNECTION_PREFIX.length);
}

export function secretRefText(name: string): string {
  return isConnectionRef(name) ? `{{${name}}}` : `{{secret:${name}}}`;
}
export const ACCOUNT_HOST_REF = /\{\{\s*connection\.host\s*\}\}/;
const ACCOUNT_HOST_AUTHORITY = /^https:\/\/\{\{\s*connection\.host\s*\}\}(?=[/?#]|$)/;

export function usesAccountHost(urlTemplate: string): boolean {
  const count = (urlTemplate.match(new RegExp(ACCOUNT_HOST_REF.source, "g")) ?? []).length;
  if (count === 0) return false;
  if (count > 1 || !ACCOUNT_HOST_AUTHORITY.test(urlTemplate.trim())) {
    throw new ValidationError(`${ACCOUNT_HOST_PLACEHOLDER} may only be the whole host of an https URL, written once.`);
  }
  return true;
}

export function assertAccountHostOnlyInUrl(...templates: unknown[]): void {
  for (const template of templates) {
    if (template === undefined || template === null) continue;
    const text = typeof template === "string" ? template : JSON.stringify(template);
    if (ACCOUNT_HOST_REF.test(text)) throw new ValidationError(`${ACCOUNT_HOST_PLACEHOLDER} may only be the host of the URL.`);
  }
}

export function applyAccountHost(template: string, host: string | null | undefined): string {
  if (!usesAccountHost(template) || host === undefined) return template;
  if (host === null || !isBareHostname(host)) {
    throw new ValidationError(`${ACCOUNT_HOST_PLACEHOLDER} needs a connected account with its own host in the same action. Nothing was sent.`);
  }
  return template.trim().replace(ACCOUNT_HOST_AUTHORITY, `https://${host}`);
}

export const INPUT_REF = /\{\{\s*input\.([a-zA-Z0-9_.]+)(?::(path))?\s*\}\}/g;
export const PATH_INPUT_REF = /\{\{\s*input\.[a-zA-Z0-9_.]+:path\s*\}\}/g;

export function extractSecretNames(...templates: unknown[]): string[] {
  const names = new Set<string>();
  for (const template of templates) {
    if (template === undefined || template === null) continue;
    const text = typeof template === "string" ? template : JSON.stringify(template);
    for (const match of text.matchAll(SECRET_REF)) {
      names.add(match[1]);
    }
  }
  return [...names];
}

export type SecretPlacement = "url" | "header" | "body";

export function secretPlacements(
  urlTemplate: string,
  headers: Record<string, unknown> | null | undefined,
  bodyTemplate: Record<string, unknown> | null | undefined,
): Map<string, Set<SecretPlacement>> {
  const found = new Map<string, Set<SecretPlacement>>();

  const scan = (template: unknown, placement: SecretPlacement) => {
    if (template === undefined || template === null) return;
    const text = typeof template === "string" ? template : JSON.stringify(template);
    for (const match of text.matchAll(SECRET_REF)) {
      const set = found.get(match[1]) ?? new Set<SecretPlacement>();
      set.add(placement);
      found.set(match[1], set);
    }
  };

  scan(urlTemplate, "url");
  scan(headers ?? null, "header");
  scan(bodyTemplate ?? null, "body");
  return found;
}

export function extractInputRefs(...templates: unknown[]): string[] {
  const refs = new Set<string>();
  for (const template of templates) {
    if (template === undefined || template === null) continue;
    const text = typeof template === "string" ? template : JSON.stringify(template);
    for (const match of text.matchAll(INPUT_REF)) {
      refs.add(match[1]);
    }
  }
  return [...refs];
}

export function urlTemplateAuthority(template: string): string {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(template.trim());
  return match ? match[1] : "";
}

export function hasInputRef(text: string): boolean {
  return new RegExp(INPUT_REF.source).test(text);
}

export function hasSecretRef(text: string): boolean {
  return new RegExp(SECRET_REF.source).test(text);
}

function lookup(input: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && !Array.isArray(acc)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, input);
}

const INPUT_QUERY_PAIR = /^[^=&#{}]+=\{\{\s*input\.([a-zA-Z0-9_.]+)\s*\}\}$/;

function dropAbsentQueryInputs(template: string, input: Record<string, unknown>): string {
  const start = template.indexOf("?");
  if (start === -1) return template;
  const hash = template.indexOf("#", start);
  const end = hash === -1 ? template.length : hash;
  const pairs = template.slice(start + 1, end).split("&");
  const kept = pairs.filter((pair) => {
    const ref = INPUT_QUERY_PAIR.exec(pair);
    if (!ref) return true;
    const value = lookup(input, ref[1]);
    return !(value === undefined || value === null || value === "");
  });
  if (kept.length === pairs.length) return template;
  return template.slice(0, kept.length > 0 ? start + 1 : start) + kept.join("&") + template.slice(end);
}

const ANY_REF = new RegExp(`${INPUT_REF.source}|${SECRET_REF.source}`, "g");

function renderInput(input: Record<string, unknown>, path: string): string {
  const value = lookup(input, path);
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
}

function render(
  template: string,
  input: Record<string, unknown>,
  onSecret: (name: string) => string,
  mode: "text" | "url" = "text"
): string {
  if (mode === "url") template = dropAbsentQueryInputs(template, input);
  const authorityEnd = mode === "url" ? (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/.exec(template)?.[0].length ?? 0) : 0;
  return template.replace(
    ANY_REF,
    (_m, inputPath: string | undefined, modifier: string | undefined, secretName: string | undefined, offset: number) => {
      if (inputPath === undefined) return onSecret(secretName as string);
      const value = renderInput(input, inputPath);
      if (mode === "text") return value;
      if (offset < authorityEnd) return checkHostInput(inputPath, value);
      return modifier === "path" ? encodePathInput(inputPath, value) : encodeURIComponent(value);
    }
  );
}

function checkHostInput(inputPath: string, value: string): string {
  if (!/^[A-Za-z0-9.-]*(:\d{1,5})?$/.test(value)) {
    throw new ValidationError(`Input "${inputPath}" is not a valid host: only letters, digits, "." and "-", with an optional ":port".`);
  }
  return value;
}

function encodePathInput(inputPath: string, value: string): string {
  if (value === "") return "";
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new ValidationError(
        `Input "${inputPath}" is not a safe path: empty, "." and ".." segments are not allowed.`
      );
    }
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

export function interpolate(
  template: string,
  input: Record<string, unknown>,
  secrets: Map<string, string>
): string {
  return render(template, input, (name) => {
    const value = secrets.get(name);
    if (value === undefined) {
      throw new Error(`Secret ${name} was not resolved`);
    }
    return value;
  });
}

export function interpolateInputsOnly(
  template: string,
  input: Record<string, unknown>
): string {
  return render(template, input, secretRefText);
}

export function interpolateWithStubbedSecrets(
  template: string,
  input: Record<string, unknown>
): string {
  return render(template, input, () => "secret-placeholder");
}

export function interpolateUrl(
  template: string,
  input: Record<string, unknown>,
  secrets: Map<string, string>,
  accountHost: string | null = null,
): string {
  return render(applyAccountHost(template, accountHost), input, (name) => {
    const value = secrets.get(name);
    if (value === undefined) {
      throw new Error(`Secret ${name} was not resolved`);
    }
    return value;
  }, "url");
}

export function interpolateKeepingSecretRefs(
  template: string,
  input: Record<string, unknown>,
  mode: "text" | "url" = "text"
): string {
  if (hasSecretRef(render(template, input, () => "", mode))) {
    throw new ValidationError("An input may not contain a secret reference.");
  }
  return render(template, input, secretRefText, mode);
}

function spellsSecretRef(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return hasSecretRef(value);
  if (value === null || typeof value !== "object") return false;
  if (depth > 64) return true;
  if (Array.isArray(value)) return value.some((item) => spellsSecretRef(item, depth + 1));
  return Object.entries(value).some(([key, item]) => hasSecretRef(key) || spellsSecretRef(item, depth + 1));
}

export function assertNoSecretRef(value: unknown): void {
  if (value === undefined) return;
  if (spellsSecretRef(value) || (typeof value !== "string" && hasSecretRef(JSON.stringify(value) ?? ""))) {
    throw new ValidationError("An input may not contain a secret reference.");
  }
}

export function interpolateUrlWithStubbedSecrets(
  template: string,
  input: Record<string, unknown>,
  accountHost: string | null = null,
): string {
  return render(applyAccountHost(template, accountHost), input, () => "secret-placeholder", "url");
}

export function stubSecrets(template: string): string {
  return template.replace(SECRET_REF, "secret-placeholder");
}

const WHOLE_INPUT_REF = /^\{\{\s*input\.([a-zA-Z0-9_.]+)\s*\}\}$/;

export interface InterpolateObjectOptions {
  typed?: boolean;
  keepSecretRefs?: boolean;
}

const ABSENT = Symbol("absent");

function interpolateValue(
  value: unknown,
  input: Record<string, unknown>,
  secrets: Map<string, string>,
  options: InterpolateObjectOptions,
): unknown {
  if (typeof value === "string") {
    const whole = options.typed ? WHOLE_INPUT_REF.exec(value) : null;
    if (whole) {
      const resolved = lookup(input, whole[1]);
      if (options.keepSecretRefs) assertNoSecretRef(resolved);
      return resolved === undefined ? ABSENT : resolved;
    }
    return options.keepSecretRefs
      ? interpolateKeepingSecretRefs(value, input)
      : interpolate(value, input, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, input, secrets, options)).filter((item) => item !== ABSENT);
  }
  if (value && typeof value === "object") {
    return interpolateObject(value as Record<string, unknown>, input, secrets, options);
  }
  return value;
}

export function interpolateObject(
  template: Record<string, unknown>,
  input: Record<string, unknown>,
  secrets: Map<string, string>,
  options: InterpolateObjectOptions = {}
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(template)) {
    const resolved = interpolateValue(value, input, secrets, options);
    if (resolved !== ABSENT) out[key] = resolved;
  }

  return out;
}

export function redactSecrets(text: string, secrets: Map<string, string>): string {
  return redactValues(text, secrets.values());
}
