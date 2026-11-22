import { describe, expect, it } from "vitest";
import {
  assessMcpSchema,
  LOOSE_REASONS,
  MAX_IN_PLACE,
  MAX_LOOSE_ARGUMENT_BYTES,
  MAX_MCP_VISITS,
  MAX_REFS,
  MAX_SCHEMA_BYTES,
  MAX_SCHEMA_DEPTH,
  MAX_SUBSCHEMAS,
  unicodePattern,
  validateMcpArguments,
} from "../src/utils/mcp-json-schema.ts";
import { MAX_PATTERN_LENGTH, MAX_PATTERN_SUBJECT_LENGTH } from "../src/utils/json-schema.ts";

const full = (schema: unknown) => expect(assessMcpSchema(schema)).toEqual({ check: "full", reason: null, detail: null });
const loose = (schema: unknown, reason: (typeof LOOSE_REASONS)[number]) => expect(assessMcpSchema(schema)).toMatchObject({ check: "loose", reason });
const ok = (schema: unknown, value: unknown) => validateMcpArguments(schema, value, "full").valid;
const errors = (schema: unknown, value: unknown) => validateMcpArguments(schema, value, "full").errors.join(" | ");

describe("real servers' schemas are checked in full", () => {
  const ZOD = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      repo: { $ref: "#/definitions/repo" },
      labels: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
      state: { type: "string", enum: ["open", "closed"], default: "open" },
      assignee: { anyOf: [{ $ref: "#/definitions/login" }, { type: "null" }] },
    },
    required: ["repo"],
    additionalProperties: false,
    definitions: {
      login: { type: "string", pattern: "^[A-Za-z0-9-]{1,39}$" },
      repo: { type: "object", properties: { owner: { $ref: "#/definitions/login" }, name: { type: "string" } }, required: ["owner", "name"], additionalProperties: false },
    },
  };
  const PYDANTIC = {
    title: "create_eventArguments",
    type: "object",
    properties: {
      title: { title: "Title", type: "string" },
      starts_at: { title: "Starts At", type: "string", format: "date-time" },
      attendees: { title: "Attendees", type: "array", items: { $ref: "#/$defs/Attendee" }, maxItems: 50 },
      reminder_minutes: { anyOf: [{ type: "integer", minimum: 0, multipleOf: 5 }, { type: "null" }], default: null, title: "Reminder Minutes" },
    },
    required: ["title", "starts_at"],
    $defs: {
      Attendee: {
        title: "Attendee",
        type: "object",
        properties: { email: { type: "string", format: "email" }, optional: { type: "boolean", default: false } },
        required: ["email"],
      },
    },
  };

  it("checks a zod-to-json-schema (draft-07) tool in full and enforces it", () => {
    full(ZOD);
    expect(ok(ZOD, { repo: { owner: "anlyon", name: "platform" }, labels: ["bug"], assignee: null })).toBe(true);
    expect(ok(ZOD, { repo: { owner: "bad owner!", name: "platform" } })).toBe(false);
    expect(ok(ZOD, { repo: { owner: "a", name: "p" }, labels: ["x", "x"] })).toBe(false);
    expect(ok(ZOD, { repo: { owner: "a", name: "p" }, extra: 1 })).toBe(false);
    expect(ok(ZOD, { repo: { owner: "a", name: "p" }, assignee: 4 })).toBe(false);
  });

  it("checks a Pydantic (2020-12) tool in full and enforces it", () => {
    full(PYDANTIC);
    expect(ok(PYDANTIC, { title: "Kickoff", starts_at: "2026-11-06T09:00:00Z", attendees: [{ email: "a@example.com" }], reminder_minutes: 10 })).toBe(true);
    expect(ok(PYDANTIC, { title: "Kickoff", starts_at: "tomorrow" })).toBe(false);
    expect(ok(PYDANTIC, { title: "Kickoff", starts_at: "2026-11-06T09:00:00Z", reminder_minutes: 7 })).toBe(false);
    expect(ok(PYDANTIC, { title: "Kickoff", starts_at: "2026-11-06T09:00:00Z", attendees: [{ email: "not an email" }] })).toBe(false);
  });

  it("names where an argument failed", () => {
    expect(errors(PYDANTIC, { title: "K", starts_at: "2026-11-06T09:00:00Z", attendees: [{ email: "x" }] })).toContain("input.attendees[0].email");
    expect(errors(ZOD, { labels: [] })).toContain('required property "repo"');
  });
});

describe("each keyword family", () => {
  it("$ref by JSON pointer, with escaped names, into $defs and definitions", () => {
    const schema = {
      $defs: { "a/b": { type: "string" }, "c~d": { type: "integer" }, "e f": { type: "boolean" } },
      definitions: { old: { type: "null" } },
      type: "object",
      properties: {
        slash: { $ref: "#/$defs/a~1b" }, tilde: { $ref: "#/$defs/c~0d" }, space: { $ref: "#/$defs/e%20f" }, old: { $ref: "#/definitions/old" },
        sibling: { $ref: "#/properties/slash" },
      },
    };
    full(schema);
    expect(ok(schema, { slash: "x", tilde: 1, space: true, old: null, sibling: "y" })).toBe(true);
    expect(ok(schema, { slash: 1 })).toBe(false);
    expect(ok(schema, { tilde: "x" })).toBe(false);
    expect(ok(schema, { space: "x" })).toBe(false);
    expect(ok(schema, { sibling: 2 })).toBe(false);
  });

  it("$ref by anchor: $anchor in 2020-12 and a plain-name $id in draft-07", () => {
    const modern = { $defs: { id: { $anchor: "userId", type: "string", pattern: "^u_" } }, properties: { user: { $ref: "#userId" } } };
    full(modern);
    expect(ok(modern, { user: "u_1" })).toBe(true);
    expect(ok(modern, { user: "x" })).toBe(false);
    const draft7 = { $schema: "http://json-schema.org/draft-07/schema#", definitions: { id: { $id: "#userId", type: "string" } }, properties: { user: { $ref: "#userId" } } };
    full(draft7);
    expect(ok(draft7, { user: 1 })).toBe(false);
  });

  it("a recursive schema through properties and items: an ordinary tree, bounded by the value", () => {
    const tree = { type: "object", required: ["name"], properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#" } } } };
    full(tree);
    expect(ok(tree, { name: "a", children: [{ name: "b", children: [{ name: "c" }] }] })).toBe(true);
    expect(errors(tree, { name: "a", children: [{ name: "b", children: [{ name: 3 }] }] })).toContain("input.children[0].children[0].name");
  });

  it("anyOf, oneOf, allOf and not", () => {
    const schema = {
      type: "object",
      properties: {
        any: { anyOf: [{ type: "string" }, { type: "number" }] },
        one: { oneOf: [{ type: "integer" }, { type: "number", maximum: 1 }] },
        all: { allOf: [{ type: "string" }, { minLength: 2 }, { maxLength: 3 }] },
        none: { not: { const: "forbidden" } },
      },
    };
    full(schema);
    expect(ok(schema, { any: "x", one: 5, all: "ab", none: "fine" })).toBe(true);
    expect(ok(schema, { any: true })).toBe(false);
    expect(ok(schema, { one: 1 })).toBe(false);
    expect(ok(schema, { one: 0.5 })).toBe(true);
    expect(ok(schema, { all: "abcd" })).toBe(false);
    expect(ok(schema, { none: "forbidden" })).toBe(false);
  });

  it("if, then and else", () => {
    const schema = {
      type: "object",
      if: { properties: { kind: { const: "email" } }, required: ["kind"] },
      then: { required: ["to"] },
      else: { required: ["phone"] },
    };
    full(schema);
    expect(ok(schema, { kind: "email", to: "a@example.com" })).toBe(true);
    expect(ok(schema, { kind: "email" })).toBe(false);
    expect(ok(schema, { kind: "sms", phone: "1" })).toBe(true);
    expect(ok(schema, { kind: "sms" })).toBe(false);
  });

  it("const and enum of any JSON values, compared deeply", () => {
    const schema = { properties: { c: { const: { a: [1, { b: null }] } }, e: { enum: [null, 1, "x", [1, 2], { k: true }] } } };
    full(schema);
    expect(ok(schema, { c: { a: [1, { b: null }] } })).toBe(true);
    expect(ok(schema, { c: { a: [1, { b: 0 }] } })).toBe(false);
    for (const value of [null, 1, "x", [1, 2], { k: true }]) expect(ok(schema, { e: value })).toBe(true);
    expect(ok(schema, { e: [2, 1] })).toBe(false);
    expect(ok(schema, { e: { k: false } })).toBe(false);
  });

  it("type lists and integers", () => {
    const schema = { properties: { n: { type: ["integer", "null"] }, s: { type: ["string", "array"] } } };
    full(schema);
    expect(ok(schema, { n: 3, s: [] })).toBe(true);
    expect(ok(schema, { n: 3.5 })).toBe(false);
    expect(ok(schema, { n: 2.0 })).toBe(true);
    expect(ok(schema, { s: 1 })).toBe(false);
  });

  it("prefixItems, items, contains, minContains and maxContains", () => {
    const schema = {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: { type: "boolean" },
      contains: { const: true },
      minContains: 1,
      maxContains: 2,
    };
    full(schema);
    expect(ok(schema, ["a", 1, true])).toBe(true);
    expect(ok(schema, ["a", 1, true, true, true])).toBe(false);
    expect(ok(schema, ["a", 1, false])).toBe(false);
    expect(ok(schema, [1, 1, true])).toBe(false);
    expect(ok(schema, ["a", 1, "x"])).toBe(false);
  });

  it("draft-07's list form of items, with additionalItems", () => {
    const schema = { $schema: "http://json-schema.org/draft-07/schema#", type: "array", items: [{ type: "string" }], additionalItems: { type: "number" } };
    full(schema);
    expect(ok(schema, ["a", 1, 2])).toBe(true);
    expect(ok(schema, ["a", "b"])).toBe(false);
  });

  it("patternProperties, additionalProperties and propertyNames", () => {
    const schema = {
      type: "object",
      properties: { id: { type: "string" } },
      patternProperties: { "^x-": { type: "string" }, "^n_\\d+$": { type: "number" } },
      additionalProperties: false,
      propertyNames: { maxLength: 10 },
    };
    full(schema);
    expect(ok(schema, { id: "1", "x-trace": "t", n_1: 2 })).toBe(true);
    expect(ok(schema, { "x-trace": 1 })).toBe(false);
    expect(ok(schema, { n_1: "two" })).toBe(false);
    expect(ok(schema, { other: 1 })).toBe(false);
    expect(ok(schema, { "x-far-too-long": "t" })).toBe(false);
  });

  it("dependentRequired, dependentSchemas, and draft-07 dependencies", () => {
    const modern = {
      type: "object",
      dependentRequired: { card: ["cvc"] },
      dependentSchemas: { refund: { required: ["reason"] } },
    };
    full(modern);
    expect(ok(modern, { card: "4242", cvc: "1" })).toBe(true);
    expect(ok(modern, { card: "4242" })).toBe(false);
    expect(ok(modern, { refund: true })).toBe(false);
    const draft7 = { $schema: "http://json-schema.org/draft-07/schema#", dependencies: { card: ["cvc"], refund: { required: ["reason"] } } };
    full(draft7);
    expect(ok(draft7, { card: "4242" })).toBe(false);
    expect(ok(draft7, { refund: true, reason: "x" })).toBe(true);
    expect(ok(draft7, { refund: true })).toBe(false);
  });

  it("unevaluatedProperties and unevaluatedItems see through allOf", () => {
    const props = { allOf: [{ properties: { a: { type: "string" } } }, { properties: { b: { type: "number" } } }], unevaluatedProperties: false };
    full(props);
    expect(ok(props, { a: "x", b: 1 })).toBe(true);
    expect(ok(props, { a: "x", c: 1 })).toBe(false);
    const items = { allOf: [{ prefixItems: [{ type: "string" }] }], unevaluatedItems: false };
    full(items);
    expect(ok(items, ["a"])).toBe(true);
    expect(ok(items, ["a", "b"])).toBe(false);
  });

  it("numeric, string, array and object bounds, uniqueItems and multipleOf", () => {
    const schema = {
      type: "object",
      minProperties: 1,
      maxProperties: 4,
      properties: {
        n: { type: "number", minimum: 1, maximum: 10, exclusiveMaximum: 10, multipleOf: 0.5 },
        x: { type: "number", exclusiveMinimum: 0 },
        s: { type: "string", minLength: 2, maxLength: 3 },
        a: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true },
      },
    };
    full(schema);
    expect(ok(schema, { n: 9.5, x: 0.1, s: "ab", a: [1, 2] })).toBe(true);
    expect(ok(schema, {})).toBe(false);
    expect(ok(schema, { n: 10 })).toBe(false);
    expect(ok(schema, { n: 0.5 })).toBe(false);
    expect(ok(schema, { n: 1.25 })).toBe(false);
    expect(ok(schema, { x: 0 })).toBe(false);
    expect(ok(schema, { s: "a" })).toBe(false);
    expect(ok(schema, { s: "abcd" })).toBe(false);
    expect(ok(schema, { a: [] })).toBe(false);
    expect(ok(schema, { a: [1, 1] })).toBe(false);
    expect(ok(schema, { a: [{ k: 1 }, { k: 1 }] })).toBe(false);
    expect(ok(schema, { a: [1, 2, 3] })).toBe(false);
    expect(ok({ type: "string", maxLength: 1 }, "😀")).toBe(true);
    expect(ok({ multipleOf: 0.01 }, 0.07)).toBe(true);
  });

  it("ignores annotations and unknown keywords, as the spec says", () => {
    const schema = {
      type: "object",
      title: "T",
      description: "D",
      $comment: "c",
      properties: {
        a: { type: "string", default: 5, examples: [1], readOnly: true, writeOnly: true, deprecated: true, "x-vendor": { type: "number" }, contentMediaType: "text/plain", made_up: { minimum: 3 } },
      },
    };
    full(schema);
    expect(ok(schema, { a: "x" })).toBe(true);
  });

  it("an unknown format is an annotation; the formats Anlyon checks stay enforced", () => {
    full({ type: "string", format: "hostname" });
    expect(ok({ type: "string", format: "hostname" }, "not a hostname!")).toBe(true);
    expect(ok({ type: "string", format: "made-up" }, "anything")).toBe(true);
    expect(ok({ type: "string", format: "uuid" }, "nope")).toBe(false);
  });
});

describe("drafts", () => {
  it("defaults to 2020-12 and reads 2019-09, 07 and 04 from $schema", () => {
    full({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" });
    full({ $schema: "https://json-schema.org/draft/2019-09/schema", type: "string" });
    full({ $schema: "http://json-schema.org/draft-07/schema#", type: "string" });
    full({ $schema: "http://json-schema.org/draft-04/schema#", type: "number", minimum: 1, exclusiveMinimum: true });
    expect(ok({ $schema: "http://json-schema.org/draft-04/schema#", minimum: 1, exclusiveMinimum: true }, 1)).toBe(false);
  });

  it("draft-07 ignores a $ref's siblings; 2020-12 applies them", () => {
    const shape = { definitions: { n: { type: "integer" } }, properties: { a: { $ref: "#/definitions/n", minimum: 5 } } };
    expect(ok({ $schema: "http://json-schema.org/draft-07/schema#", ...shape }, { a: 1 })).toBe(true);
    expect(ok(shape, { a: 1 })).toBe(false);
  });

  it("a list for items in 2020-12, an unknown $schema and a non-string $schema are loose", () => {
    loose({ type: "array", items: [{ type: "string" }] }, "invalid_schema");
    loose({ $schema: "https://example.com/my-dialect", type: "string" }, "unknown_dialect");
    loose({ $schema: 7, type: "string" }, "invalid_schema");
  });
});

describe("loosely checked, never refused", () => {
  it("a remote $ref, a relative one against an $id, and the meta-schema", () => {
    loose({ $ref: "https://example.com/schemas/user.json" }, "remote_ref");
    loose({ $id: "https://example.com/tool.json", properties: { a: { $ref: "other.json#/x" } } }, "remote_ref");
    loose({ properties: { a: { $ref: "https://json-schema.org/draft/2020-12/schema" } } }, "remote_ref");
    loose({ properties: { a: { $ref: "file:///etc/passwd" } } }, "remote_ref");
    full({ $id: "https://example.com/tool.json", $defs: { a: { type: "string" } }, properties: { a: { $ref: "#/$defs/a" } } });
  });

  it("a $ref that loops without moving into the value", () => {
    loose({ $ref: "#" }, "ref_cycle");
    loose({ $defs: { a: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" }, "ref_cycle");
    loose({ $defs: { a: { anyOf: [{ $ref: "#/$defs/b" }] }, b: { allOf: [{ not: { $ref: "#/$defs/a" } }] } }, properties: { x: { $ref: "#/$defs/a" } } }, "ref_cycle");
    loose({ $defs: { a: { if: true, then: { $ref: "#/$defs/a" } } } }, "ref_cycle");
  });

  it("branches that multiply through references", () => {
    const defs: Record<string, unknown> = { d30: { type: "string" } };
    for (let i = 0; i < 30; i++) defs[`d${i}`] = { anyOf: [{ $ref: `#/$defs/d${i + 1}` }, { $ref: `#/$defs/d${i + 1}` }] };
    loose({ $defs: defs, $ref: "#/$defs/d0" }, "too_large");
    expect(MAX_IN_PLACE).toBe(10_000);
  });

  it("a schema past a size limit", () => {
    loose({ description: "x".repeat(MAX_SCHEMA_BYTES) }, "too_large");
    let deep: unknown = { type: "string" };
    for (let i = 0; i < MAX_SCHEMA_DEPTH; i++) deep = { properties: { a: deep } };
    loose(deep, "too_large");
    loose({ properties: Object.fromEntries(Array.from({ length: MAX_SUBSCHEMAS + 1 }, (_, i) => [`p${i}`, {}])) }, "too_large");
    loose({ $defs: { a: {} }, properties: Object.fromEntries(Array.from({ length: MAX_REFS + 1 }, (_, i) => [`p${i}`, { $ref: "#/$defs/a" }])) }, "too_large");
  });

  it("a hostile or overlong pattern, in pattern or as a patternProperties key", () => {
    loose({ type: "string", pattern: "(a+)+$" }, "unsafe_pattern");
    loose({ type: "string", pattern: "^(a|a)*$" }, "unsafe_pattern");
    loose({ type: "string", pattern: "(x)\\1" }, "unsafe_pattern");
    loose({ type: "object", patternProperties: { "^(.*)*$": { type: "string" } } }, "unsafe_pattern");
    loose({ type: "string", pattern: "a".repeat(MAX_PATTERN_LENGTH + 1) }, "unsafe_pattern");
    loose({ type: "string", pattern: "([a-z" }, "invalid_schema");
  });

  it("a schema invalid by the standard", () => {
    for (const schema of [
      { type: "object", required: "a" },
      { minLength: -1 },
      { minLength: 1.5 },
      { maximum: "10" },
      { multipleOf: 0 },
      { uniqueItems: "yes" },
      { properties: [] },
      { properties: { a: 5 } },
      { allOf: [] },
      { exclusiveMinimum: true },
      { dependentRequired: { a: "b" } },
      { format: 4 },
      { $ref: 4 },
      ["not", "a", "schema"],
      "a string",
      42,
      null,
    ]) {
      loose(schema, "invalid_schema");
    }
  });

  it("$dynamicRef and $recursiveRef, which Anlyon does not check", () => {
    loose({ $dynamicAnchor: "node", properties: { a: { $dynamicRef: "#node" } } }, "unsupported_keyword");
    loose({ $recursiveAnchor: true, properties: { a: { $recursiveRef: "#" } } }, "unsupported_keyword");
  });

  it("never throws, whatever the schema", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const schema of [undefined, null, 1n, cyclic, () => 1, Symbol("s"), { $id: "http://[bad" }, { $id: "#a", $defs: { b: { $id: "#a" } } }, { $anchor: 5 }]) {
      expect(() => assessMcpSchema(schema)).not.toThrow();
      expect(() => validateMcpArguments(schema, {}, "full")).not.toThrow();
      expect(() => validateMcpArguments(schema, {}, "loose")).not.toThrow();
    }
    expect(assessMcpSchema(cyclic)).toMatchObject({ check: "loose", reason: "invalid_schema" });
  });
});

describe("validating one call", () => {
  it("loose: any JSON object up to the byte cap, and nothing else is checked", () => {
    const schema = { $ref: "https://example.com/x.json" };
    expect(validateMcpArguments(schema, { anything: [1, { deep: true }] }, "loose")).toEqual({ valid: true, errors: [] });
    expect(validateMcpArguments(schema, {}, "loose").valid).toBe(true);
    for (const value of [[1], "text", 3, null, undefined]) expect(validateMcpArguments(schema, value, "loose").valid).toBe(false);
    expect(validateMcpArguments(schema, { big: "x".repeat(MAX_LOOSE_ARGUMENT_BYTES) }, "loose").errors.join(" ")).toContain("loosely checked");
  });

  it("full: refuses, failing closed, a schema that cannot be checked in full", () => {
    const result = validateMcpArguments({ $ref: "https://example.com/x.json" }, {}, "full");
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("remote_ref");
  });

  it("fails closed past the work limit, inside a union too", () => {
    const schema = { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } };
    expect(validateMcpArguments(schema, new Array(1000).fill(1), "full").valid).toBe(true);
    const over = validateMcpArguments({ anyOf: [schema, true] }, new Array(MAX_MCP_VISITS).fill(1), "full");
    expect(over).toEqual({ valid: false, errors: ["input: is too large for the tool's schema to check"] });
  });

  it("refuses a value nested too deep for its recursive schema to check, rather than crash", () => {
    const schema = { anyOf: [{ type: "number" }, { type: "array", items: { $ref: "#" } }] };
    let value: unknown = 1;
    for (let i = 0; i < 20_000; i++) value = [value];
    expect(validateMcpArguments(schema, value, "full").valid).toBe(false);
  });

  it("a pattern fails a string longer than its subject cap, quickly", () => {
    const schema = { type: "string", pattern: "^a*a*a*b$" };
    const started = Date.now();
    expect(ok(schema, `${"a".repeat(MAX_PATTERN_SUBJECT_LENGTH + 1)}b`)).toBe(false);
    expect(ok(schema, "aaab")).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("a pattern searches anywhere in the string unless it is anchored", () => {
    expect(ok({ pattern: "b" }, "xxb")).toBe(true);
    expect(ok({ pattern: "^b" }, "xxb")).toBe(false);
    expect(ok({ pattern: "a|^b" }, "xa")).toBe(true);
  });

  it("does not check the arguments it was given in place: a later change to them is not what was checked", () => {
    const args = { a: "x" };
    validateMcpArguments({ properties: { a: { type: "string" } } }, args, "full");
    expect(args).toEqual({ a: "x" });
  });
});

describe("patterns written for the older regular-expression mode", () => {
  it.each([
    ["^[a-z\\_]+$", "^[a-z_]+$"],
    ["^[\\w-.]+$", "^[\\w\\-.]+$"],
    ["^\\:\\@\\ $", "^:@ $"],
    ["a{", "a\\{"],
    ["^\\d{2,3}$", "^\\d{2,3}$"],
    ["^[^\\]]+$", "^[^\\]]+$"],
  ])("rewrites %s to what the u flag reads the same way", (pattern, expected) => {
    expect(unicodePattern(pattern)).toBe(expected);
  });

  it("checks such a pattern in full, with the meaning the older mode gave it", () => {
    const schema = { type: "string", pattern: "^[a-z\\_]+$" };
    full(schema);
    expect(ok(schema, "snake_case")).toBe(true);
    expect(ok(schema, "kebab-case")).toBe(false);
  });
});

describe("the schema is untrusted data", () => {
  it("a keyword named __proto__ or constructor changes nothing", () => {
    const schema = JSON.parse('{"type":"object","__proto__":{"required":["x"]},"constructor":{"type":"string"}}');
    full(schema);
    expect(ok(schema, {})).toBe(true);
    expect(({} as Record<string, unknown>).required).toBeUndefined();
  });

  it("a property named __proto__ or constructor is an own key like any other", () => {
    const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"number"}},"required":["constructor"]}');
    full(schema);
    expect(ok(schema, {})).toBe(false);
    expect(ok(schema, JSON.parse('{"constructor":1,"__proto__":"x"}'))).toBe(true);
    expect(ok(schema, JSON.parse('{"constructor":1,"__proto__":2}'))).toBe(false);
    expect(ok(schema, { constructor: "one" })).toBe(false);
  });

  it("a format or a dependency named after an inherited property is inert", () => {
    expect(ok({ type: "string", format: "__proto__" }, "x")).toBe(true);
    expect(ok({ type: "string", format: "toString" }, "x")).toBe(true);
    expect(ok({ dependentRequired: { constructor: ["x"] } }, {})).toBe(true);
    expect(ok({ dependentRequired: { constructor: ["x"] } }, { constructor: 1 })).toBe(false);
  });

  it("leaves the caller's schema as it was", () => {
    const schema = { $defs: { a: { type: "string" } }, properties: { a: { $ref: "#/$defs/a" } } };
    const before = JSON.stringify(schema);
    validateMcpArguments(schema, { a: "x" }, "full");
    expect(JSON.stringify(schema)).toBe(before);
    expect(Object.getOwnPropertyNames(schema.properties.a)).toEqual(["$ref"]);
  });
});
