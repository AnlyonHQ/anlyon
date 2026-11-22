import { describe, it, expect, vi, beforeEach } from "vitest";
import { crmLike, githubLike, stripeLike } from "./support/openapi-fixtures.ts";

const createAction = vi.fn();

vi.mock("../src/core/actions/service.ts", () => ({
  createAction: (...args: unknown[]) => createAction(...args),
  countActions: async () => 0,
  UNSCOPED_AUTHORITY: { scopes: null },
}));
vi.mock("../src/core/actions/secrets.ts", () => ({ getSecretMetadata: async () => ({ name: "API_TOKEN" }) }));
vi.mock("../src/db/index.ts", () => ({
  db: { select: () => ({ from: () => ({ where: async () => [{ id: "ws_1", plan: "paygo" }] }) }) },
}));
vi.mock("../src/lib/logger.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/logger.ts")>()),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { importActionsFromOpenApi } = await import("../src/core/actions/import.ts");
const { suggestAllowedHosts } = await import("../src/core/actions/import-suggestions.ts");
const { parseImpactDeclaration } = await import("../src/core/effects/declarations.ts");

type Spec = Record<string, unknown>;

beforeEach(() => {
  createAction.mockReset();
  createAction.mockImplementation(async (_ws: string, input: Record<string, unknown>) => ({ ...input, id: "act_1" }));
});

async function preview(spec: Spec) {
  const result = await importActionsFromOpenApi("ws_1", spec, { dryRun: true });
  return { result, by: Object.fromEntries(result.created.map((a) => [a.name, a])) };
}

function classes(created: Array<{ name: string; suggestion: { risk: string; requiresApproval: boolean } }>) {
  return Object.fromEntries(created.map((a) => [a.name, [a.suggestion.risk, a.suggestion.requiresApproval]]));
}

describe("a Stripe-like spec", () => {
  it("imports every operation and classifies each one", async () => {
    const { result } = await preview(stripeLike);
    expect(result.skipped).toEqual([]);
    expect(classes(result.created)).toEqual({
      GetCharges: ["read", false],
      PostCharges: ["irreversible", true],
      PostChargesCharge: ["write", false],
      PostChargesChargeCapture: ["irreversible", true],
      PostRefunds: ["irreversible", true],
      PostPayouts: ["irreversible", true],
      PostTransfers: ["irreversible", true],
      PostPaymentMethods: ["write", false],
      PostCustomers: ["write", false],
      DeleteCustomersCustomer: ["destructive", true],
      PostInvoicesInvoicePay: ["irreversible", true],
      PostInvoicesInvoiceVoid: ["destructive", true],
      DeleteSubscriptionsSubscriptionExposedId: ["destructive", true],
    });
  });

  it("suggests money from an integer amount in minor units, and leaves an input currency to the person", async () => {
    const { by } = await preview(stripeLike);
    expect(by.PostCharges.suggestion.impact).toEqual({ dimension: "money", unit: null, amount: "input.amount", bound: "exact" });
    expect(by.PostCharges.suggestion.impactNote).toMatch(/minor units/);
    expect(by.PostCharges.suggestion.impactNote).toMatch(/choose the one currency/);
    expect(by.PostCharges.suggestion.reasons.join(" ")).toMatch(/an amount \(input\.amount\) and a currency/);
    expect(by.PostRefunds.suggestion.impactNote).toMatch(/amount is optional/);
    expect(by.PostPayouts.suggestion.impactNote).not.toMatch(/optional/);
    expect(by.PostChargesChargeCapture.suggestion.impact).toMatchObject({ dimension: "money", amount: "input.amount", unit: null });
  });

  it("does not read an update of one charge, or a payment method, as moving money", async () => {
    const { by } = await preview(stripeLike);
    expect(by.PostChargesCharge.suggestion.impact).toEqual({ dimension: "resource_mutations", unit: "resource_mutations", amount: "1", bound: "exact" });
    expect(by.PostPaymentMethods.suggestion.reasons).toEqual(["POST changes something."]);
    expect(by.PostInvoicesInvoicePay.suggestion.impact).toMatchObject({ dimension: "resource_mutations", amount: "1" });
  });

  it("explains a destructive class by the words that set it", async () => {
    const { by } = await preview(stripeLike);
    expect(by.PostInvoicesInvoiceVoid.suggestion.reasons.join(" ")).toMatch(/"void"/);
    expect(by.DeleteSubscriptionsSubscriptionExposedId.suggestion.reasons).toContain("DELETE removes the resource.");
  });
});

describe("a GitHub-like spec", () => {
  it("classifies each operation", async () => {
    const { result } = await preview(githubLike);
    expect(result.skipped).toEqual([]);
    expect(classes(result.created)).toEqual({
      "issues-list-for-repo": ["read", false],
      "issues-create": ["write", false],
      "issues-update": ["write", false],
      "issues-create-comment": ["write", false],
      "pulls-merge": ["irreversible", true],
      "repos-transfer": ["irreversible", true],
      "repos-delete": ["destructive", true],
      "git-delete-ref": ["destructive", true],
      "users-add-email-for-authenticated-user": ["write", false],
    });
  });

  it("suggests no impact for a read, and one change for a merge", async () => {
    const { by } = await preview(githubLike);
    expect(by["issues-list-for-repo"].suggestion.impact).toBeNull();
    expect(by["pulls-merge"].suggestion.impact).toMatchObject({ dimension: "resource_mutations", amount: "1" });
    expect(by["pulls-merge"].suggestion.reasons.join(" ")).toMatch(/"merge"/);
  });
});

describe("a CRM spec", () => {
  it("classifies each operation", async () => {
    const { result } = await preview(crmLike);
    expect(result.skipped).toEqual([]);
    expect(classes(result.created)).toEqual({
      "get-crm-v3-objects-contacts_getPage": ["read", false],
      "post-crm-v3-objects-contacts_create": ["write", false],
      "patch-crm-v3-objects-contacts-contactId-_update": ["write", false],
      "delete-crm-v3-objects-contacts-contactId-_archive": ["destructive", true],
      "post-crm-v3-objects-contacts-batch-create_create": ["write", false],
      "post-crm-v3-objects-contacts-batch-archive_archive": ["destructive", true],
      "post-crm-v3-objects-deals_create": ["write", false],
      "post-crm-v3-objects-emails_create": ["write", false],
      "post-marketing-v3-transactional-single-email-send_sendEmail": ["irreversible", true],
    });
  });

  it("counts a batch by its entries, and a send in emails", async () => {
    const { by } = await preview(crmLike);
    expect(by["post-crm-v3-objects-contacts-batch-create_create"].suggestion.impact).toEqual({
      dimension: "resource_mutations", unit: "resource_mutations", amount: "count(input.inputs)", bound: "exact",
    });
    expect(by["post-crm-v3-objects-contacts-batch-archive_archive"].suggestion.impact?.amount).toBe("count(input.inputs)");
    const send = by["post-marketing-v3-transactional-single-email-send_sendEmail"].suggestion;
    expect(send.impact).toEqual({ dimension: "emails", unit: "emails", amount: "1", bound: "exact" });
    expect(send.reasons.join(" ")).toMatch(/input\.message\.to/);
    expect(send.impactNote).toMatch(/cc and bcc are not counted/);
  });
});

describe("every suggested impact", () => {
  it("is one an action accepts once a money currency is chosen", async () => {
    for (const spec of [stripeLike, githubLike, crmLike]) {
      const { result } = await preview(spec);
      for (const { name, suggestion } of result.created) {
        if (!suggestion.impact) continue;
        const impact = { ...suggestion.impact, unit: suggestion.impact.unit ?? "usd" };
        expect(() => parseImpactDeclaration(impact), name).not.toThrow();
      }
    }
  });
});

describe("request fields and vendor extensions", () => {
  const base = (operation: Record<string, unknown>, method = "post", path = "/things") => ({
    openapi: "3.0.3",
    info: { title: "T", version: "1" },
    servers: [{ url: "https://api.example.com" }],
    paths: { [path]: { [method]: { operationId: "op", ...operation } } },
  });
  const body = (properties: Record<string, unknown>, required: string[] = []) => ({
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties, required } } } },
  });
  const suggestion = async (spec: Spec) => (await preview(spec)).result.created[0].suggestion;

  it("counts one message per recipient in a `to` list", async () => {
    const s = await suggestion(base(body({ to: { type: "array", items: { type: "string" } }, text: { type: "string" } }), "post", "/messages"));
    expect(s).toMatchObject({ risk: "irreversible", requiresApproval: true, impact: { dimension: "messages", amount: "count(input.to)" } });
  });

  it("fixes the currency when the spec allows only one, and reads a nested amount", async () => {
    const s = await suggestion(base(body({
      amount_money: { type: "object", properties: { amount: { type: "integer" }, currency: { type: "string", enum: ["USD"] } } },
    }, ["amount_money"]), "post", "/payments"));
    expect(s.impact).toEqual({ dimension: "money", unit: "usd", amount: "input.amount_money.amount", bound: "exact" });
    expect(s.impactNote).not.toMatch(/choose the one currency/);
  });

  it("does not count a decimal amount as money", async () => {
    const s = await suggestion(base(body({ amount: { type: "number" }, currency: { type: "string" } }), "post", "/payments"));
    expect(s.risk).toBe("irreversible");
    expect(s.impact).toMatchObject({ dimension: "resource_mutations", amount: "1" });
    expect(s.impactNote).toMatch(/is a number/);
  });

  it("takes x-anlyon-risk and x-anlyon-impact as written", async () => {
    const s = await suggestion(base({
      "x-anlyon-risk": "irreversible",
      "x-anlyon-impact": { dimension: "rows", amount: "count(input.rows)", bound: "upper_bound" },
      ...body({ rows: { type: "array", items: { type: "object", properties: {} } } }),
    }, "post", "/rows"));
    expect(s.risk).toBe("irreversible");
    expect(s.requiresApproval).toBe(true);
    expect(s.impact).toEqual({ dimension: "rows", unit: "rows", amount: "count(input.rows)", bound: "upper_bound" });
  });

  it("never suggests a class below what the method implies, whatever the spec declares", async () => {
    for (const operation of [{ "x-anlyon-risk": "read" }, { "x-anlyon-risk": "write" }, { "x-read-only": true }, { "x-mcp": { readOnlyHint: true } }]) {
      const s = await suggestion(base(operation, "delete"));
      expect(s.risk).toBe("destructive");
      expect(s.requiresApproval).toBe(true);
      expect(s.impact).not.toBeNull();
    }
    for (const method of ["post", "put", "patch"]) {
      const s = await suggestion(base({ "x-anlyon-risk": "read" }, method));
      expect(s.risk).toBe("write");
      expect(s.impact).not.toBeNull();
      expect(s.reasons.join(" ")).toMatch(/at least write, whatever the spec declares/);
    }
    expect((await suggestion(base({ "x-anlyon-risk": "destructive" }, "post"))).risk).toBe("destructive");
    expect((await suggestion(base({ "x-anlyon-risk": "read" }, "get"))).risk).toBe("read");
  });

  it("ignores an invalid x-anlyon-impact and says so", async () => {
    const s = await suggestion(base({ "x-anlyon-impact": { dimension: "money", amount: "input.amount", bound: "exact" } }));
    expect(s.impact).toMatchObject({ dimension: "resource_mutations" });
    expect(s.reasons.join(" ")).toMatch(/x-anlyon-impact was ignored/);
  });

  it("follows read-only and destructive hints, including MCP's", async () => {
    const search = await suggestion(base({ "x-read-only": true }, "post", "/search"));
    expect(search.risk).toBe("write");
    expect(search.reasons).toContain("The spec marks it read-only.");
    expect((await suggestion(base({ "x-mcp": { destructiveHint: true } }, "post", "/reset"))).risk).toBe("destructive");
    expect((await suggestion(base({ "x-read-only": true }, "post", "/refunds"))).risk).toBe("irreversible");
  });

  it("gives the same suggestion for the same spec", async () => {
    const one = (await preview(stripeLike)).result.created.map((a) => a.suggestion);
    const two = (await preview(stripeLike)).result.created.map((a) => a.suggestion);
    expect(two).toEqual(one);
  });
});

describe("suggested allowed hosts", () => {
  it("lists the called host first, then the spec's servers, with a variable subdomain as a suffix", () => {
    expect(suggestAllowedHosts("https://api.example.com/v1", [
      { url: "https://api.example.com/v1" },
      { url: "https://sandbox.example.com:8443/v1" },
      { url: "https://{subdomain}.zendesk.com/api/v2" },
      { url: "/relative" },
      { url: "http://localhost:3000" },
      { url: "https://{region}.{env}.example.net" },
    ])).toEqual(["api.example.com", "sandbox.example.com", ".zendesk.com"]);
  });

  it("is reported with the import", async () => {
    expect((await preview(stripeLike)).result.suggestedAllowedHosts).toEqual(["api.stripe.com"]);
  });
});

describe("choosing per operation", () => {
  const money = { dimension: "money", unit: "usd", amount: "input.amount", bound: "exact" as const };

  it("applies nothing it was not asked to: the defaults hold whatever is suggested", async () => {
    const result = await importActionsFromOpenApi("ws_1", stripeLike, { only: ["PostCharges"] });
    expect(result.created[0].suggestion.requiresApproval).toBe(true);
    expect(result.created[0]).toMatchObject({
      customized: false,
      requiresApproval: false,
      impact: { dimension: "resource_mutations", amount: "1", bound: "exact" },
    });
    expect(createAction.mock.calls[0][1]).toMatchObject({ requiresApproval: false, impact: { dimension: "resource_mutations" } });
  });

  it("applies an accepted suggestion to the action it creates, by operationId or by METHOD /path", async () => {
    const result = await importActionsFromOpenApi("ws_1", stripeLike, {
      only: ["PostCharges", "PostCustomers"],
      operations: {
        PostCharges: { requiresApproval: true, impact: money },
        "POST /v1/customers": { requiresApproval: true },
      },
    });
    const by = Object.fromEntries(result.created.map((a) => [a.name, a]));
    expect(by.PostCharges).toMatchObject({ customized: true, governed: true, requiresApproval: true, impact: money });
    expect(by.PostCustomers).toMatchObject({ customized: true, requiresApproval: true, impact: { dimension: "resource_mutations" } });
    const inputs = Object.fromEntries(createAction.mock.calls.map((call) => [call[1].name, call[1]]));
    expect(inputs.PostCharges).toMatchObject({ requiresApproval: true, impact: money });
    expect(inputs.PostCustomers.requiresApproval).toBe(true);
  });

  it("imports an operation ungoverned when its impact is chosen as null", async () => {
    const result = await importActionsFromOpenApi("ws_1", stripeLike, {
      only: ["PostCustomers"],
      operations: { PostCustomers: { impact: null } },
    });
    expect(result.created[0]).toMatchObject({ governed: false, impact: null, proposedVerify: null });
    expect(createAction.mock.calls[0][1].impact).toBeUndefined();
  });

  it("an operation's choice of approval wins over the import-wide flag, either way", async () => {
    const result = await importActionsFromOpenApi("ws_1", githubLike, {
      dryRun: true,
      requiresApproval: true,
      only: ["issues/create", "pulls/merge"],
      operations: { "issues/create": { requiresApproval: false } },
    });
    const by = Object.fromEntries(result.created.map((a) => [a.name, a]));
    expect(by["issues-create"].requiresApproval).toBe(false);
    expect(by["pulls-merge"].requiresApproval).toBe(true);
  });

  it("refuses, before creating anything, a choice for an operation the spec does not have", async () => {
    await expect(importActionsFromOpenApi("ws_1", stripeLike, { operations: { PostNothing: { requiresApproval: true } } }))
      .rejects.toThrow(/"PostNothing", which is not an operation in this spec/);
    expect(createAction).not.toHaveBeenCalled();
  });

  it("refuses an impact an action would not accept, such as money with no currency", async () => {
    await expect(importActionsFromOpenApi("ws_1", stripeLike, {
      operations: { PostCharges: { impact: { dimension: "money", amount: "input.amount", bound: "exact" } } },
    })).rejects.toThrow(/operations\["PostCharges"\]: impact.unit must be one lowercase ISO currency/);
    expect(createAction).not.toHaveBeenCalled();
  });

  it("refuses an operation named twice", async () => {
    await expect(importActionsFromOpenApi("ws_1", stripeLike, {
      operations: { PostCharges: { requiresApproval: true }, "POST /v1/charges": { requiresApproval: false } },
    })).rejects.toThrow(/twice/);
  });

  it("skips, with the reason, an operation given an impact in an ungoverned import", async () => {
    const result = await importActionsFromOpenApi("ws_1", stripeLike, {
      governed: false,
      only: ["PostCharges"],
      operations: { PostCharges: { impact: money } },
    });
    expect(result.created).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/governed: false/);
  });
});
