import { describe, expect, it } from "vitest";
import {
  declaredHost,
  evaluateAmount,
  impactQuantity,
  normalizeVerify,
  normalizedVerifyNeedsResponse,
  parseAmountExpression,
  parseDeclarations,
  parseImpactDeclaration,
  parseVerifyDeclaration,
  resolveVerifyUrl,
  verifyMismatches,
  verifyNeedsResponse,
} from "../src/core/effects/declarations.ts";
import { buildDeclaredAdapter, HTTP_DECLARED_TYPE, type DeclaredRequest } from "../src/core/effects/adapters/http-declared.ts";
import { canonicalDigest } from "../src/core/effects/canonical.ts";
import { requestDigest } from "../src/core/effects/binding.ts";
import { quantityFor } from "../src/core/effects/impact.ts";
import { ValidationError } from "../src/utils/errors.ts";

const HOST = "api.mailer.example";
const TOKEN = "mlr_live_do_not_persist_0000000000";

const definition = (overrides: Record<string, unknown> = {}) => ({
  method: "POST",
  urlTemplate: `https://${HOST}/v1/lists/{{input.list}}/messages?key={{secret:MAILER_QUERY_KEY}}`,
  headers: { Authorization: "Bearer {{secret:MAILER_TOKEN}}", "X-Campaign": "{{input.campaign}}" },
  bodyTemplate: { to: "{{input.to}}", subject: "Hello {{input.name}}", signature: "{{secret:MAILER_SIGNATURE}}" },
  inputSchema: {
    type: "object",
    required: ["list", "to"],
    properties: {
      list: { type: "string" },
      to: { type: "array", items: { type: "string" } },
      name: { type: "string" },
      campaign: { type: "string" },
    },
  },
  declarations: {
    impact: { dimension: "emails", unit: "emails", amount: "count(input.to)", bound: "exact" },
    verify: { url: `https://${HOST}/v1/messages/{{response.id}}`, status: 200, match: [{ path: "status", equals: "sent" }] },
  },
  ...overrides,
});
const input = { list: "customers", to: ["a@example.com", "b@example.com"], name: "Ada", campaign: "welcome" };
const normalize = (def: Record<string, unknown>, value: Record<string, unknown>) => {
  const adapter = buildDeclaredAdapter(def);
  return adapter.normalize(adapter.parseConfig(def), value);
};

describe("declaration validation", () => {
  it("accepts money with a currency, resource mutations, and a declared unit", () => {
    expect(parseImpactDeclaration({ dimension: "money", unit: "usd", amount: "input.amount", bound: "exact" }))
      .toEqual({ dimension: "money", unit: "usd", amount: "input.amount", bound: "exact" });
    expect(parseImpactDeclaration({ dimension: "resource_mutations", amount: "1", bound: "exact" }).unit).toBe("resource_mutations");
    expect(parseImpactDeclaration({ dimension: "emails", amount: " count(input.to) ", bound: "upper_bound" }))
      .toEqual({ dimension: "emails", unit: "emails", amount: "count(input.to)", bound: "upper_bound" });
  });

  it("refuses a unit that is not the currency for money or the dimension name otherwise", () => {
    for (const impact of [
      { dimension: "money", amount: "1", bound: "exact" },
      { dimension: "money", unit: "USD", amount: "1", bound: "exact" },
      { dimension: "emails", unit: "messages", amount: "1", bound: "exact" },
      { dimension: "Emails", amount: "1", bound: "exact" },
      { dimension: "e".repeat(33), amount: "1", bound: "exact" },
      { dimension: "emails", amount: "1", bound: "roughly" },
      { dimension: "emails", amount: "1", bound: "exact", perCaller: true },
      { dimension: "emails", amount: 3, bound: "exact" },
    ]) {
      expect(() => parseImpactDeclaration(impact), JSON.stringify(impact)).toThrow(ValidationError);
    }
  });

  it("accepts a verify rule on the action's own host and refuses one anywhere else", () => {
    const url = `https://${HOST}/v1/messages/{{response.id}}`;
    expect(parseDeclarations({ verify: { url, status: 200 } }, `https://${HOST}/v1/messages`))
      .toEqual({ impact: null, verify: { url, status: 200, match: [] } });
    expect(() => parseDeclarations({ verify: { url: "https://evil.example/v1/messages/1", status: 200 } }, `https://${HOST}/v1/messages`))
      .toThrow(/own host/);
    for (const verify of [
      { url: `http://${HOST}/v1/messages/1`, status: 200 },
      { url: `https://{{input.host}}/v1/messages/1`, status: 200 },
      { url: `https://${HOST}/v1/{{input.rest:path}}`, status: 200 },
      { url: `https://${HOST}/v1/{{env.NAME}}`, status: 200 },
      { url: `https://${HOST}/v1/messages/1`, status: 99 },
      { url: `https://${HOST}/v1/messages/1`, status: 200, match: [{ path: "a..b", equals: 1 }] },
      { url: `https://${HOST}/v1/messages/1`, status: 200, match: [{ path: "a", equals: { nested: true } }] },
      { url: `https://${HOST}/v1/messages/1`, status: 200, match: [{ path: "a", equals: "id-{{response.id}}" }] },
      { url: `https://${HOST}/v1/messages/1`, status: 200, match: Array.from({ length: 11 }, () => ({ path: "a", equals: 1 })) },
      { url: `https://${HOST}/v1/messages/1`, status: 200, method: "POST" },
    ]) {
      expect(() => parseVerifyDeclaration(verify), JSON.stringify(verify)).toThrow(ValidationError);
    }
  });

  it("an action that declares nothing is not governed, and governed: true alone is", () => {
    expect(parseDeclarations({}, "https://{{input.host}}/anything")).toBeNull();
    expect(parseDeclarations({ governed: false }, "https://{{input.host}}/anything")).toBeNull();
    expect(parseDeclarations({ impact: null, verify: null }, `https://${HOST}/x`)).toBeNull();
    expect(parseDeclarations({ governed: true }, `https://${HOST}/x`)).toEqual({ impact: null, verify: null });
    expect(() => parseDeclarations({ governed: false, impact: { dimension: "emails", amount: "1", bound: "exact" } }, `https://${HOST}/x`))
      .toThrow(ValidationError);
  });

  it("refuses declarations on a definition whose host comes from an input", () => {
    for (const urlTemplate of [
      "https://{{input.host}}/v1/messages",
      "https://{{input.tenant}}.mailer.example/v1/messages",
      "https://api.mailer.example:{{input.port}}/v1/messages",
      "https://{{secret:HOST}}/v1/messages",
      "https://user:pass@api.mailer.example/v1/messages",
      "http://api.mailer.example/v1/messages",
      "/v1/messages",
    ]) {
      expect(() => parseDeclarations({ governed: true }, urlTemplate), urlTemplate).toThrow(ValidationError);
      expect(() => buildDeclaredAdapter(definition({ urlTemplate, declarations: { impact: null, verify: null } })), urlTemplate).toThrow(ValidationError);
    }
    expect(() => parseDeclarations({ governed: true }, "https://{{input.host}}/v1/messages")).toThrow(/fixed host/);
    expect(declaredHost("https://API.Mailer.example:8443/v1/{{input.id}}")).toEqual({ host: "api.mailer.example:8443", hostname: "api.mailer.example" });
  });
});

describe("amount expressions", () => {
  it("parses the four forms and one optional multiplication", () => {
    expect(parseAmountExpression("25")).toEqual({ term: { kind: "literal", value: 25 }, factor: null });
    expect(parseAmountExpression("input.order.quantity")).toEqual({ term: { kind: "input", path: "order.quantity" }, factor: null });
    expect(parseAmountExpression("count(input.to)")).toEqual({ term: { kind: "count", path: "to" }, factor: null });
    expect(parseAmountExpression("count( input.to ) * 2")).toEqual({ term: { kind: "count", path: "to" }, factor: 2 });
  });

  it("refuses everything outside the grammar", () => {
    for (const expression of [
      "", "-1", "1.5", "input", "input.", "input.a + 1", "2 * input.a", "input.a * input.b", "input.a * 2 * 3",
      "count(to)", "sum(input.to)", "input.a * -2", "input.a / 2", "input.a; drop", "payload.a", "count(input.to) * 1.5",
    ]) {
      expect(() => parseAmountExpression(expression), expression).toThrow(ValidationError);
    }
  });

  it("evaluates to a non-negative integer", () => {
    expect(evaluateAmount("7", {})).toBe(7);
    expect(evaluateAmount("input.quantity", { quantity: 3 })).toBe(3);
    expect(evaluateAmount("input.quantity * 100", { quantity: 3 })).toBe(300);
    expect(evaluateAmount("input.order.quantity", { order: { quantity: 0 } })).toBe(0);
    expect(evaluateAmount("count(input.to)", { to: [] })).toBe(0);
    expect(evaluateAmount("count(input.to) * 2", { to: ["a", "b", "c"] })).toBe(6);
  });

  it("an absent optional input yields no quantity, never zero", () => {
    expect(evaluateAmount("input.quantity", {})).toBeNull();
    expect(evaluateAmount("input.order.quantity * 5", { order: {} })).toBeNull();
    expect(evaluateAmount("count(input.to)", { cc: [] })).toBeNull();
    const impact = parseImpactDeclaration({ dimension: "emails", amount: "count(input.to)", bound: "exact" });
    expect(impactQuantity(impact, {})).toBeNull();
    expect(impactQuantity(impact, { to: ["a"] })).toEqual({ dimension: "emails", amount: 1, bound: "exact" });
  });

  it("a present but invalid value is refused", () => {
    for (const [expression, value] of [
      ["input.quantity", { quantity: "3" }],
      ["input.quantity", { quantity: 2.5 }],
      ["input.quantity", { quantity: -1 }],
      ["input.quantity", { quantity: null }],
      ["input.quantity", { quantity: Number.MAX_SAFE_INTEGER + 2 }],
      ["input.quantity * 999999999999999", { quantity: 999999999999999 }],
      ["count(input.to)", { to: "a@example.com" }],
      ["count(input.to)", { to: { length: 2 } }],
    ] as const) {
      expect(() => evaluateAmount(expression, value as Record<string, unknown>), `${expression} ${JSON.stringify(value)}`).toThrow(ValidationError);
    }
  });

  it("a declared unit draws from a limit in that unit, and an absent amount is unbounded under it", () => {
    const emails = { dimension: "emails", currency: null };
    expect(quantityFor(emails, { impact: [{ dimension: "emails", amount: 2, bound: "exact" }], dimensions: ["emails"] })).toBe(2);
    expect(quantityFor(emails, { impact: [], dimensions: ["emails"] })).toBeNull();
    expect(quantityFor({ dimension: "messages", currency: null }, { impact: [], dimensions: ["emails"] })).toBeUndefined();
    expect(quantityFor({ dimension: "money", currency: "usd" }, { impact: [{ dimension: "emails", amount: 2, bound: "exact" }], dimensions: ["emails"] })).toBeUndefined();
  });
});

describe("normalization", () => {
  it("is deterministic, whatever the key order of the input", () => {
    const def = definition();
    const a = normalize(def, input);
    const b = normalize(def, { campaign: "welcome", name: "Ada", to: ["a@example.com", "b@example.com"], list: "customers" });
    const digest = (op: typeof a) => requestDigest({ actionName: "send", adapterType: HTTP_DECLARED_TYPE, request: op.request, target: op.target as never });
    expect(digest(a)).toBe(digest(b));
    expect(canonicalDigest(a)).toBe(canonicalDigest(normalize(def, input)));
    expect(digest(normalize(def, { ...input, to: ["a@example.com"] }))).not.toBe(digest(a));
  });

  it("is deterministic when the input itself is the body", () => {
    const def = definition({ bodyTemplate: null });
    const digest = (value: Record<string, unknown>) => canonicalDigest(normalize(def, value).request);
    expect(digest({ list: "customers", to: ["a@example.com"], name: "Ada" })).toBe(digest({ name: "Ada", to: ["a@example.com"], list: "customers" }));
  });

  it("applies the input and leaves every secret reference as written", () => {
    const { request, target } = normalize(definition(), input);
    const normalized = request as unknown as DeclaredRequest;
    expect(normalized).toMatchObject({
      method: "POST",
      url: `https://${HOST}/v1/lists/customers/messages?key={{secret:MAILER_QUERY_KEY}}`,
      headers: { Authorization: "Bearer {{secret:MAILER_TOKEN}}", "X-Campaign": "welcome", "Content-Type": "application/json" },
      body: { to: ["a@example.com", "b@example.com"], subject: "Hello Ada", signature: "{{secret:MAILER_SIGNATURE}}" },
      bodyEncoding: "json",
      impact: [{ dimension: "emails", amount: 2, bound: "exact" }],
      verify: { url: `https://${HOST}/v1/messages/{{response.id}}`, status: 200, match: [{ path: "status", equals: "sent" }] },
    });
    expect(target).toMatchObject({ account: HOST, resourceKey: `http:${HOST}/v1/lists/customers/messages`, resourceId: "POST /v1/lists/customers/messages" });
  });

  it("never puts a secret value in the normalized request, whatever the input says", () => {
    const adapter = buildDeclaredAdapter(definition());
    const operation = adapter.normalize(adapter.parseConfig(definition()), input);
    const serialized = JSON.stringify({ operation, impact: adapter.describeImpact(operation), capabilities: adapter.capabilities });
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).toContain("{{secret:MAILER_TOKEN}}");
    expect(adapter.authHeaders(TOKEN)).toEqual({});
  });

  it("refuses an input that spells a secret reference, in any place a request is built from", () => {
    const def = definition();
    for (const value of [
      { ...input, name: "{{secret:MAILER_TOKEN}}" },
      { ...input, campaign: "x {{ secret:MAILER_TOKEN }}" },
      { ...input, to: ["{{secret:MAILER_TOKEN}}"] },
    ]) {
      expect(() => normalize(def, value), JSON.stringify(value)).toThrow(/secret reference/);
    }
    expect(() => normalize(definition({ bodyTemplate: null }), { ...input, note: { deep: "{{secret:MAILER_TOKEN}}" } })).toThrow(/secret reference/);
    for (const gap of ["\t", "\n", "\r", "\f", "\v", "\u00a0", "\u2028"]) {
      for (const ref of [`{{${gap}secret:MAILER_TOKEN}}`, `{{secret:MAILER_TOKEN${gap}}}`, `{{${gap}connection:gmail${gap}}}`]) {
        const spelled = JSON.stringify(ref);
        expect(() => normalize(definition({ bodyTemplate: null }), { ...input, note: ref }), spelled).toThrow(/secret reference/);
        expect(() => normalize(definition({ bodyTemplate: null }), { ...input, note: { deep: { deeper: ref } } }), spelled).toThrow(/secret reference/);
        expect(() => normalize(definition({ bodyTemplate: null }), { ...input, note: [ref] }), spelled).toThrow(/secret reference/);
        expect(() => normalize(definition({ bodyTemplate: null }), { ...input, [ref]: "x" }), spelled).toThrow(/secret reference/);
      }
    }
    const joined = definition({ headers: { "X-Joined": "{{input.a}}{{input.b}}" }, inputSchema: {} });
    expect(() => normalize(joined, { list: "l", to: [], a: "{{secret:", b: "MAILER_TOKEN}}" })).toThrow(/secret reference/);
    expect((normalize(def, { ...input, list: "{{secret:MAILER_TOKEN}}" }).request as unknown as DeclaredRequest).url)
      .toContain("/v1/lists/%7B%7Bsecret%3AMAILER_TOKEN%7D%7D/messages");
  });

  it("an input cannot move the request to another host or path", () => {
    const { request, target } = normalize(definition(), { ...input, list: "../../admin?x=1#" });
    expect((request as unknown as DeclaredRequest).url.startsWith(`https://${HOST}/v1/lists/..%2F..%2Fadmin%3Fx%3D1%23/messages`)).toBe(true);
    expect(target.account).toBe(HOST);
  });

  it("validates the input against the action's schema before anything else", () => {
    expect(() => normalize(definition(), { to: ["a@example.com"] })).toThrow(/Invalid input/);
    expect(() => normalize(definition(), { list: "customers", to: "a@example.com" })).toThrow(/Invalid input/);
  });

  it("an amount with nothing to read leaves the dimension declared and unbounded", () => {
    const def = definition({ inputSchema: {}, bodyTemplate: null });
    const adapter = buildDeclaredAdapter(def);
    const operation = adapter.normalize(adapter.parseConfig(def), { list: "customers" });
    expect(adapter.describeImpact(operation)).toEqual([]);
    expect(adapter.capabilities.impactDimensions).toEqual(["emails"]);
    expect(quantityFor({ dimension: "emails", currency: null }, { impact: adapter.describeImpact(operation), dimensions: adapter.capabilities.impactDimensions })).toBeNull();
  });

  it("sends no body for GET and DELETE, and a form body when the action asks for one", () => {
    const withoutBody = normalize(definition({ method: "DELETE", bodyTemplate: null }), input).request as unknown as DeclaredRequest;
    expect(withoutBody).toMatchObject({ body: null, bodyEncoding: null });
    expect(withoutBody.headers["Content-Type"]).toBeUndefined();
    const form = normalize(definition({ headers: { "Content-Type": "application/x-www-form-urlencoded" } }), input).request as unknown as DeclaredRequest;
    expect(form.bodyEncoding).toBe("form");
  });
});

describe("the verify rule", () => {
  const rule = parseVerifyDeclaration({
    url: `https://${HOST}/v1/lists/{{input.list}}/messages/{{response.id}}?key={{secret:MAILER_QUERY_KEY}}`,
    status: 200,
    match: [{ path: "status", equals: "sent" }, { path: "list", equals: "{{input.list}}" }, { path: "id", equals: "{{response.id}}" }],
  });

  it("applies the input at normalization and keeps response and secret references for later", () => {
    const normalized = normalizeVerify(rule, { list: "big customers" });
    expect(normalized).toEqual({
      url: `https://${HOST}/v1/lists/big%20customers/messages/{{response.id}}?key={{secret:MAILER_QUERY_KEY}}`,
      status: 200,
      match: [{ path: "status", equals: "sent" }, { path: "list", equals: "big customers" }, { path: "id", equalsResponse: "id" }],
    });
    expect(verifyNeedsResponse(rule)).toBe(true);
    expect(normalizedVerifyNeedsResponse(normalized)).toBe(true);
    expect(resolveVerifyUrl(normalized, { id: "msg/1" })).toBe(`https://${HOST}/v1/lists/big%20customers/messages/msg%2F1?key={{secret:MAILER_QUERY_KEY}}`);
    expect(resolveVerifyUrl(normalized, {})).toBeNull();
    expect(resolveVerifyUrl(normalized, null)).toBeNull();
  });

  it("an input that looks like a reference stays a literal", () => {
    const normalized = normalizeVerify(rule, { list: "{{response.id}}" });
    expect(normalized.url).toContain("/lists/%7B%7Bresponse.id%7D%7D/messages/{{response.id}}");
    expect(normalized.match[1]).toEqual({ path: "list", equals: "{{response.id}}" });
    expect(verifyMismatches(normalized, { status: 200, json: { status: "sent", list: "other", id: "m1" } }, { id: "m1" })).toEqual(["list"]);
  });

  it("refuses an input the rule reads and the caller left out", () => {
    expect(() => normalizeVerify(rule, {})).toThrow(/input\.list/);
    expect(() => normalizeVerify(rule, { list: { nested: true } })).toThrow(ValidationError);
  });

  it("matches on the status and every declared field, and names what differed without the values", () => {
    const normalized = normalizeVerify(rule, { list: "customers" });
    const response = { id: "m1" };
    expect(verifyMismatches(normalized, { status: 200, json: { status: "sent", list: "customers", id: "m1" } }, response)).toEqual([]);
    expect(verifyMismatches(normalized, { status: 404, json: null }, response)).toEqual(["status 404, expected 200"]);
    expect(verifyMismatches(normalized, { status: 200, json: { status: "queued", list: "customers", id: "m2" } }, response)).toEqual(["status", "id"]);
    expect(verifyMismatches(normalized, { status: 200, json: { status: "sent", list: "customers" } }, {})).toEqual(["id"]);
  });

  it("a rule that reads nothing from the response can run after a lost response", () => {
    const fromInput = parseVerifyDeclaration({ url: `https://${HOST}/v1/messages/{{input.id}}`, status: 200, match: [{ path: "data.0.id", equals: "{{input.id}}" }] });
    expect(verifyNeedsResponse(fromInput)).toBe(false);
    const normalized = normalizeVerify(fromInput, { id: "m1" });
    expect(normalizedVerifyNeedsResponse(normalized)).toBe(false);
    expect(verifyMismatches(normalized, { status: 200, json: { data: [{ id: "m1" }] } }, null)).toEqual([]);
  });

  it("a * segment matches any item of a list, and absent holds only when none does", () => {
    const added = normalizeVerify(parseVerifyDeclaration({
      url: `https://${HOST}/v1/issues/{{input.id}}`, status: 200,
      match: [{ path: "labels.*.name", equals: "{{input.label}}" }],
    }), { id: "7", label: "bug" });
    expect(verifyMismatches(added, { status: 200, json: { labels: [{ name: "ops" }, { name: "bug" }] } }, null)).toEqual([]);
    expect(verifyMismatches(added, { status: 200, json: { labels: [{ name: "ops" }] } }, null)).toEqual(["labels.*.name"]);
    expect(verifyMismatches(added, { status: 200, json: { labels: "bug" } }, null)).toEqual(["labels.*.name"]);

    const removed = normalizeVerify(parseVerifyDeclaration({
      url: `https://${HOST}/v1/issues/{{input.id}}`, status: 200,
      match: [{ path: "number", equals: 7 }, { path: "labels.*.name", equals: "{{input.label}}", absent: true }],
    }), { id: "7", label: "bug" });
    expect(verifyMismatches(removed, { status: 200, json: { number: 7, labels: [{ name: "ops" }] } }, null)).toEqual([]);
    expect(verifyMismatches(removed, { status: 200, json: { number: 7, labels: [{ name: "bug" }] } }, null)).toEqual(["labels.*.name"]);
  });

  it("a rule without absent keeps the shape, and so the digest, it had", () => {
    const rule = parseVerifyDeclaration({ url: `https://${HOST}/v1/messages/{{input.id}}`, status: 200, match: [{ path: "id", equals: "{{input.id}}", absent: false }] });
    expect(rule.match).toEqual([{ path: "id", equals: "{{input.id}}" }]);
    expect(normalizeVerify(rule, { id: "m1" }).match).toEqual([{ path: "id", equals: "m1" }]);
    expect(() => parseVerifyDeclaration({ url: `https://${HOST}/v1/x`, status: 200, match: [{ path: "id", equals: 1, absent: "yes" }] })).toThrow(ValidationError);
  });
});

describe("what a declared action claims", () => {
  it("lists honestly what it lacks, depending on what is declared", () => {
    const withResponseVerify = buildDeclaredAdapter(definition()).capabilities;
    expect(withResponseVerify).toMatchObject({
      idempotency: { supported: false, retentionSeconds: null },
      outcomeLookup: { supported: false },
      conditionalMutation: { supported: false },
      sameKeyReplay: { supported: false, windowSeconds: null },
      compensation: { supported: false },
      impactDimensions: ["emails"],
    });
    expect(withResponseVerify.unsupported).toEqual(expect.arrayContaining(["Provider idempotency", "Atomic stale-state protection", "Replay of a lost write"]));
    expect(withResponseVerify.unsupported.join(" ")).toMatch(/lost response/);

    const withoutVerify = buildDeclaredAdapter(definition({ declarations: { impact: null, verify: null } }));
    expect(withoutVerify.verify).toBeUndefined();
    expect(withoutVerify.capabilities.impactDimensions).toEqual([]);
    expect(withoutVerify.capabilities.unsupported.join(" ")).toMatch(/Read-back verification/);

    const fromInput = buildDeclaredAdapter(definition({
      declarations: { impact: null, verify: { url: `https://${HOST}/v1/messages/{{input.list}}`, status: 200, match: [] } },
    }));
    expect(fromInput.capabilities.outcomeLookup.supported).toBe(true);
    expect(fromInput.verify).toBeTypeOf("function");
  });

  it("writes nothing a reviewer reads with a semicolon or an em dash", () => {
    const adapter = buildDeclaredAdapter(definition());
    const text = JSON.stringify([adapter.capabilities, adapter.successDefinition, adapter.title]);
    expect(text).not.toMatch(/;|—/);
  });
});
