import { describe, expect, it } from "vitest";
import { redactLogHeaders } from "./public-log.ts";

describe("redactLogHeaders", () => {
  it("redacts credentials case-insensitively while preserving diagnostic headers", () => {
    expect(
      redactLogHeaders({
        Authorization: "Bearer secret",
        cookie: "session=secret",
        "X-API-Key": "secret",
        "Content-Type": "application/json",
      })
    ).toEqual({
      Authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      "X-API-Key": "[REDACTED]",
      "Content-Type": "application/json",
    });
  });

  it("preserves null and non-object header payloads", () => {
    expect(redactLogHeaders(null)).toBeNull();
    expect(redactLogHeaders("invalid legacy value")).toBe("invalid legacy value");
  });
});
