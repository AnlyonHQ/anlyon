import { describe, expect, it } from "vitest";
import { bearerToken, MAX_RUN_TOKEN_SECONDS, mintRunToken, runTokenLifetimeSeconds, verifyRunToken } from "./run-token.ts";

const claims = {
  run: "frn_a",
  version: "fnv_a",
  workspace: "00000000-0000-4000-8000-000000000001",
  environment: "00000000-0000-4000-8000-000000000002",
  endUser: "alice",
  endUserRequired: false,
  mode: "straight_through" as const,
  planDigest: null,
};

describe("run tokens", () => {
  it("carries its scope and verifies until it expires", () => {
    const now = Date.now();
    const token = mintRunToken(claims, 90, now);
    expect(verifyRunToken(token, now + 89_000)).toEqual({ ok: true, claims: { ...claims, exp: Math.floor(now / 1000) + 90 } });
    expect(verifyRunToken(token, now + 91_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a token whose claims were changed", () => {
    const token = mintRunToken(claims, 90);
    const [prefix, , mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, run: "frn_b", exp: Math.floor(Date.now() / 1000) + 90 })).toString("base64url");
    expect(verifyRunToken(`${prefix}.${forged}.${mac}`)).toEqual({ ok: false, reason: "signature" });
    expect(verifyRunToken("not-a-token")).toEqual({ ok: false, reason: "malformed" });
    expect(verifyRunToken(null)).toEqual({ ok: false, reason: "malformed" });
  });

  it("lives minutes: the run's timeout plus a margin, never more than the cap", () => {
    expect(runTokenLifetimeSeconds(30_000)).toBe(90);
    expect(runTokenLifetimeSeconds(3_000_000)).toBe(MAX_RUN_TOKEN_SECONDS);
    const now = Date.now();
    const token = mintRunToken(claims, 10_000, now);
    const check = verifyRunToken(token, now);
    expect(check.ok && check.claims.exp).toBe(Math.floor(now / 1000) + MAX_RUN_TOKEN_SECONDS);
  });

  it("reads a bearer header", () => {
    expect(bearerToken("Bearer frt_v1.a.b")).toBe("frt_v1.a.b");
    expect(bearerToken("Basic x")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
