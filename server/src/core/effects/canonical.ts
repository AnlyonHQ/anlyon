import { createHash } from "node:crypto";

export class CanonicalizationError extends Error {
  constructor(path: string, reason: string) {
    super(`Cannot canonicalize ${path || "value"}: ${reason}`);
    this.name = "CanonicalizationError";
  }
}

export function canonicalJson(value: unknown): string {
  return encode(value, "");
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalizationError(path, "non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (value instanceof Date) return JSON.stringify(value.toISOString());
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => {
          if (item === undefined) throw new CanonicalizationError(`${path}[${index}]`, "undefined in array");
          return encode(item, `${path}[${index}]`);
        }).join(",")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${encode(v, path ? `${path}.${k}` : k)}`).join(",")}}`;
    }
    default:
      throw new CanonicalizationError(path, `unsupported type ${typeof value}`);
  }
}

export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
