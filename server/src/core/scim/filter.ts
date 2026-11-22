import { ScimError } from "./protocol.ts";

export interface EqFilter {
  attribute: string;
  value: string;
}

const EQ = /^\s*([A-Za-z][A-Za-z0-9.:_-]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i;

export function parseEqFilter(filter: string | undefined, allowed: readonly string[]): EqFilter | null {
  if (filter === undefined || filter.trim() === "") return null;
  const match = EQ.exec(filter);
  if (!match) {
    throw new ScimError(400, `Unsupported filter. Use: <attribute> eq "<value>" with one of ${allowed.join(", ")}`, "invalidFilter");
  }
  const raw = match[1].replace(/^urn:ietf:params:scim:schemas:core:2\.0:(User|Group):/i, "");
  const attribute = allowed.find((name) => name.toLowerCase() === raw.toLowerCase());
  if (!attribute) {
    throw new ScimError(400, `Filtering on "${match[1]}" is not supported. Use one of ${allowed.join(", ")}`, "invalidFilter");
  }
  return { attribute, value: match[2].replace(/\\(.)/g, "$1") };
}
