import { describe, expect, it } from "vitest";
import { redactPayload } from "../src/core/runs/redaction.ts";

describe("trace payload redaction", () => {
  it("redacts sensitive keys at any depth", () => {
    const out = redactPayload({
      token: "abc",
      nested: { password: "p", apiKey: "k", keep: 1 },
      list: [{ secret: "s" }],
    }) as Record<string, any>;
    expect(out.token).toBe("[REDACTED]");
    expect(out.nested.password).toBe("[REDACTED]");
    expect(out.nested.apiKey).toBe("[REDACTED]");
    expect(out.nested.keep).toBe(1);
    expect(out.list[0].secret).toBe("[REDACTED]");
  });

  it("leaves ordinary payloads intact", () => {
    expect(redactPayload({ query: "hello", n: 2 })).toEqual({ query: "hello", n: 2 });
  });

  it("drops a payload that exceeds the size cap", () => {
    const huge = { blob: "x".repeat(40 * 1024) };
    const out = redactPayload(huge) as Record<string, unknown>;
    expect(out.__anlyon_omitted).toBe("payload_too_large");
    expect(out.blob).toBeUndefined();
  });

  it("normalizes null/undefined to null", () => {
    expect(redactPayload(undefined)).toBeNull();
    expect(redactPayload(null)).toBeNull();
  });
});
