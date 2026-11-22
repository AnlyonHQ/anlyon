import { describe, it, expect } from "vitest";
import {
  checkSchemaDefinition,
  validateAgainstSchema,
  unsafePatternReason,
  MAX_PATTERN_LENGTH,
  MAX_PATTERN_SUBJECT_LENGTH,
} from "../src/utils/json-schema.ts";

describe("json-schema subset  definition checks", () => {
  it("accepts a schema inside the supported subset", () => {
    const problems = checkSchemaDefinition({
      type: "object",
      properties: {
        email: { type: "string", pattern: "^.+@.+$" },
        plan: { enum: ["free", "pro"] },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["email"],
      additionalProperties: false,
    });
    expect(problems).toEqual([]);
  });

  it("rejects unsupported keywords rather than silently ignoring them", () => {
    const problems = checkSchemaDefinition({
      type: "object",
      properties: { age: { type: "integer", multipleOf: 2 } },
      oneOf: [{ type: "object" }],
    });

    expect(problems.some((p) => p.includes('"oneOf"'))).toBe(true);
    expect(problems.some((p) => p.includes('"multipleOf"'))).toBe(true);
  });

  it("accepts length, range and item-count bounds", () => {
    expect(
      checkSchemaDefinition({
        type: "object",
        properties: {
          subject: { type: "string", minLength: 1, maxLength: 40 },
          amount: { type: "integer", minimum: 1, maximum: 50_000 },
          ratio: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
          to: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
        },
      })
    ).toEqual([]);
  });

  it("refuses malformed or impossible bounds", () => {
    expect(checkSchemaDefinition({ type: "string", maxLength: -1 })[0]).toMatch(/non-negative integer/);
    expect(checkSchemaDefinition({ type: "string", minLength: 1.5 })[0]).toMatch(/non-negative integer/);
    expect(checkSchemaDefinition({ type: "number", minimum: "0" })[0]).toMatch(/must be a number/);
    expect(checkSchemaDefinition({ type: "number", exclusiveMinimum: true })[0]).toMatch(/boolean form of draft 4/);
    expect(checkSchemaDefinition({ type: "string", minLength: 5, maxLength: 2 })[0]).toMatch(/no value could pass/);
    expect(checkSchemaDefinition({ type: "number", minimum: 10, maximum: 1 })[0]).toMatch(/no value could pass/);
  });

  it("rejects unknown types and invalid patterns", () => {
    expect(checkSchemaDefinition({ type: "date" })[0]).toMatch(/must be one of/);
    expect(checkSchemaDefinition({ type: "string", pattern: "([" })[0]).toMatch(
      /invalid regular expression/
    );
  });
});

describe("json-schema subset  value validation", () => {
  const schema = {
    type: "object",
    properties: {
      email: { type: "string", pattern: "^.+@.+$" },
      count: { type: "integer" },
      plan: { enum: ["free", "pro"] },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["email"],
    additionalProperties: false,
  };

  it("accepts a valid value", () => {
    const result = validateAgainstSchema(schema, {
      email: "a@b.com",
      count: 3,
      plan: "pro",
      tags: ["x"],
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("reports missing required properties", () => {
    const result = validateAgainstSchema(schema, { count: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("input.email: required");
  });

  it("reports type mismatches, pattern misses, enum misses and unknown keys", () => {
    const result = validateAgainstSchema(schema, {
      email: "not-an-email",
      count: 1.5,
      plan: "enterprise",
      surprise: true,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("input.email: does not match pattern"))).toBe(true);
    expect(result.errors.some((e) => e.includes("input.count: expected integer"))).toBe(true);
    expect(result.errors.some((e) => e.includes("input.plan: must be one of"))).toBe(true);
    expect(result.errors).toContain("input.surprise: unexpected property");
  });

  it("validates array items", () => {
    const result = validateAgainstSchema(schema, { email: "a@b.com", tags: ["ok", 7] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("input.tags[1]: expected string"))).toBe(true);
  });
});

describe("json-schema subset  bounds", () => {
  const schema = {
    type: "object",
    properties: {
      subject: { type: "string", minLength: 2, maxLength: 5 },
      amount: { type: "integer", minimum: 1, maximum: 10 },
      ratio: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      to: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
    },
  };

  it("passes values inside every bound, at the inclusive edges", () => {
    expect(validateAgainstSchema(schema, { subject: "ab", amount: 10, ratio: 0.5, to: ["a", "b"] })).toEqual({ valid: true, errors: [] });
  });

  it("counts string length in code points, not UTF-16 units", () => {
    expect(validateAgainstSchema(schema, { subject: "😀😀😀" }).valid).toBe(true);
  });

  it("reports each value outside its bound", () => {
    const { errors } = validateAgainstSchema(schema, { subject: "a", amount: 11, ratio: 1, to: [] });
    expect(errors).toEqual([
      "input.subject: must be at least 2 characters, got 1",
      "input.amount: must be at most 10, got 11",
      "input.ratio: must be less than 1, got 1",
      "input.to: must have at least 1 items, got 0",
    ]);
    expect(validateAgainstSchema(schema, { subject: "abcdef", amount: 0, ratio: 0, to: ["a", "b", "c"] }).errors).toEqual([
      "input.subject: must be at most 5 characters, got 6",
      "input.amount: must be at least 1, got 0",
      "input.ratio: must be greater than 0, got 0",
      "input.to: must have at most 2 items, got 3",
    ]);
  });
});

describe("json-schema subset  patterns that could backtrack catastrophically", () => {
  it.each([
    ["(a+)+$", /nested quantifiers/],
    ["^(.*)*x", /nested quantifiers/],
    ["^(\\d+\\s?)*$", /nested quantifiers/],
    ["^((ab)+)*$", /nested quantifiers/],
    ["(a|a)*$", /alternation/],
    ["^(x|xy){2,}$", /alternation/],
    ["(a)\\1", /backreference/],
    ["(?<q>a)\\k<q>", /backreference/],
    ["^(a+a+\\.)+$", /nested quantifiers/],
    ["^([a-z.]+\\.)+$", /nested quantifiers/],
    ["^(.+-)+$", /nested quantifiers/],
    ["^((a|b)+\\.)+$", /alternation/],
  ])("refuses %s when the schema is saved", (pattern, reason) => {
    expect(unsafePatternReason(pattern)).toMatch(reason);
    const problems = checkSchemaDefinition({ type: "string", pattern });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/schema\.pattern: refused because/);
  });

  it.each([
    "^.+@.+$",
    "^[a-z0-9_-]{3,32}$",
    "^(?:https?|ftp)://[^\\s]+$",
    "^(\\d{3}-){2}\\d{4}$",
    "^[(a+)+]$",
    "^\\(\\d+\\)+$",
    "^(?<year>\\d{4})-(?<month>\\d{2})$",
    "^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$",
    "^[a-z]+(\\.[a-z]+)*$",
    "^(\\w+-)*\\w+$",
  ])("accepts %s", (pattern) => {
    expect(unsafePatternReason(pattern)).toBeNull();
    expect(checkSchemaDefinition({ type: "string", pattern })).toEqual([]);
  });

  it("refuses a pattern longer than the cap", () => {
    expect(unsafePatternReason("a".repeat(MAX_PATTERN_LENGTH + 1))).toMatch(/longer than/);
  });

  it("refuses to run an unsafe pattern stored before the check existed", () => {
    const started = Date.now();
    const result = validateAgainstSchema({ type: "string", pattern: "^(a+)+$" }, "a".repeat(40) + "!");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/cannot be checked/);
  });

  it("bounds the subject a pattern is tested against", () => {
    const schema = { type: "string", pattern: "^a*$" };
    expect(validateAgainstSchema(schema, "a".repeat(MAX_PATTERN_SUBJECT_LENGTH)).valid).toBe(true);
    const result = validateAgainstSchema(schema, "a".repeat(MAX_PATTERN_SUBJECT_LENGTH + 1));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(new RegExp(`longer than the ${MAX_PATTERN_SUBJECT_LENGTH}`));
  });
});
