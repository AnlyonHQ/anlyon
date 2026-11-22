import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  caller: { authType: "apiKey", scopes: [] as string[], userId: undefined as string | undefined },
  role: "admin",
  enabled: true,
  service: {
    listSecretStores: vi.fn(async () => []),
    getSecretStore: vi.fn(async () => ({ name: "prod-vault" })),
    createSecretStore: vi.fn(async () => ({ name: "prod-vault" })),
    updateSecretStore: vi.fn(async () => ({ name: "prod-vault" })),
    deleteSecretStore: vi.fn(async () => undefined),
    checkSecretStore: vi.fn(async () => ({ name: "prod-vault" })),
    getSecretStoreSettings: vi.fn(async () => ({ allowPrivateNetwork: false })),
    updateSecretStoreSettings: vi.fn(async () => ({ allowPrivateNetwork: true })),
  },
}));

vi.mock("../governance-gate.ts", () => ({ signOffIfLoosening: async () => null, isHumanPresent: () => true }));
vi.mock("../middleware/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../middleware/auth.ts")>();
  return {
    ...actual,
    requireApiKey: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
      c.set("authType", mocks.caller.authType);
      c.set("apiKeyScopes", mocks.caller.scopes);
      c.set("workspaceId", WORKSPACE_ID);
      c.set("environmentId", ENVIRONMENT_ID);
      if (mocks.caller.userId) c.set("userId", mocks.caller.userId);
      await next();
    },
  };
});
vi.mock("../middleware/rateLimit.ts", () => ({ rateLimitByWorkspace: async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock("../../core/workspace/service.ts", () => ({ getWorkspace: async () => ({ role: mocks.role }) }));
vi.mock("../../core/workspace/roles.ts", () => ({
  resolveMemberRole: async () => ({ workspaceRole: mocks.role, role: mocks.role, grantedInEnvironmentId: null }),
}));
vi.mock("../../core/edition/features.ts", () => ({ isFeatureEnabled: () => mocks.enabled }));
vi.mock("../../core/secret-stores/service.ts", () => ({ BYO_VAULT_FEATURE: "byo_vault", ...mocks.service }));

const { default: secretStoresRouter, secretStoreSettingsRouter } = await import("./secret-stores.ts");
const { buildErrorResponse } = await import("../middleware/error.ts");
const { DEFAULT_API_KEY_SCOPES, PRIVILEGED_API_KEY_SCOPES } = await import("../../core/auth/api-key-scopes.ts");
const { OAUTH_SCOPE_GROUPS } = await import("../../core/auth/oauth-scopes.ts");

const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/secret-stores", secretStoresRouter);
app.route("/secret-store-settings", secretStoreSettingsRouter);

type Route = { method: string; path: string; body?: unknown };
const CREATE_BODY = {
  name: "prod-vault", type: "hashicorp_vault",
  config: { address: "https://vault.example.com", auth: "token" }, credential: { token: "<your-vault-token>" },
};
const READS: Route[] = [
  { method: "GET", path: "/secret-stores" },
  { method: "GET", path: "/secret-stores/prod-vault" },
  { method: "GET", path: "/secret-store-settings" },
];
const WRITES: Route[] = [
  { method: "POST", path: "/secret-stores", body: CREATE_BODY },
  { method: "PATCH", path: "/secret-stores/prod-vault", body: { cacheTtlSeconds: 0 } },
  { method: "POST", path: "/secret-stores/prod-vault/check" },
  { method: "DELETE", path: "/secret-stores/prod-vault" },
  { method: "PUT", path: "/secret-store-settings", body: { allowPrivateNetwork: true } },
];

function call(caller: { authType: string; scopes: string[]; userId?: string }, route: Route) {
  mocks.caller = { ...caller, userId: caller.userId };
  return app.request(route.path, {
    method: route.method,
    headers: { "Content-Type": "application/json" },
    ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
  });
}

async function statuses(caller: { authType: string; scopes: string[]; userId?: string }, routes: Route[]) {
  const out: number[] = [];
  for (const route of routes) out.push((await call(caller, route)).status);
  return out;
}

beforeEach(() => {
  mocks.role = "admin";
  mocks.enabled = true;
  for (const fn of Object.values(mocks.service)) fn.mockClear();
});

describe("secret store scopes", () => {
  it("are privileged, in no default and no OAuth consent group", () => {
    for (const scope of ["secret-stores:read", "secret-stores:write"] as const) {
      expect(PRIVILEGED_API_KEY_SCOPES).toContain(scope);
      expect(DEFAULT_API_KEY_SCOPES).not.toContain(scope);
      expect(Object.values(OAUTH_SCOPE_GROUPS).some((group) => (group.scopes as readonly string[]).includes(scope))).toBe(false);
    }
  });

  it("refuse a key that holds only secrets:* on every route", async () => {
    const key = { authType: "apiKey", scopes: ["secrets:read", "secrets:write"] };
    expect(await statuses(key, [...READS, ...WRITES])).toEqual(Array(READS.length + WRITES.length).fill(403));
    expect(mocks.service.createSecretStore).not.toHaveBeenCalled();
  });

  it("let secret-stores:read read, and nothing more", async () => {
    const key = { authType: "apiKey", scopes: ["secret-stores:read"] };
    expect(await statuses(key, READS)).toEqual([200, 200, 200]);
    expect(await statuses(key, WRITES)).toEqual(Array(WRITES.length).fill(403));
  });

  it("let secret-stores:write change stores and settings", async () => {
    const key = { authType: "apiKey", scopes: ["secret-stores:write"] };
    expect(await statuses(key, WRITES)).toEqual([201, 200, 200, 200, 200]);
  });

  it("need the admin role for a person, on every change", async () => {
    mocks.role = "member";
    const session = { authType: "session", scopes: [], userId: "user_1" };
    expect(await statuses(session, READS)).toEqual([200, 200, 200]);
    expect(await statuses(session, WRITES)).toEqual(Array(WRITES.length).fill(403));
    mocks.role = "admin";
    expect(await statuses(session, WRITES)).toEqual([201, 200, 200, 200, 200]);
    expect(mocks.service.updateSecretStoreSettings).toHaveBeenCalledWith(WORKSPACE_ID, { allowPrivateNetwork: true }, "user_1");
  });

  it("answer 404 on an edition without secret stores, before any credential is looked at", async () => {
    mocks.enabled = false;
    const key = { authType: "apiKey", scopes: ["secret-stores:read", "secret-stores:write"] };
    expect(await statuses(key, [...READS, ...WRITES])).toEqual(Array(READS.length + WRITES.length).fill(404));
  });
});
