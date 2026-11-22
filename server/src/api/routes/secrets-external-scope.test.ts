import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  caller: { authType: "apiKey", scopes: [] as string[], userId: undefined as string | undefined },
  role: "admin",
  secrets: {
    assertSecretWillBeBound: vi.fn(async () => undefined),
    putExternalSecret: vi.fn(async () => ({ secret: { name: "STRIPE_KEY", kind: "external" }, warning: null })),
    putSecret: vi.fn(async () => ({ name: "STRIPE_KEY", kind: "static" })),
    checkExternalSecret: vi.fn(),
    deleteSecret: vi.fn(),
    getSecretMetadata: vi.fn(),
    listSecrets: vi.fn(async () => []),
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
vi.mock("../../core/workspace/roles.ts", () => ({
  resolveMemberRole: async () => ({ workspaceRole: mocks.role, role: mocks.role, grantedInEnvironmentId: null }),
}));
vi.mock("../../core/actions/secrets.ts", () => mocks.secrets);
vi.mock("../../core/secret-stores/service.ts", () => ({ assertSecretStoresAvailable: () => undefined }));

const { default: secretsRouter } = await import("./secrets.ts");
const { buildErrorResponse } = await import("../middleware/error.ts");

const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/secrets", secretsRouter);

const EXTERNAL = { external: { store: "prod-vault", path: "payments/stripe", key: "apiKey" }, allowedHosts: ["api.stripe.com"] };
const STORED = { value: "<your-stripe-key>", allowedHosts: ["api.stripe.com"] };

async function put(caller: { authType: string; scopes: string[]; userId?: string }, body: unknown): Promise<number> {
  mocks.caller = { ...caller, userId: caller.userId };
  const response = await app.request("/secrets/STRIPE_KEY", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.status;
}

beforeEach(() => {
  mocks.role = "admin";
  for (const fn of Object.values(mocks.secrets)) fn.mockClear();
});

describe("PUT /secrets/{name} with external", () => {
  it("refuses a key that holds secrets:write but not secret-stores:write", async () => {
    expect(await put({ authType: "apiKey", scopes: ["secrets:read", "secrets:write"] }, EXTERNAL)).toBe(403);
    expect(mocks.secrets.putExternalSecret).not.toHaveBeenCalled();
  });

  it("accepts a key that holds both", async () => {
    expect(await put({ authType: "apiKey", scopes: ["secrets:write", "secret-stores:write"] }, EXTERNAL)).toBe(200);
    expect(mocks.secrets.putExternalSecret).toHaveBeenCalledTimes(1);
  });

  it("still needs secrets:write: secret-stores:write alone does not write secrets", async () => {
    expect(await put({ authType: "apiKey", scopes: ["secret-stores:write"] }, EXTERNAL)).toBe(403);
    expect(mocks.secrets.putExternalSecret).not.toHaveBeenCalled();
  });

  it("needs the admin role for a person, where a stored value needs only member", async () => {
    mocks.role = "member";
    const session = { authType: "session", scopes: [], userId: "user_1" };
    expect(await put(session, EXTERNAL)).toBe(403);
    expect(mocks.secrets.putExternalSecret).not.toHaveBeenCalled();
    expect(await put(session, STORED)).toBe(200);
    mocks.role = "admin";
    expect(await put(session, EXTERNAL)).toBe(200);
  });

  it("leaves a stored value at secrets:write", async () => {
    expect(await put({ authType: "apiKey", scopes: ["secrets:write"] }, STORED)).toBe(200);
    expect(mocks.secrets.putSecret).toHaveBeenCalledTimes(1);
  });
});
