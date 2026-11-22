import { z } from "zod";

type Issue = { code: string; input?: unknown; path?: PropertyKey[]; message?: string } & Record<string, unknown>;

function legacyTypeName(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (value instanceof Map) return "map";
  if (value instanceof Set) return "set";
  if (value instanceof Promise) return "promise";
  if (typeof value === "number") return Number.isNaN(value) ? "nan" : "number";
  return typeof value;
}

const quoteList = (values: unknown[]) => values.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(" | ");

function sizeMessage(issue: Issue, small: boolean): string | undefined {
  const bound = small ? issue.minimum : issue.maximum;
  const exact = issue.exact === true;
  const inclusive = issue.inclusive !== false;
  switch (issue.origin) {
    case "string":
      return `String must contain ${exact ? "exactly" : inclusive ? (small ? "at least" : "at most") : small ? "over" : "under"} ${bound} character(s)`;
    case "array":
    case "set":
      return `Array must contain ${exact ? "exactly" : inclusive ? (small ? "at least" : "at most") : small ? "more than" : "less than"} ${bound} element(s)`;
    case "number":
    case "int":
    case "bigint":
      return `Number must be ${exact ? "exactly equal to " : small ? (inclusive ? "greater than or equal to " : "greater than ") : inclusive ? "less than or equal to " : "less than "}${bound}`;
    case "date":
      return `Date must be ${exact ? "exactly equal to " : small ? (inclusive ? "greater than or equal to " : "greater than ") : inclusive ? "smaller than or equal to " : "smaller than "}${new Date(Number(bound))}`;
    default:
      return "Invalid input";
  }
}

const FORMAT_NAMES: Record<string, string> = { guid: "uuid", uuid: "uuid", email: "email", url: "url", datetime: "datetime", date: "date", time: "time" };

export function legacyZodMessage(issue: Issue): string | undefined {
  switch (issue.code) {
    case "invalid_type":
      if (issue.input === undefined) return "Required";
      return `Expected ${issue.expected === "record" ? "object" : issue.expected}, received ${legacyTypeName(issue.input)}`;
    case "invalid_value": {
      const values = (issue.values as unknown[]) ?? [];
      if (issue.input === undefined) return "Required";
      if (values.length === 1) return `Invalid literal value, expected ${JSON.stringify(values[0])}`;
      if (values.every((v) => typeof v === "string") && typeof issue.input !== "string") {
        return `Expected ${quoteList(values)}, received ${legacyTypeName(issue.input)}`;
      }
      return `Invalid enum value. Expected ${quoteList(values)}, received '${String(issue.input)}'`;
    }
    case "invalid_format":
      switch (issue.format) {
        case "regex":
          return "Invalid";
        case "starts_with":
          return `Invalid input: must start with "${issue.prefix}"`;
        case "ends_with":
          return `Invalid input: must end with "${issue.suffix}"`;
        case "includes":
          return `Invalid input: must include "${issue.includes}"`;
        default:
          return `Invalid ${FORMAT_NAMES[String(issue.format)] ?? String(issue.format)}`;
      }
    case "too_small":
      return sizeMessage(issue, true);
    case "too_big":
      return sizeMessage(issue, false);
    case "not_multiple_of":
      return `Number must be a multiple of ${issue.divisor}`;
    case "unrecognized_keys":
      return `Unrecognized key(s) in object: ${((issue.keys as string[]) ?? []).map((k) => `'${k}'`).join(", ")}`;
    case "invalid_union":
      return issue.discriminator !== undefined ? undefined : "Invalid input";
    case "invalid_key":
    case "invalid_element":
    case "custom":
      return "Invalid input";
    default:
      return undefined;
  }
}

export function legacyZodIssues(issues: readonly z.core.$ZodIssue[]): Array<Record<string, unknown>> {
  return issues.map((zodIssue) => {
    const issue = zodIssue as unknown as Issue;
    const { input: _input, inst: _inst, ...rest } = issue as Issue & { inst?: unknown };
    switch (issue.code) {
      case "invalid_format":
        return { ...rest, code: "invalid_string", validation: issue.format === "guid" ? "uuid" : issue.format };
      case "invalid_value":
        return { ...rest, code: ((issue.values as unknown[]) ?? []).length === 1 ? "invalid_literal" : "invalid_enum_value" };
      case "invalid_union":
        return issue.discriminator !== undefined ? { ...rest, code: "invalid_union_discriminator" } : rest;
      default:
        return rest;
    }
  });
}

const DATE = String.raw`((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))`;
const TIME = String.raw`([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?`;
const DATETIME = new RegExp(`^${DATE}T${TIME}(Z)$`);
const DATETIME_WITH_OFFSET = new RegExp(`^${DATE}T${TIME}(Z|([+-]\\d{2}:?\\d{2}))$`);

export function legacyDatetime(options: { offset?: boolean } = {}) {
  return z.string().regex(options.offset ? DATETIME_WITH_OFFSET : DATETIME, { error: "Invalid datetime" });
}

z.config({ customError: (issue) => legacyZodMessage(issue as unknown as Issue) });
