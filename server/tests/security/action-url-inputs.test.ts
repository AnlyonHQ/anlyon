import { describe, expect, it } from "vitest";
import { interpolate, interpolateUrl, interpolateUrlWithStubbedSecrets } from "../../src/core/actions/template.ts";

const { assertPlaceholdersWellFormed } = await import("../../src/core/actions/service.ts");

const vault = new Map([["STRIPE_KEY", "sk_live_x"]]);
const resolved = (template: string, input: Record<string, unknown>) => new URL(interpolateUrl(template, input, vault));

describe("inputs in a URL", () => {
  it("render ordinary values exactly as before", () => {
    expect(interpolateUrl("https://api.stripe.com/v1/customers/{{input.id}}", { id: "cus_123" }, vault)).toBe(
      "https://api.stripe.com/v1/customers/cus_123",
    );
    expect(interpolateUrl("https://h.example/search?q={{input.q}}&n={{input.n}}", { q: "shoes", n: 5 }, vault)).toBe(
      "https://h.example/search?q=shoes&n=5",
    );
  });

  it("cannot climb out of their segment", () => {
    const url = resolved("https://api.stripe.com/v1/customers/{{input.id}}", { id: "../../v1/refunds" });
    expect(url.pathname).toBe("/v1/customers/..%2F..%2Fv1%2Frefunds");
    expect(url.pathname.startsWith("/v1/customers/")).toBe(true);
  });

  it.each([".", ".."])("refuse %s as a whole path segment, which a URL parser would resolve", (value) => {
    expect(() => interpolateUrl("https://api.clickup.com/api/v2/task/{{input.task}}/tag/{{input.tag}}", { task: "abc", tag: value }, vault)).toThrow(
      /cannot be/,
    );
    expect(() => interpolateUrlWithStubbedSecrets("https://h.example/v1/{{input.id}}/x", { id: value })).toThrow(/cannot be/);
  });

  it("refuse a dot segment an input forms with the template's own text", () => {
    expect(() => interpolateUrl("https://h.example/v1/{{input.a}}./x", { a: "" }, vault)).toThrow(
      /"\." or "\.\." segment/,
    );
  });

  it("still allow dots inside a segment and in the query", () => {
    expect(resolved("https://h.example/v1/{{input.id}}", { id: "file..v2.txt" }).pathname).toBe("/v1/file..v2.txt");
    expect(resolved("https://h.example/v1/search?q={{input.q}}", { q: ".." }).searchParams.get("q")).toBe("..");
  });

  it("cannot add query parameters or a fragment", () => {
    const url = resolved("https://api.stripe.com/v1/customers/{{input.id}}", { id: "a?expand[]=sources#x" });
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
    const query = resolved("https://h.example/search?q={{input.q}}", { q: "x&admin=true" });
    expect(query.searchParams.get("admin")).toBeNull();
    expect(query.searchParams.get("q")).toBe("x&admin=true");
  });

  it("leave header and body rendering untouched", () => {
    expect(interpolate("Order {{input.id}}", { id: "a/b?c" }, vault)).toBe("Order a/b?c");
  });

  it("are encoded the same way when probing where a request goes", () => {
    expect(interpolateUrlWithStubbedSecrets("https://h.example/{{input.id}}?k={{secret:STRIPE_KEY}}", { id: "../x" })).toBe(
      "https://h.example/..%2Fx?k=secret-placeholder",
    );
  });
});

describe("inputs in a URL's host (actions without secrets only)", () => {
  it("keep working for a hostname and port", () => {
    expect(interpolateUrl("https://{{input.host}}/ping", { host: "api.example.com:8443" }, vault)).toBe(
      "https://api.example.com:8443/ping",
    );
    expect(interpolateUrl("https://{{input.region}}.api.example.com/ping", { region: "eu-west-1" }, vault)).toBe(
      "https://eu-west-1.api.example.com/ping",
    );
  });

  it.each(["evil.example/steal?", "evil.example#", "user@evil.example", "evil.example\\x"])("refuse %s", (host) => {
    expect(() => interpolateUrl("https://{{input.host}}/ping", { host }, vault)).toThrow(/not a valid host/);
  });
});

describe("{{input.x:path}}", () => {
  const template = "https://files.example/v1/files/{{input.path:path}}/content";

  it("allows slashes between ordinary segments", () => {
    expect(resolved(template, { path: "docs/2026/report.pdf" }).pathname).toBe("/v1/files/docs/2026/report.pdf/content");
  });

  it("encodes each segment", () => {
    expect(resolved(template, { path: "a b/c?d" }).pathname).toBe("/v1/files/a%20b/c%3Fd/content");
  });

  it.each(["../etc/passwd", "docs/../../admin", "./x", "/leading", "trailing/", "a//b"])("refuses %s", (path) => {
    expect(() => interpolateUrl(template, { path }, vault)).toThrow(/not a safe path/);
  });

  it("treats a pre-encoded traversal as literal text", () => {
    expect(resolved(template, { path: "%2e%2e/admin" }).pathname).toBe("/v1/files/%252e%252e/admin/content");
  });
});

describe("authoring", () => {
  it("accepts the documented placeholders", () => {
    expect(() =>
      assertPlaceholdersWellFormed({ urlTemplate: "https://h.example/{{input.a:path}}/{{input.b}}?k={{secret:K}}" }),
    ).not.toThrow();
  });

  it("refuses an unrecognised placeholder instead of sending it literally", () => {
    expect(() => assertPlaceholdersWellFormed({ urlTemplate: "https://h.example/{{input.a:raw}}" })).toThrow(/unrecognised/);
    expect(() => assertPlaceholdersWellFormed({ urlTemplate: "https://h.example/{{inputs.a}}" })).toThrow(/unrecognised/);
  });

  it("refuses :path outside the URL path", () => {
    expect(() => assertPlaceholdersWellFormed({ urlTemplate: "https://{{input.h:path}}/x" })).toThrow(/only be used in the URL's path/);
    expect(() => assertPlaceholdersWellFormed({ urlTemplate: "https://h.example/x?q={{input.q:path}}" })).toThrow(/only be used in the URL's path/);
    expect(() =>
      assertPlaceholdersWellFormed({ urlTemplate: "https://h.example/x", bodyTemplate: { p: "{{input.p:path}}" } }),
    ).toThrow(/only applies in urlTemplate/);
  });
});
