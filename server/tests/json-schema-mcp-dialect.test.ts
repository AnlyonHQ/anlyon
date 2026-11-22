import { describe, expect, it } from "vitest";
import { checkSchemaDefinition, validateAgainstSchema } from "../src/utils/json-schema.ts";
import { assessMcpSchema, MAX_MCP_VISITS, validateMcpArguments } from "../src/utils/mcp-json-schema.ts";

const assess = (schema: unknown) => assessMcpSchema(schema);
const valid = (schema: unknown, value: unknown) => validateMcpArguments(schema, value, "full").valid;

const SAVE_ISSUE = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    dueDate: { type: ["string", "null"] },
    cycle: { type: ["number", "null"] },
    slaType: { anyOf: [{ enum: ["all", "onlyBusinessDays"], type: "string" }, { type: "null" }] },
    links: { type: "array", items: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" } } } },
    patch: {
      type: "array",
      items: {
        oneOf: [
          { type: "object", required: ["op", "old_string"], properties: { op: { type: "string", const: "replace" }, old_string: { type: "string" } } },
          { type: "object", required: ["op", "text"], properties: { op: { type: "string", const: "append" }, text: { type: "string" } } },
        ],
      },
    },
    anchor: { type: "object", propertyNames: { type: "string", maxLength: 8 }, additionalProperties: { type: "number" } },
  },
};

describe("json-schema: an action's own schema keeps the plain subset", () => {
  it.each([
    ["a list of types", { type: ["string", "null"] }],
    ["anyOf", { anyOf: [{ type: "string" }] }],
    ["oneOf", { oneOf: [{ type: "string" }] }],
    ["const", { const: "a" }],
    ["format", { type: "string", format: "uri" }],
    ["propertyNames", { type: "object", propertyNames: { type: "string" } }],
    ["a schema for additionalProperties", { type: "object", additionalProperties: { type: "string" } }],
    ["$ref", { $ref: "#/$defs/a" }],
    ["allOf", { allOf: [{ type: "string" }] }],
  ])("refuses %s", (_name, schema) => {
    expect(checkSchemaDefinition(schema)).not.toEqual([]);
  });
});

describe("an MCP tool's schema: what is checked in full", () => {
  it("checks what Linear publishes in full", () => {
    expect(assess(SAVE_ISSUE).check).toBe("full");
  });

  it.each([
    ["$defs with a $ref into them", { $defs: { a: { type: "string" } }, properties: { x: { $ref: "#/$defs/a" } } }],
    ["$defs alone", { $defs: {} }],
    ["allOf", { allOf: [{ type: "string" }] }],
    ["not", { not: { type: "string" } }],
    ["if", { if: { type: "string" } }],
    ["an unknown format, which is an annotation", { type: "string", format: "made-up" }],
    ["an inherited name as a format", { type: "string", format: "constructor" }],
    ["twelve nested branches", (() => {
      let schema: unknown = { type: "string" };
      for (let i = 0; i < 12; i++) schema = { anyOf: [schema] };
      return schema;
    })()],
  ])("checks %s in full (the old dialect refused it)", (_name, schema) => {
    expect(assess(schema)).toEqual({ check: "full", reason: null, detail: null });
  });
});

describe("an MCP tool's schema: what is adopted loosely checked instead of refused", () => {
  it.each([
    ["a $ref to nothing", { $ref: "#/$defs/a" }],
    ["an empty list of types", { type: [] }],
    ["a repeated type", { type: ["string", "string"] }],
    ["an unknown type in a list", { type: ["string", "thing"] }],
    ["an empty anyOf", { anyOf: [] }],
    ["an anyOf that is not a list", { anyOf: { type: "string" } }],
  ])("%s is invalid_schema", (_name, schema) => {
    expect(assess(schema)).toMatchObject({ check: "loose", reason: "invalid_schema" });
  });

  it("finds what cannot be checked in every place a sub-schema can sit", () => {
    const hidden = { $ref: "#/x" };
    for (const schema of [
      { anyOf: [hidden] },
      { oneOf: [{ type: "string" }, hidden] },
      { type: "object", additionalProperties: hidden },
      { type: "object", propertyNames: hidden },
      { allOf: [{ not: { if: hidden } }] },
      { type: "array", prefixItems: [true, hidden] },
      { $defs: { unused: hidden } },
    ]) {
      expect(assess(schema)).toMatchObject({ check: "loose", reason: "invalid_schema" });
    }
  });

  it("finds an unsafe pattern inside a branch", () => {
    expect(assess({ anyOf: [{ type: "string", pattern: "(a+)+$" }] })).toMatchObject({ check: "loose", reason: "unsafe_pattern" });
  });
});

describe("an MCP tool's schema: each keyword is enforced on every call", () => {
  it("accepts a good call", () => {
    expect(valid(SAVE_ISSUE, {
      title: "Prepare the Acme kickoff",
      dueDate: null,
      cycle: 3,
      slaType: "all",
      links: [{ url: "https://example.com/a" }],
      patch: [{ op: "replace", old_string: "a" }],
      anchor: { line: 4 },
    })).toBe(true);
  });

  it.each([
    ["the wrong type in a list", { dueDate: 4 }],
    ["a value outside an anyOf", { slaType: "weekends" }],
    ["a value of the wrong type in an anyOf", { slaType: 1 }],
    ["a bad format", { links: [{ url: "not a url" }] }],
    ["a branch of oneOf with the wrong const", { patch: [{ op: "delete", old_string: "a" }] }],
    ["a oneOf branch missing a required field", { patch: [{ op: "replace" }] }],
    ["a key too long for propertyNames", { anchor: { "much-too-long": 4 } }],
    ["a value failing additionalProperties", { anchor: { line: "four" } }],
    ["a property the schema does not name", { nothing: 1 }],
  ])("refuses %s", (_name, input) => {
    expect(valid(SAVE_ISSUE, input)).toBe(false);
  });

  it("refuses a value matching two branches of a oneOf", () => {
    const result = validateMcpArguments({ oneOf: [{ type: "number" }, { type: "integer" }] }, 3, "full");
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("exactly one");
  });

  it("applies object rules in a branch that names no type, or the branch would pass anything", () => {
    const schema = { anyOf: [{ required: ["a"] }, { required: ["b"] }] };
    expect(valid(schema, { a: 1 })).toBe(true);
    expect(valid(schema, {})).toBe(false);
    expect(valid({ additionalProperties: false, anyOf: [{ type: "object" }] }, { a: 1 })).toBe(false);
  });

  it("applies items with no type named", () => {
    expect(valid({ items: { type: "string" } }, [1])).toBe(false);
  });

  it("does not let an object nested in a list of types skip its rules", () => {
    const schema = { type: ["object", "null"], required: ["a"], properties: { a: { type: "string" } } };
    expect(valid(schema, null)).toBe(true);
    expect(valid(schema, { a: "x" })).toBe(true);
    expect(valid(schema, {})).toBe(false);
    expect(valid(schema, { a: 1 })).toBe(false);
  });

  it.each([
    ["uri", "https://example.com", "example.com"],
    ["date", "2026-11-02", "2026-13-40"],
    ["date-time", "2026-11-02T10:00:00Z", "2026-11-02"],
    ["email", "a@example.com", "a example.com"],
    ["uuid", "123e4567-e89b-12d3-a456-426614174000", "123"],
  ])("checks the format %s", (format, good, bad) => {
    const schema = { type: "string", format };
    expect(valid(schema, good)).toBe(true);
    expect(valid(schema, bad)).toBe(false);
  });

  it("fails closed past its work limit, rather than pass what it did not finish checking", () => {
    const schema = { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } };
    const result = validateMcpArguments(schema, new Array(MAX_MCP_VISITS).fill(1), "full");
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("too large");
    expect(result.errors.length).toBeLessThan(5);
  });
});

describe("json-schema: an existing action's validation does not change", () => {
  it("still ignores required with no type or properties named, as it always has", () => {
    expect(validateAgainstSchema({ required: ["a"] }, {}).valid).toBe(true);
  });

  it("does not bound the work of a plain schema", () => {
    const schema = { type: "array", items: { type: "number" } };
    expect(validateAgainstSchema(schema, new Array(MAX_MCP_VISITS + 10).fill(1)).valid).toBe(true);
  });
});
