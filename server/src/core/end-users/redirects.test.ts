import { describe, expect, it } from "vitest";
import { matchRedirect, normalizeAllowedRedirect, redirectWithResult, resolveRedirect } from "./redirects.ts";
import { erasedEndUserId, isEndUserId, parseEndUserId } from "./identity.ts";
import { SECRET_REF, extractSecretNames, interpolate, interpolateKeepingSecretRefs, secretRefText } from "../actions/template.ts";

const allowed = ["https://app.acme.test/connected", "https://app.acme.test/oauth/", "http://localhost:3000/cb"];

describe("the redirect allow-list", () => {
  it.each([
    "https://app.acme.test/connected",
    "https://app.acme.test/connected/gmail",
    "https://app.acme.test/connected?tab=1",
    "https://app.acme.test/oauth/done",
    "http://localhost:3000/cb",
  ])("allows %s", (url) => {
    expect(matchRedirect(url, allowed)).not.toBeNull();
  });

  it.each([
    ["another host", "https://evil.test/connected"],
    ["a suffix host", "https://app.acme.test.evil.test/connected"],
    ["user info", "https://app.acme.test@evil.test/connected"],
    ["user info before the host", "https://user:pass@app.acme.test/connected"],
    ["scheme-relative", "//evil.test/connected"],
    ["no scheme", "app.acme.test/connected"],
    ["a sibling path", "https://app.acme.test/connected-evil"],
    ["path traversal", "https://app.acme.test/connected/../admin"],
    ["encoded traversal", "https://app.acme.test/connected/%2e%2e/admin"],
    ["a backslash", "https://app.acme.test\\evil.test/connected"],
    ["a tab", "https://app.acme.test/conn\tected"],
    ["a newline", "https://app.acme.test/connected\nLocation: https://evil.test"],
    ["plain http", "http://app.acme.test/connected"],
    ["another port", "https://app.acme.test:8443/connected"],
    ["javascript", "javascript:alert(1)//https://app.acme.test/connected"],
    ["data", "data:text/html,<script>alert(1)</script>"],
    ["a fragment", "https://app.acme.test/connected#x"],
    ["http on a non-loopback host", "http://127.0.0.2:3000/cb"],
  ])("refuses %s", (_label, url) => {
    expect(matchRedirect(url, allowed)).toBeNull();
  });

  it("normalizes entries to origin and path and refuses unusable ones", () => {
    expect(normalizeAllowedRedirect("https://App.Acme.test/connected")).toBe("https://app.acme.test/connected");
    for (const bad of ["https://app.acme.test/x?y=1", "ftp://a.test/", "https://u@a.test/", "http://a.test/", "//a.test/", "not a url"]) {
      expect(() => normalizeAllowedRedirect(bad), bad).toThrow();
    }
  });

  it("uses the default only when it is still allowed, and needs one", () => {
    expect(resolveRedirect(undefined, { allowedRedirectUrls: allowed, defaultRedirectUrl: "https://app.acme.test/connected" }))
      .toBe("https://app.acme.test/connected");
    expect(resolveRedirect(undefined, { allowedRedirectUrls: [], defaultRedirectUrl: "https://app.acme.test/connected" })).toBeNull();
    expect(() => resolveRedirect("https://evil.test/", { allowedRedirectUrls: allowed, defaultRedirectUrl: null }))
      .toThrow(expect.objectContaining({ code: "REDIRECT_URL_NOT_ALLOWED" }));
  });

  it("puts the result in the query, overriding anything the redirect carried", () => {
    const to = new URL(redirectWithResult("https://app.acme.test/connected?anlyon_status=connected&tab=1", { anlyon_status: "declined", integration: "gmail" }));
    expect(to.searchParams.getAll("anlyon_status")).toEqual(["declined"]);
    expect(to.searchParams.get("tab")).toBe("1");
  });
});

describe("end-user ids", () => {
  it.each(["user_123", "alice@acme.test", "org:5:user:9", "a", "A.b-c_d", "x".repeat(128)])("accepts %s", (id) => {
    expect(isEndUserId(id)).toBe(true);
  });
  it.each(["", "x".repeat(129), "has space", "slash/no", "tilde~no", "quote\"", "erased~0123"])("refuses %j", (id) => {
    expect(() => parseEndUserId(id)).toThrow(expect.objectContaining({ statusCode: 400, code: "INVALID_END_USER" }));
  });
  it("erases to a keyed hash that is not a valid id and differs per workspace", () => {
    const a = erasedEndUserId("ws-1", "alice@acme.test");
    expect(a).toMatch(/^erased~[0-9a-f]{32}$/);
    expect(isEndUserId(a)).toBe(false);
    expect(erasedEndUserId("ws-2", "alice@acme.test")).not.toBe(a);
    expect(erasedEndUserId("ws-1", "alice@acme.test")).toBe(a);
  });
});

describe("{{connection:<integration>}}", () => {
  it("is a credential reference beside {{secret:NAME}}", () => {
    expect(extractSecretNames("Bearer {{connection:gmail}} {{secret:KEY}}")).toEqual(["connection:gmail", "KEY"]);
    expect(extractSecretNames("{{secret:connection:gmail}} {{connection:Gmail}} {{ connection:google-calendar }}")).toEqual(["connection:google-calendar"]);
    expect(secretRefText("connection:gmail")).toBe("{{connection:gmail}}");
    expect(secretRefText("KEY")).toBe("{{secret:KEY}}");
    expect(new RegExp(SECRET_REF.source).test("{{connection:slack}}")).toBe(true);
  });

  it("renders in one pass: an input spelling a connection reference stays text", () => {
    const secrets = new Map([["connection:gmail", "tok_gmail_value"]]);
    expect(interpolate("Bearer {{connection:gmail}} {{input.note}}", { note: "{{connection:gmail}}" }, secrets))
      .toBe("Bearer tok_gmail_value {{connection:gmail}}");
    expect(() => interpolateKeepingSecretRefs("{{input.x}}", { x: "{{connection:gmail}}" })).toThrow(/secret reference/);
    expect(interpolateKeepingSecretRefs("Bearer {{connection:gmail}}", {})).toBe("Bearer {{connection:gmail}}");
  });
});
