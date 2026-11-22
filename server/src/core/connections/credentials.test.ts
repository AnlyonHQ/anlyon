import { describe, expect, it } from "vitest";
import {
  accountHostFor,
  accountHostTemplate,
  assertAccountHost,
  composeCredential,
  integrationView,
  readCredentialInput,
  type IntegrationEntry,
} from "./catalogue.ts";
import { applyAccountHost, assertAccountHostOnlyInUrl, interpolateUrl, interpolateUrlWithStubbedSecrets, redactSecrets, usesAccountHost } from "../actions/template.ts";
import { isReadOnlyGraphqlQuery } from "../effects/graphql.ts";
import { normalizeVerify, parseVerifyDeclaration, resolveVerifyBody, normalizedVerifyNeedsResponse, declaredHost } from "../effects/declarations.ts";

const EMAIL = "^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\\.[A-Za-z]{2,63}$";
const TOKEN = "^[A-Za-z0-9_=-]{8,512}$";

const desk: IntegrationEntry = {
  id: "acmedesk",
  auth: {
    kind: "api_key",
    header: "Authorization",
    prefix: "Basic ",
    instructions: "A test entry: an email and an API token, on the account's own subdomain of the provider.",
    instructionsUrl: "https://example.com/keys",
    check: { url: "https://{{connection.host}}/api/v2/users/me.json" },
    account: { name: "subdomain", label: "Subdomain" },
    fields: [
      { name: "email", label: "Email", secret: false, pattern: EMAIL },
      { name: "apiToken", label: "API token", secret: true, pattern: TOKEN },
    ],
    encoding: { kind: "basic", username: "{email}/token", password: "{apiToken}" },
  },
  displayName: "AcmeDesk",
  hosts: { hostTemplate: "{subdomain}.acmedesk.com", from: "account.subdomain" },
  scopes: [],
  verificationStatus: "verified",
  exercised: false,
  reviewNote: "None.",
  operationsPack: null,
  workflowPacks: [],
};

const keyAsUser: IntegrationEntry = {
  ...desk,
  id: "keyuser",
  auth: {
    ...(desk.auth as Extract<IntegrationEntry["auth"], { kind: "api_key" }>),
    account: undefined,
    check: { url: "https://api.keyuser.example/v1/me" },
    fields: [{ name: "apiKey", label: "API key", secret: true, pattern: "^api_[A-Za-z0-9]{8,64}$" }],
    encoding: { kind: "basic", username: "{apiKey}", password: "" },
  },
  hosts: ["api.keyuser.example"],
};

const trelloLike: IntegrationEntry = {
  ...desk,
  id: "boards",
  auth: {
    kind: "api_key",
    header: "Authorization",
    prefix: "OAuth ",
    instructions: "A test entry: a key and a token sent in a provider's own documented header form.",
    instructionsUrl: "https://example.com/keys",
    check: { url: "https://api.boards.example/1/members/me" },
    fields: [
      { name: "key", label: "API key", secret: false, pattern: "^[0-9a-f]{32}$" },
      { name: "token", label: "Token", secret: true, pattern: "^[A-Za-z0-9]{32,256}$" },
    ],
    encoding: { kind: "template", template: 'oauth_consumer_key="{key}", oauth_token="{token}"' },
  },
  hosts: ["api.boards.example"],
};

const store: IntegrationEntry = {
  ...desk,
  id: "store",
  auth: {
    kind: "api_key",
    header: "X-Store-Access-Token",
    prefix: "",
    instructions: "A test entry: one token, on the store's own host.",
    instructionsUrl: "https://example.com/keys",
    check: { url: "https://{{connection.host}}/admin/shop.json" },
    account: { name: "store", label: "Store" },
    fields: [{ name: "accessToken", label: "Access token", secret: true, pattern: "^shpat_[a-f0-9]{32}$" }],
  },
  hosts: { hostTemplate: "{store}.mystore.example", from: "account.store" },
};

const TOKEN_VALUE = "tok_aaaaaaaaaaaaaaaa";
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("credential fields", () => {
  it("composes an email and an API token into HTTP Basic, as the entry declares", () => {
    const { stored, accountHost } = readCredentialInput(desk, { fields: { subdomain: "acme", email: "ana@acme.test", apiToken: TOKEN_VALUE } });
    expect(accountHost).toBe("acme.acmedesk.com");
    expect(JSON.parse(stored)).toEqual({ fields: { email: "ana@acme.test", apiToken: TOKEN_VALUE } });
    const composed = composeCredential(desk, stored);
    expect(composed.value).toBe(b64(`ana@acme.test/token:${TOKEN_VALUE}`));
    expect(composed.redact).toContain(TOKEN_VALUE);
    expect(composed.redact).toContain(`ana@acme.test/token:${TOKEN_VALUE}`);
    expect(composed.redact).not.toContain("ana@acme.test");
  });

  it("sends one key as the Basic username with an empty password", () => {
    const { stored } = readCredentialInput(keyAsUser, { fields: { apiKey: "api_aaaaaaaa" } });
    expect(composeCredential(keyAsUser, stored).value).toBe(b64("api_aaaaaaaa:"));
  });

  it("fills a provider's documented header form", () => {
    const key = "0".repeat(32);
    const token = "A".repeat(64);
    const { stored } = readCredentialInput(trelloLike, { fields: { key, token } });
    expect(composeCredential(trelloLike, stored).value).toBe(`oauth_consumer_key="${key}", oauth_token="${token}"`);
  });

  it("sends a one-field credential as it is", () => {
    const token = `shpat_${"a".repeat(32)}`;
    const { stored, accountHost } = readCredentialInput(store, { fields: { store: "acme", accessToken: token } });
    expect(accountHost).toBe("acme.mystore.example");
    expect(composeCredential(store, stored)).toEqual({ value: token, redact: [token] });
  });

  it("refuses apiKey for an entry with fields, missing and extra fields, and values that could break the header, without echoing them", () => {
    const ok = { subdomain: "acme", email: "ana@acme.test", apiToken: TOKEN_VALUE };
    expect(() => readCredentialInput(desk, { apiKey: TOKEN_VALUE })).toThrow(/fields/);
    expect(() => readCredentialInput(desk, { fields: { subdomain: "acme", email: "ana@acme.test" } })).toThrow(/API token/);
    expect(() => readCredentialInput(desk, { fields: { ...ok, password: "x" } })).toThrow(/does not take password/);
    for (const apiToken of [`${TOKEN_VALUE}\r\nX-Evil: 1`, `${TOKEN_VALUE} `, `${TOKEN_VALUE}"`, "short"]) {
      const error = (() => { try { readCredentialInput(desk, { fields: { ...ok, apiToken } }); } catch (e) { return e as Error; } return null; })();
      expect(error?.message, JSON.stringify(apiToken)).toMatch(/API token is not a valid/);
      expect(error?.message).not.toContain(TOKEN_VALUE);
    }
    expect(() => readCredentialInput(desk, { fields: { ...ok, email: "ana:x@acme.test" } })).toThrow(/Email is not a valid/);
    const github = { ...desk, auth: { kind: "api_key" as const, header: "Authorization", prefix: "Bearer ", instructions: "x".repeat(50), instructionsUrl: "https://example.com", check: { url: "https://api.github.com/user" } }, hosts: ["api.github.com"] };
    expect(readCredentialInput(github, { apiKey: "ghp_x" })).toEqual({ stored: "ghp_x", accountHost: null });
    expect(() => readCredentialInput(github, { fields: { apiKey: "ghp_x" } })).toThrow(/one key/);
  });

  it("checks every field again when it is composed, so a value rotated through PUT /secrets cannot reach the header unchecked", () => {
    expect(() => composeCredential(desk, "raw-token-not-fields")).toThrow(/Connect it again/);
    expect(() => composeCredential(desk, JSON.stringify({ fields: { email: "ana@acme.test", apiToken: "bad\r\nX: 1" } }))).toThrow(/not a valid/);
  });

  it("redacts the raw secret field from a provider's answer, not only the encoded header", () => {
    const { stored } = readCredentialInput(desk, { fields: { subdomain: "acme", email: "ana@acme.test", apiToken: TOKEN_VALUE } });
    const composed = composeCredential(desk, stored);
    const resolved = new Map<string, string>([["connection:acmedesk", composed.value], ...composed.redact.map((v, i) => [`connection:acmedesk#${i}`, v] as [string, string])]);
    const echoed = `{"auth":"Basic ${composed.value}","token":"${TOKEN_VALUE}","user":"ana@acme.test"}`;
    const out = redactSecrets(echoed, resolved);
    expect(out).not.toContain(TOKEN_VALUE);
    expect(out).not.toContain(composed.value);
    expect(out).toContain("ana@acme.test");
  });

  it("gives a connect form the fields' names and labels, never a pattern, the encoding, the header or the check", () => {
    const view = integrationView(desk);
    expect(view.auth).toMatchObject({ kind: "api_key", fields: [
      { name: "subdomain", label: "Subdomain", secret: false, kind: "account" },
      { name: "email", label: "Email", secret: false, kind: "credential" },
      { name: "apiToken", label: "API token", secret: true, kind: "credential" },
    ] });
    expect(view.hostTemplate).toBe("{subdomain}.acmedesk.com");
    const text = JSON.stringify(view);
    for (const hidden of ["pattern", "encoding", "/token", "Basic", "users/me"]) expect(text).not.toContain(hidden);
  });
});

describe("per-account hosts", () => {
  it("takes the label, or the whole host with exactly the entry's suffix", () => {
    expect(accountHostTemplate(desk)).toEqual({ param: "subdomain", suffix: ".acmedesk.com" });
    expect(accountHostFor(desk, "acme")).toBe("acme.acmedesk.com");
    expect(accountHostFor(desk, " ACME-support ")).toBe("acme-support.acmedesk.com");
    expect(accountHostFor(desk, "acme.acmedesk.com")).toBe("acme.acmedesk.com");
  });

  it.each([
    ["a lookalike suffix", "acme.acmedesk.com.evil.test"],
    ["a suffix with no dot", "evilacmedesk.com"],
    ["another domain", "evil.test"],
    ["a second label", "a.b"],
    ["a fragment", "evil.test#.acmedesk.com"],
    ["a path", "evil.test/.acmedesk.com"],
    ["userinfo", "evil.test@acme"],
    ["userinfo before the suffix", "x@evil.test.acmedesk.com"],
    ["a port", "acme:8443"],
    ["a port on the host", "acme.acmedesk.com:8443"],
    ["a scheme", "https://acme"],
    ["an IPv4 literal", "127.0.0.1"],
    ["an IPv6 literal", "[::1]"],
    ["punycode", "xn--80ak6aa92e"],
    ["a non-ASCII lookalike", "аcme"],
    ["a fullwidth dot", "acme．evil"],
    ["a percent escape", "%61cme"],
    ["a leading hyphen", "-acme"],
    ["a trailing hyphen", "acme-"],
    ["an empty value", ""],
    ["a long label", "a".repeat(64)],
    ["a backslash", "evil.test\\.acmedesk.com"],
    ["whitespace inside", "ac me"],
  ])("refuses %s at connect", (_why, value) => {
    expect(() => accountHostFor(desk, value)).toThrow();
  });

  it("checks a stored host against the template again at dispatch, whatever wrote it", () => {
    expect(assertAccountHost(desk, "acme.acmedesk.com")).toBe("acme.acmedesk.com");
    for (const host of ["evil.test", "acme.acmedesk.com.evil.test", "a.b.acmedesk.com", "ACME.acmedesk.com", "xn--80ak6aa92e.acmedesk.com", ".acmedesk.com", "acmedesk.com", null, undefined, 42]) {
      expect(() => assertAccountHost(desk, host), String(host)).toThrow(/not a AcmeDesk host|fixed hosts/);
    }
  });

  it("refuses a template that is not one label under the provider's own domain", () => {
    const bad = (hostTemplate: string) => ({ ...desk, hosts: { hostTemplate, from: "account.subdomain" } });
    expect(() => accountHostTemplate(bad("{subdomain}.com"))).toThrow();
    expect(() => accountHostTemplate(bad("{subdomain}"))).toThrow();
    expect(() => accountHostTemplate(bad("api.{subdomain}.acmedesk.com"))).toThrow();
    expect(() => accountHostTemplate(bad("{subdomain}acmedesk.com"))).toThrow();
  });

  it("puts {{connection.host}} only as the URL's whole host, filled from the account and never from an input", () => {
    const url = "https://{{connection.host}}/api/v2/tickets/{{input.id}}.json";
    expect(usesAccountHost(url)).toBe(true);
    expect(interpolateUrl(url, { id: "42" }, new Map(), "acme.acmedesk.com")).toBe("https://acme.acmedesk.com/api/v2/tickets/42.json");
    expect(interpolateUrl(url, { id: "{{connection.host}}" }, new Map(), "acme.acmedesk.com"))
      .toBe("https://acme.acmedesk.com/api/v2/tickets/%7B%7Bconnection.host%7D%7D.json");
    expect(() => interpolateUrl(url, { id: "1" }, new Map())).toThrow(/needs a connected account/);
    expect(() => interpolateUrlWithStubbedSecrets(url, { id: "1" }, null)).toThrow(/needs a connected account/);
    expect(() => applyAccountHost(url, "evil.test:8443")).toThrow();
    expect(() => applyAccountHost(url, "evil.test/x")).toThrow();
    for (const misplaced of [
      "https://api.example.com/{{connection.host}}/x",
      "https://x.{{connection.host}}/",
      "https://{{connection.host}}.evil.test/",
      "https://{{connection.host}}:8443/",
      "https://user@{{connection.host}}/",
      "http://{{connection.host}}/",
      "https://{{connection.host}}/?next={{connection.host}}",
    ]) {
      expect(() => usesAccountHost(misplaced), misplaced).toThrow(/whole host/);
    }
    expect(() => assertAccountHostOnlyInUrl({ "X-Host": "{{connection.host}}" })).toThrow(/only be the host/);
    expect(() => assertAccountHostOnlyInUrl(null, { url: "https://{{connection.host}}/" })).toThrow(/only be the host/);
    expect(declaredHost(url).host).toBe("{{connection.host}}");
  });
});

describe("GraphQL as a read", () => {
  it("accepts a fixed query and refuses anything that could write or be filled in", () => {
    expect(isReadOnlyGraphqlQuery("query Issue($id: String!) { issue(id: $id) { id title } }")).toBe(true);
    expect(isReadOnlyGraphqlQuery("{ viewer { id } }")).toBe(true);
    expect(isReadOnlyGraphqlQuery("# who\nquery { me { id } }")).toBe(true);
    for (const query of [
      "mutation { issueDelete(id: \"1\") { success } }",
      "MUTATION { x }",
      "subscription { issueCreated { id } }",
      "query { a } mutation B { b }",
      "{ a } # mutation",
      "query { issue(id: \"{{input.id}}\") { id } }",
      "fragment F on Issue { id }",
      "",
      "x".repeat(10_001),
    ]) {
      expect(isReadOnlyGraphqlQuery(query), query.slice(0, 40)).toBe(false);
    }
  });

  it("refuses a mutation as a read-back, and posts only the fixed query with variables from the call", () => {
    const base = { url: "https://api.linear.app/graphql", status: 200, match: [{ path: "data.issue.title", equals: "{{input.title}}" }] };
    expect(() => parseVerifyDeclaration({ ...base, graphql: { query: "mutation { issueUpdate(id: \"1\", input: {}) { success } }" } })).toThrow(/read-only GraphQL query/);
    expect(() => parseVerifyDeclaration({ ...base, graphql: { query: "query { issue(id: \"{{response.id}}\") { id } }" } })).toThrow(/read-only GraphQL query/);
    expect(() => parseVerifyDeclaration({ ...base, graphql: { query: "query { a }", variables: { id: "x {{input.id}}" } } })).toThrow(/exactly one/);
    expect(() => parseVerifyDeclaration({ ...base, graphql: { query: "query { a }", extra: 1 } })).toThrow(/does not accept/);

    const rule = parseVerifyDeclaration({
      ...base,
      graphql: { query: "query($id: String!) { issue(id: $id) { title } }", variables: { id: "{{response.data.issueCreate.issue.id}}", first: 1 } },
    });
    const normalized = normalizeVerify(rule, { title: "Hello" });
    expect(normalizedVerifyNeedsResponse(normalized)).toBe(true);
    const response = { data: { issueCreate: { issue: { id: "abc-1" } } } };
    expect(resolveVerifyBody(normalized, response)).toEqual({ query: "query($id: String!) { issue(id: $id) { title } }", variables: { id: "abc-1", first: 1 } });
    expect(resolveVerifyBody(normalized, {})).toBeNull();
    expect("graphql" in normalizeVerify(parseVerifyDeclaration(base), { title: "x" })).toBe(false);
  });
});
