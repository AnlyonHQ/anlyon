import { Hono } from "hono";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlanFixture } from "./support/plan-fixture.ts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER_ID = "user_member";

const state = vi.hoisted(() => ({
  cloud: true,
  workspace: { plan: "production", createdAt: new Date("2026-11-01T00:00:00Z") } as { plan: string; createdAt: Date } | null,
  reads: 0,
}));

const services = vi.hoisted(() => ({
  createSsoConnection: vi.fn(async () => ({ id: "sso_1" })),
  updateSsoConnection: vi.fn(async () => ({ id: "sso_1" })),
  deleteSsoConnection: vi.fn(async () => undefined),
  getSsoConnection: vi.fn(async () => ({ id: "sso_1", enforced: true })),
  verifySsoDomains: vi.fn(async () => ({ verified: [] })),
  getScimSettings: vi.fn(async () => ({ connected: true })),
  issueScimToken: vi.fn(async () => ({ token: "t", settings: {} })),
  revokeScimToken: vi.fn(async () => undefined),
  replaceRoleMappings: vi.fn(async () => undefined),
  updateScimDefaultRole: vi.fn(async () => undefined),
  reapplyDirectoryRoles: vi.fn(async () => undefined),
  createSink: vi.fn(async () => ({ sink: { id: "sink_1" } })),
  updateSink: vi.fn(async () => ({ sink: { id: "sink_1" } })),
  deleteSink: vi.fn(async () => undefined),
  listSinks: vi.fn(async () => [{ id: "sink_1" }]),
  sendTestEvent: vi.fn(async () => ({ delivered: true })),
  getAuditSettings: vi.fn(async () => ({ retentionDays: 365 })),
  updateAuditSettings: vi.fn(async () => ({ retentionDays: 30 })),
  createSecretStore: vi.fn(async () => ({ name: "vault" })),
  updateSecretStore: vi.fn(async () => ({ name: "vault" })),
  deleteSecretStore: vi.fn(async () => undefined),
  listSecretStores: vi.fn(async () => [{ name: "vault" }]),
  checkSecretStore: vi.fn(async () => ({ ok: true })),
  setEnvironmentRole: vi.fn(async () => ({ role: "approver" })),
  removeEnvironmentRole: vi.fn(async () => undefined),
}));

vi.mock("../src/core/edition/edition.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/edition/edition.ts")>();
  return { ...actual, isCloudEdition: () => state.cloud };
});
vi.mock("../src/core/edition/features.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/edition/features.ts")>();
  return { ...actual, isFeatureEnabled: () => true };
});

vi.mock("../src/db/index.ts", () => {
  const chain: any = {
    from: () => chain,
    where: () => { state.reads += 1; return Promise.resolve(state.workspace ? [state.workspace] : []); },
  };
  return { db: { select: () => chain } };
});

vi.mock("../src/api/middleware/auth.ts", () => {
  const resolve = async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set("authType", "session");
    c.set("userId", "user_owner");
    c.set("workspaceId", WORKSPACE_ID);
    c.set("environmentId", ENVIRONMENT_ID);
    await next();
  };
  const pass = async (_c: unknown, next: () => Promise<void>) => next();
  return {
    requireApiKey: resolve,
    requireSession: resolve,
    requireWorkspaceAccess: pass,
    requirePermission: () => pass,
    requireApiKeyScope: () => pass,
    requireApiKeyResourceScopes: () => pass,
  };
});
vi.mock("../src/api/middleware/rateLimit.ts", () => ({
  rateLimitByWorkspace: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../src/api/routes/environment-context.ts", () => ({ resolveEnvironmentId: async () => ENVIRONMENT_ID }));
vi.mock("../src/core/sso/service.ts", () => ({
  createSsoConnection: services.createSsoConnection, updateSsoConnection: services.updateSsoConnection,
  deleteSsoConnection: services.deleteSsoConnection, getSsoConnection: services.getSsoConnection,
  verifySsoDomains: services.verifySsoDomains,
}));
vi.mock("../src/core/scim/settings.ts", () => ({
  getScimSettings: services.getScimSettings, issueScimToken: services.issueScimToken,
  revokeScimToken: services.revokeScimToken, replaceRoleMappings: services.replaceRoleMappings,
  updateScimDefaultRole: services.updateScimDefaultRole,
}));
vi.mock("../src/core/scim/service.ts", () => ({ reapplyDirectoryRoles: services.reapplyDirectoryRoles }));
vi.mock("../src/core/audit/service.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/audit/service.ts")>();
  return {
    ...actual,
    createSink: services.createSink, updateSink: services.updateSink, deleteSink: services.deleteSink,
    listSinks: services.listSinks, sendTestEvent: services.sendTestEvent,
    getAuditSettings: services.getAuditSettings, updateAuditSettings: services.updateAuditSettings,
  };
});
vi.mock("../src/core/secret-stores/service.ts", () => ({
  BYO_VAULT_FEATURE: "byo_vault",
  createSecretStore: services.createSecretStore, updateSecretStore: services.updateSecretStore,
  deleteSecretStore: services.deleteSecretStore, listSecretStores: services.listSecretStores,
  getSecretStore: vi.fn(), checkSecretStore: services.checkSecretStore,
  getSecretStoreSettings: vi.fn(), updateSecretStoreSettings: vi.fn(),
}));
vi.mock("../src/core/workspace/roles.ts", () => ({
  describeCallerPermissions: vi.fn(), listEnvironmentRoles: vi.fn(), listWorkspaceEnvironmentRoles: vi.fn(),
  resolveMemberRole: async () => ({ workspaceRole: "admin", role: "admin", grantedInEnvironmentId: null, emergencyAccess: true }),
  setEnvironmentRole: services.setEnvironmentRole, removeEnvironmentRole: services.removeEnvironmentRole,
}));
vi.mock("../src/core/workspace/members.ts", () => ({
  addMember: vi.fn(), updateMemberRole: vi.fn(), removeMember: vi.fn(), leaveWorkspace: vi.fn(),
  handOverEmergencyAccess: vi.fn(), setEmergencyAccess: vi.fn(), getMemberDetails: vi.fn(), listMembersWithDetails: vi.fn(),
}));

const TEAM = { features: { teamFeatures: true } };
const plans = usePlanFixture({ "*": { features: { teamFeatures: false } }, growth: TEAM, enterprise: TEAM }, { purchasable: true });

const { assertTeamFeature, teamFeaturesAvailable } = await import("../src/core/billing/team-features.ts");
const { resetPlanProvider, setPlanProvider } = await import("../src/core/plans/limits.ts");
const { default: identity } = await import("../src/api/routes/sso.ts");
const { auditConsoleRouter } = await import("../src/api/routes/audit.ts");
const { default: secretStoresRouter } = await import("../src/api/routes/secret-stores.ts");
const { default: members } = await import("../src/api/routes/members.ts");
const { buildErrorResponse } = await import("../src/api/middleware/error.ts");

const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/api/v2/workspaces", identity);
app.route("/api/v2/workspaces", auditConsoleRouter);
app.route("/api/v2/workspaces", members);
app.route("/api/v2/secret-stores", secretStoresRouter);

const call = (method: string, path: string, body?: unknown) => app.request(path, {
  method,
  headers: body === undefined ? {} : { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const ws = `/api/v2/workspaces/${WORKSPACE_ID}`;
const oidc = { protocol: "oidc", domains: ["example.com"], oidc: { issuer: "https://idp.example.com", clientId: "c", clientSecret: "s" } };
const sink = { name: "Splunk", type: "webhook", config: { url: "https://siem.example.com/hook" } };
const store = { name: "vault", provider: "vault", config: {} };

const gated: Array<[string, string, string, unknown, string]> = [
  ["create an SSO connection", "POST", `${ws}/sso`, oidc, "sso"],
  ["verify SSO domains", "POST", `${ws}/sso/verify-domains`, undefined, "sso"],
  ["change the SSO default role", "PATCH", `${ws}/sso`, { defaultRole: "member" }, "sso"],
  ["require SSO", "PATCH", `${ws}/sso`, { enforced: true }, "sso"],
  ["change the SCIM default role", "PATCH", `${ws}/scim`, { defaultRole: "member" }, "scim"],
  ["create a SCIM token", "POST", `${ws}/scim/token`, undefined, "scim"],
  ["replace SCIM role mappings", "PUT", `${ws}/scim/role-mappings`, { mappings: [] }, "scim"],
  ["create an audit sink", "POST", `${ws}/audit/sinks`, sink, "audit_streaming"],
  ["change an audit sink", "PATCH", `${ws}/audit/sinks/sink_1`, { enabled: true }, "audit_streaming"],
  ["change audit settings", "PUT", `${ws}/audit/settings`, { retentionDays: 30 }, "audit_streaming"],
  ["create a secret store", "POST", "/api/v2/secret-stores", store, "byo_vault"],
  ["change a secret store", "PATCH", "/api/v2/secret-stores/vault", { config: {} }, "byo_vault"],
  ["grant a role in one environment", "PUT", `${ws}/members/${MEMBER_ID}/environment-roles/${ENVIRONMENT_ID}`, { role: "approver" }, "env_permissions"],
];

const open: Array<[string, string, string, unknown, () => unknown]> = [
  ["remove the SSO connection", "DELETE", `${ws}/sso`, undefined, () => services.deleteSsoConnection],
  ["stop requiring SSO", "PATCH", `${ws}/sso`, { enforced: false }, () => services.updateSsoConnection],
  ["read the SSO connection", "GET", `${ws}/sso`, undefined, () => services.getSsoConnection],
  ["read SCIM settings", "GET", `${ws}/scim`, undefined, () => services.getScimSettings],
  ["revoke the SCIM token", "DELETE", `${ws}/scim/token`, undefined, () => services.revokeScimToken],
  ["list audit sinks", "GET", `${ws}/audit/sinks`, undefined, () => services.listSinks],
  ["delete an audit sink", "DELETE", `${ws}/audit/sinks/sink_1`, undefined, () => services.deleteSink],
  ["test an existing audit sink", "POST", `${ws}/audit/sinks/sink_1/test`, undefined, () => services.sendTestEvent],
  ["list secret stores", "GET", "/api/v2/secret-stores", undefined, () => services.listSecretStores],
  ["delete a secret store", "DELETE", "/api/v2/secret-stores/vault", undefined, () => services.deleteSecretStore],
  ["check an existing secret store", "POST", "/api/v2/secret-stores/vault/check", undefined, () => services.checkSecretStore],
  ["remove an environment role", "DELETE", `${ws}/members/${MEMBER_ID}/environment-roles/${ENVIRONMENT_ID}`, undefined, () => services.removeEnvironmentRole],
];

beforeEach(() => {
  state.cloud = true;
  state.workspace = { plan: "production", createdAt: new Date("2026-11-01T00:00:00Z") };
  state.reads = 0;
  vi.clearAllMocks();
  plans.purchasable = true;
  plans.bumpEpoch();
});

afterAll(() => resetPlanProvider());

describe("teamFeaturesAvailable", () => {
  const newWorkspace = { createdAt: new Date("2026-11-01T00:00:00Z") };

  it.each(["free", "starter", "production", "paygo"])("refuses %s, a plan without Team features, while larger plans are on sale", (plan) => {
    expect(teamFeaturesAvailable({ plan, ...newWorkspace })).toBe(false);
  });

  it.each(["growth", "enterprise"])("allows %s, a plan with Team features", (plan) => {
    expect(teamFeaturesAvailable({ plan, ...newWorkspace })).toBe(true);
  });

  it("is open on every plan while no larger plan can be bought", () => {
    plans.purchasable = false;
    for (const plan of ["free", "starter", "production"]) expect(teamFeaturesAvailable({ plan, ...newWorkspace })).toBe(true);
  });

  it("is open on every plan without a plan provider", () => {
    resetPlanProvider();
    try {
      for (const plan of ["free", "starter", "production"]) expect(teamFeaturesAvailable({ plan, ...newWorkspace })).toBe(true);
    } finally {
      setPlanProvider(plans.provider);
    }
  });

  it("follows the plan table: a plan given Team features passes", () => {
    plans.set("starter", TEAM);
    try {
      expect(teamFeaturesAvailable({ plan: "starter", ...newWorkspace })).toBe(true);
    } finally {
      plans.set("starter", {});
    }
  });

  it("leaves self-hosted editions to their licence gate", () => {
    state.cloud = false;
    expect(teamFeaturesAvailable({ plan: "free", ...newWorkspace })).toBe(true);
  });
});

describe("assertTeamFeature", () => {
  it("answers 403 PLAN_FEATURE_REQUIRED naming the feature and the Team plan", async () => {
    await expect(assertTeamFeature(WORKSPACE_ID, "sso")).rejects.toMatchObject({
      statusCode: 403, code: "PLAN_FEATURE_REQUIRED", details: { feature: "sso", requiredPlan: "growth" },
    });
  });

  it("passes the Team plan", async () => {
    state.workspace = { plan: "growth", createdAt: new Date() };
    await expect(assertTeamFeature(WORKSPACE_ID, "scim")).resolves.toBeUndefined();
  });

  it("answers 404 for a workspace that does not exist", async () => {
    state.workspace = null;
    await expect(assertTeamFeature(WORKSPACE_ID, "sso")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("reads nothing when the plan cannot matter (self-hosted, nothing on sale, or no plan provider)", async () => {
    state.cloud = false;
    await assertTeamFeature(WORKSPACE_ID, "audit_streaming");
    state.cloud = true;
    plans.purchasable = false;
    await assertTeamFeature(WORKSPACE_ID, "byo_vault");
    plans.purchasable = true;
    resetPlanProvider();
    try {
      await assertTeamFeature(WORKSPACE_ID, "env_permissions");
    } finally {
      setPlanProvider(plans.provider);
    }
    expect(state.reads).toBe(0);
  });
});

describe("routes on a plan without Team features", () => {
  it.each(gated)("refuses to %s", async (_name, method, path, body, feature) => {
    const response = await call(method, path, body);
    expect(response.status).toBe(403);
    const json = await response.json() as { error: { code: string; details: unknown } };
    expect(json.error.code).toBe("PLAN_FEATURE_REQUIRED");
    expect(json.error.details).toEqual({ feature, requiredPlan: "growth" });
    for (const service of [services.createSsoConnection, services.updateSsoConnection, services.verifySsoDomains,
      services.issueScimToken, services.replaceRoleMappings, services.updateScimDefaultRole, services.createSink,
      services.updateSink, services.updateAuditSettings, services.createSecretStore, services.updateSecretStore,
      services.setEnvironmentRole]) {
      expect(service).not.toHaveBeenCalled();
    }
  });

  it.each(open)("still lets an admin %s", async (_name, method, path, body, service) => {
    const response = await call(method, path, body);
    expect(response.status).toBeLessThan(300);
    expect(service()).toHaveBeenCalled();
  });
});

describe("routes on the Team plan", () => {
  it.each(gated)("allows a request to %s", async (_name, method, path, body) => {
    state.workspace = { plan: "growth", createdAt: new Date() };
    const response = await call(method, path, body);
    expect(response.status).not.toBe(403);
  });
});
