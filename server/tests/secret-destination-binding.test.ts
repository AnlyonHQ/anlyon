import { describe, it, expect, vi, beforeEach } from "vitest";

const loadSecretPolicies = vi.fn();
const insertReturning = vi.fn();
const selectWhere = vi.fn();

vi.mock("../src/core/actions/secrets.ts", () => ({
  loadSecretPolicies: (...a: unknown[]) => loadSecretPolicies(...a),
  resolveSecrets: vi.fn(),
}));

vi.mock("../src/core/billing/usage-enforcement.ts", () => ({
  checkActionQuota: vi.fn(),
  checkActionInvokeQuota: vi.fn(),
}));

const versionTx = {
  select: () => ({ from: () => ({ where: () => selectWhere() }) }),
  insert: () => ({
    values: () => Object.assign(Promise.resolve(undefined), { returning: () => insertReturning() }),
  }),
  update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
};

vi.mock("../src/db/index.ts", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => selectWhere() }) }),
    insert: () => ({ values: () => ({ returning: () => insertReturning() }) }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(versionTx),
  },
}));

vi.mock("../src/lib/logger.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/logger.ts")>()),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { createAction } = await import("../src/core/actions/service.ts");
const { ValidationError } = await import("../src/utils/errors.ts");

const ENV = "env_1";
const WS = "ws_1";
const AUTHOR = { scopes: ["actions:write", "secrets:read"] };

function stripeOnly(over: Record<string, unknown> = {}) {
  return new Map([
    [
      "STRIPE_KEY",
      { name: "STRIPE_KEY", allowedHosts: [".stripe.com"], allowedPlacements: ["header"], ...over },
    ],
  ]);
}

function definition(over: Record<string, unknown> = {}) {
  return {
    name: "charge",
    urlTemplate: "https://api.stripe.com/v1/charges",
    headers: { Authorization: "Bearer {{secret:STRIPE_KEY}}" } as Record<string, unknown>,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectWhere.mockResolvedValue([]);
  insertReturning.mockResolvedValue([
    {
      actionId: "act_1",
      name: "charge",
      description: null,
      method: "POST",
      urlTemplate: "https://api.stripe.com/v1/charges",
      headers: {},
      bodyTemplate: null,
      inputSchema: {},
      requiresApproval: false,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
});

describe("allowed hosts", () => {
  it("allows the host the secret is for", async () => {
    loadSecretPolicies.mockResolvedValue(stripeOnly());

    await expect(createAction(WS, definition(), AUTHOR, ENV)).resolves.toMatchObject({
      id: "act_1",
    });
  });

  it("refuses a different host  the exfiltration this closes", async () => {
    loadSecretPolicies.mockResolvedValue(stripeOnly());

    await expect(
      createAction(
        WS,
        definition({ urlTemplate: "https://attacker.example/collect" }),
        AUTHOR,
        ENV
      )
    ).rejects.toThrow(ValidationError);
  });

  it("names the allowed hosts so the fix is obvious", async () => {
    loadSecretPolicies.mockResolvedValue(stripeOnly());

    await expect(
      createAction(WS, definition({ urlTemplate: "https://attacker.example/x" }), AUTHOR, ENV)
    ).rejects.toThrow(/\.stripe\.com/);
  });

  it("anchors the subdomain wildcard, so a lookalike suffix does not pass", async () => {
    loadSecretPolicies.mockResolvedValue(stripeOnly());

    await expect(
      createAction(
        WS,
        definition({ urlTemplate: "https://api.stripe.com.evil.test/v1/charges" }),
        AUTHOR,
        ENV
      )
    ).rejects.toThrow(ValidationError);
  });

  it("treats an unconstrained secret as allowed anywhere, as it always was", async () => {
    loadSecretPolicies.mockResolvedValue(
      new Map([["STRIPE_KEY", { name: "STRIPE_KEY", allowedHosts: null, allowedPlacements: null }]])
    );

    await expect(
      createAction(WS, definition({ urlTemplate: "https://anywhere.example/x" }), AUTHOR, ENV)
    ).resolves.toMatchObject({ id: "act_1" });
  });
});

describe("allowed placements", () => {
  it("refuses a header-only secret smuggled into the URL", async () => {
    loadSecretPolicies.mockResolvedValue(stripeOnly());

    await expect(
      createAction(
        WS,
        definition({
          urlTemplate: "https://api.stripe.com/v1/charges?k={{secret:STRIPE_KEY}}",
          headers: {},
        }),
        AUTHOR,
        ENV
      )
    ).rejects.toThrow(/not the url/);
  });

  it("refuses a header-only secret placed in the body", async () => {
    loadSecretPolicies.mockResolvedValue(stripeOnly());

    await expect(
      createAction(
        WS,
        definition({ headers: {}, bodyTemplate: { key: "{{secret:STRIPE_KEY}}" } }),
        AUTHOR,
        ENV
      )
    ).rejects.toThrow(/not the body/);
  });

  it("allows the placement the secret is meant for", async () => {
    loadSecretPolicies.mockResolvedValue(stripeOnly());

    await expect(createAction(WS, definition(), AUTHOR, ENV)).resolves.toMatchObject({
      id: "act_1",
    });
  });
});

describe("connected accounts are always bound", () => {
  it("a connection secret cannot be created without hosts, or with a host that is not a bare hostname", async () => {
    const { putConnectionSecret } = await vi.importActual<typeof import("../src/core/actions/secrets.ts")>("../src/core/actions/secrets.ts");
    const input = { integrationId: "hubspot", connectionId: "c-1" };
    await expect(putConnectionSecret(WS, "HUBSPOT", { ...input, allowedHosts: [] }, ENV)).rejects.toBeInstanceOf(ValidationError);
    await expect(putConnectionSecret(WS, "HUBSPOT", { ...input, allowedHosts: [".hubapi.com"] }, ENV)).rejects.toBeInstanceOf(ValidationError);
    await expect(putConnectionSecret(WS, "HUBSPOT", { ...input, allowedHosts: ["https://api.hubapi.com"] }, ENV)).rejects.toBeInstanceOf(ValidationError);
  });
});
