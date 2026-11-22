import { describe, it, expect } from "vitest";
import { isAllowedRedirectTarget, resolveSafeRedirect } from "../src/utils/origins.ts";
import { env } from "../src/config/env.ts";

describe("isAllowedRedirectTarget", () => {
  it("accepts a relative path", () => {
    expect(isAllowedRedirectTarget("/integrations?ok=1")).toBe(true);
  });

  it("accepts the trusted frontend origin", () => {
    expect(isAllowedRedirectTarget("https://console.anlyon.com/integrations")).toBe(true);
  });

  it("rejects a foreign absolute URL", () => {
    expect(isAllowedRedirectTarget("https://evil.com/phish")).toBe(false);
  });

  it("rejects a protocol-relative foreign URL", () => {
    expect(isAllowedRedirectTarget("//evil.com/phish")).toBe(false);
  });

  it("rejects non-URL values", () => {
    expect(isAllowedRedirectTarget("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirectTarget("")).toBe(false);
  });
});

describe("resolveSafeRedirect", () => {
  const fallback = env.FRONTEND_URL || "https://console.anlyon.com";

  it("returns the allowlisted value when safe", () => {
    expect(resolveSafeRedirect("https://console.anlyon.com/ok")).toBe(
      "https://console.anlyon.com/ok",
    );
  });

  it("falls back to the trusted frontend for a foreign URL", () => {
    expect(resolveSafeRedirect("https://evil.com/phish")).toBe(fallback);
  });

  it("falls back for null/undefined", () => {
    expect(resolveSafeRedirect(null)).toBe(fallback);
    expect(resolveSafeRedirect(undefined)).toBe(fallback);
  });
});
