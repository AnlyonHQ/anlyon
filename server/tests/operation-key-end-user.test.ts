import { describe, expect, it } from "vitest";
import { isSameOperation } from "../src/core/effects/lifecycle.ts";

describe("an operation key replayed", () => {
  const stored = { requestDigest: "sha256:abc", endUserId: "alice" };

  it("is the same operation for the same request and the same end user", () => {
    expect(isSameOperation(stored, "sha256:abc", "alice")).toBe(true);
  });

  it("is not for another end user, even with the same request", () => {
    expect(isSameOperation(stored, "sha256:abc", "bob")).toBe(false);
    expect(isSameOperation(stored, "sha256:abc", null)).toBe(false);
    expect(isSameOperation(stored, "sha256:abc", undefined)).toBe(false);
  });

  it("is not for a different request", () => {
    expect(isSameOperation(stored, "sha256:def", "alice")).toBe(false);
  });

  it("treats no end user as one identity, as before", () => {
    const own = { requestDigest: "sha256:abc", endUserId: null };
    expect(isSameOperation(own, "sha256:abc", null)).toBe(true);
    expect(isSameOperation(own, "sha256:abc", undefined)).toBe(true);
    expect(isSameOperation(own, "sha256:abc", "alice")).toBe(false);
  });
});
