import { describe, expect, it } from "vitest";
import { looksLikeJwt } from "./oauth-tokens.ts";

describe("looksLikeJwt", () => {
  it("recognises a real access token", () => {
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "user_1", scope: "anlyon:memory" })).toString("base64url");
    expect(looksLikeJwt(`${header}.${payload}.signature`)).toBe(true);
  });

  it("does not mistake an Anlyon API key for one", () => {
    expect(looksLikeJwt("anlyon_live_0000000000000000000000000000000o")).toBe(false);
  });

  it("rejects credentials with the wrong number of segments", () => {
    expect(looksLikeJwt("only.two")).toBe(false);
    expect(looksLikeJwt("far.too.many.segments")).toBe(false);
    expect(looksLikeJwt("")).toBe(false);
  });

  it("is a shape check, not a validity check", () => {
    expect(looksLikeJwt("a.b.c")).toBe(true);
  });
});
