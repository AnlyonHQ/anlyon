import { describe, expect, it } from "vitest";
import { z } from "zod";
import { legacyDatetime, legacyZodIssues } from "./zod-compat.ts";

const messageOf = (schema: z.ZodType, input: unknown) => {
  const result = schema.safeParse(input);
  if (result.success) throw new Error("expected a failure");
  return result.error.issues.map((issue) => issue.message);
};

describe("Zod 3 messages on Zod 4", () => {
  it.each([
    ["a missing value", z.object({ name: z.string() }), {}, ["Required"]],
    ["a wrong type", z.object({ n: z.number() }), { n: "x" }, ["Expected number, received string"]],
    ["NaN", z.number(), Number.NaN, ["Expected number, received nan"]],
    ["a short string", z.string().min(3), "ab", ["String must contain at least 3 character(s)"]],
    ["a long string", z.string().max(2), "abc", ["String must contain at most 2 character(s)"]],
    ["an exact length", z.string().length(3), "ab", ["String must contain exactly 3 character(s)"]],
    ["a long array", z.array(z.string()).max(1), ["a", "b"], ["Array must contain at most 1 element(s)"]],
    ["a short array", z.array(z.string()).min(1), [], ["Array must contain at least 1 element(s)"]],
    ["a small number", z.number().min(1), 0, ["Number must be greater than or equal to 1"]],
    ["a large number", z.number().int().max(10), 11, ["Number must be less than or equal to 10"]],
    ["an exclusive bound", z.number().gt(5), 5, ["Number must be greater than 5"]],
    ["a multiple", z.number().multipleOf(5), 3, ["Number must be a multiple of 5"]],
    ["an email", z.string().email(), "x", ["Invalid email"]],
    ["a URL", z.string().url(), "x", ["Invalid url"]],
    ["a UUID", z.string().guid(), "x", ["Invalid uuid"]],
    ["a pattern", z.string().regex(/^a$/), "b", ["Invalid"]],
    ["a prefix", z.string().startsWith("pk_"), "x", ['Invalid input: must start with "pk_"']],
    ["an enum value", z.enum(["free", "pro"]), "enterprise", ["Invalid enum value. Expected 'free' | 'pro', received 'enterprise'"]],
    ["an enum type", z.enum(["free", "pro"]), 1, ["Expected 'free' | 'pro', received number"]],
    ["a missing enum", z.object({ plan: z.enum(["free", "pro"]) }), {}, ["Required"]],
    ["a literal", z.literal("x"), "y", ['Invalid literal value, expected "x"']],
    ["an unknown key", z.object({ a: z.string() }).strict(), { a: "x", b: 1 }, ["Unrecognized key(s) in object: 'b'"]],
    ["a union", z.union([z.string(), z.number()]), true, ["Invalid input"]],
    ["a refinement", z.string().refine(() => false), "x", ["Invalid input"]],
    [
      "a discriminator",
      z.discriminatedUnion("type", [z.object({ type: z.literal("a") }), z.object({ type: z.literal("b") })]),
      { type: "c" },
      ["Invalid discriminator value. Expected 'a' | 'b'"],
    ],
  ])("words %s as Zod 3 did", (_label, schema, input, expected) => {
    expect(messageOf(schema as z.ZodType, input)).toEqual(expected);
  });

  it("keeps a message the schema sets itself", () => {
    expect(messageOf(z.string().min(1, "Name is required"), "")).toEqual(["Name is required"]);
    expect(messageOf(z.string().url("Invalid URL format"), "x")).toEqual(["Invalid URL format"]);
    expect(messageOf(z.string().refine(() => false, { error: "no" }), "x")).toEqual(["no"]);
  });
});

describe("Zod 3 issue codes in details", () => {
  it("renames the codes Zod 4 changed and drops the input", () => {
    const result = z
      .object({ id: z.string().guid(), plan: z.enum(["free", "pro"]), kind: z.literal("x") })
      .safeParse({ id: "x", plan: "y", kind: "z" });
    if (result.success) throw new Error("expected a failure");
    const details = legacyZodIssues(result.error.issues);
    expect(details.map((d) => [d.code, (d.path as PropertyKey[]).join(".")])).toEqual([
      ["invalid_string", "id"],
      ["invalid_enum_value", "plan"],
      ["invalid_literal", "kind"],
    ]);
    expect(details[0]).toMatchObject({ validation: "uuid", message: "Invalid uuid" });
    expect(details.every((d) => !("input" in d))).toBe(true);
  });
});

describe("Zod 3 acceptance", () => {
  it("accepts any hex UUID, as Zod 3's uuid() did", () => {
    for (const id of ["550e8400-e29b-41d4-a716-446655440000", "11111111-1111-1111-1111-111111111111", "00000000-0000-0000-0000-000000000001"]) {
      expect(z.string().guid().safeParse(id).success).toBe(true);
    }
    expect(z.string().guid().safeParse("not-a-uuid").success).toBe(false);
  });

  it("accepts the datetimes Zod 3's datetime() did", () => {
    const utc = legacyDatetime();
    for (const value of ["2026-10-24T10:00:00Z", "2026-10-24T10:00:00.123456Z", "2026-10-24T10:00Z", "2028-02-29T00:00:00Z"]) {
      expect(utc.safeParse(value).success).toBe(true);
    }
    for (const value of ["2026-10-24T10:00:00", "2026-10-24T10:00:00+05:00", "2026-02-29T00:00:00Z", "2026-10-24 10:00:00Z"]) {
      expect(utc.safeParse(value).success).toBe(false);
    }
    expect(messageOf(utc, "x")).toEqual(["Invalid datetime"]);

    const offset = legacyDatetime({ offset: true });
    for (const value of ["2026-10-24T10:00:00+05:00", "2026-10-24T10:00:00+0500", "2026-10-24T10:00:00Z"]) {
      expect(offset.safeParse(value).success).toBe(true);
    }
    expect(offset.safeParse("2026-10-24T10:00:00+05").success).toBe(false);
  });
});
