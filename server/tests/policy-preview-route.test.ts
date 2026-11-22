import { Hono, type Context, type Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { preview, versions, version, create, update, remove } = vi.hoisted(() => ({
  preview: vi.fn(), versions: vi.fn(), version: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(),
}));
vi.mock("../src/api/governance-gate.ts", () => ({ signOffIfLoosening: async () => null, isHumanPresent: () => true }));
vi.mock("../src/core/approvals/policy.ts", () => ({
  previewPolicies: preview, createPolicy: create, deletePolicy: remove,
  getPolicy: vi.fn(), listPolicies: vi.fn(), updatePolicy: update, listPolicyVersions: versions,
  getPolicyVersion: version, POLICY_VERSIONS_DEFAULT_LIMIT: 50,
}));
const fileService = vi.hoisted(() => ({ plan: vi.fn(), apply: vi.fn(), test: vi.fn() }));
vi.mock("../src/core/approvals/policy-files.ts", () => ({
  planPolicyFile: fileService.plan, applyPolicyFile: fileService.apply, testPolicyFile: fileService.test,
}));
vi.mock("../src/api/middleware/auth.ts", async (original) => ({
  ...await original<typeof import("../src/api/middleware/auth.ts")>(),
  requireApiKey: async (c: Context, next: Next) => {
    c.set("workspaceId", "ws_test"); c.set("environmentId", "env_test");
    c.set("authType", "apiKey"); c.set("apiKeyId", "key_test"); c.set("apiKeyScopes", (c.req.header("Test-Scopes") ?? "").split(","));
    await next();
  },
}));
vi.mock("../src/api/middleware/rateLimit.ts", () => ({ rateLimitByWorkspace: async (_c: Context, next: Next) => next() }));
const router = (await import("../src/api/routes/approval-policies.ts")).default;
const { ApiError } = await import("../src/utils/errors.ts");
const app = new Hono();
app.onError((error, c) => error instanceof ApiError ? c.json(error.toJSON(), error.statusCode as ContentfulStatusCode) : c.json({ error: error.message }, 500));
app.route("/approval-policies", router);
const request = (scope = "policies:read", body: unknown = { kind: "custom" }, suffix = "") => app.request(`/approval-policies/evaluate${suffix}`, {
  method: "POST", headers: { "content-type": "application/json", "Test-Scopes": scope }, body: JSON.stringify(body),
});
const call = (method: string, path: string, scope: string, body?: unknown) => app.request(`/approval-policies${path}`, {
  method, headers: { "content-type": "application/json", "Test-Scopes": scope }, body: body === undefined ? undefined : JSON.stringify(body),
});
beforeEach(() => {
  vi.clearAllMocks();
  preview.mockResolvedValue({ evaluation: "policy_only" });
  versions.mockResolvedValue({ versions: [{ version: 1 }], nextBefore: null, earliestVersion: 1, latestVersion: 1 });
  version.mockResolvedValue({ version: 1 });
  create.mockResolvedValue({ id: "apol_new" });
  update.mockResolvedValue({ id: "apol_1" });
  remove.mockResolvedValue(undefined);
});

describe("policy preview route authorization", () => {
  it("allows read-only operators without policies:write and binds the credential environment", async () => {
    expect((await request()).status).toBe(200);
    expect(preview).toHaveBeenCalledWith("ws_test", "env_test", { kind: "custom" });
  });
  it.each(["actions:invoke", "policies:write", ""])("rejects missing read scope: %s", async (scope) => {
    expect((await request(scope)).status).toBe(403);
    expect(preview).not.toHaveBeenCalled();
  });
  it("rejects a cross-environment query", async () => {
    expect((await request("policies:read", { kind: "custom" }, "?environmentId=other")).status).toBe(403);
    expect(preview).not.toHaveBeenCalled();
  });
  it("rejects environment override and misspelled context fields", async () => {
    expect((await request("policies:read", { kind: "custom", environmentId: "other" })).status).toBe(400);
    expect(preview).not.toHaveBeenCalled();
  });
});

describe("policy history route authorization", () => {
  it("reads retained history with policies:read, bound to the credential environment", async () => {
    const response = await call("GET", "/apol_1/versions", "policies:read");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true, data: [{ version: 1 }],
      pagination: { limit: 50, nextBefore: null, earliestVersion: 1, latestVersion: 1 },
    });
    expect(versions).toHaveBeenCalledWith("ws_test", "apol_1", { environmentId: "env_test" }, { limit: undefined, before: undefined });
  });
  it("pages with a version cursor and reads one exact version", async () => {
    expect((await call("GET", "/apol_1/versions?limit=10&before=40", "policies:read")).status).toBe(200);
    expect(versions).toHaveBeenLastCalledWith("ws_test", "apol_1", { environmentId: "env_test" }, { limit: 10, before: 40 });
    expect((await call("GET", "/apol_1/versions?limit=500", "policies:read")).status).toBe(400);
    expect((await call("GET", "/apol_1/versions/7", "policies:read")).status).toBe(200);
    expect(version).toHaveBeenCalledWith("ws_test", "apol_1", 7, { environmentId: "env_test" });
    expect((await call("GET", "/apol_1/versions/0", "policies:read")).status).toBe(400);
    expect((await call("GET", "/apol_1/versions/7", "policies:write")).status).toBe(403);
  });
  it.each(["policies:write", "actions:invoke", ""])("rejects a history read without policies:read: %s", async (scope) => {
    expect((await call("GET", "/apol_1/versions", scope)).status).toBe(403);
    expect(versions).not.toHaveBeenCalled();
  });
  it("rejects a cross-environment history read", async () => {
    expect((await call("GET", "/apol_1/versions?environmentId=other", "policies:read")).status).toBe(403);
    expect(versions).not.toHaveBeenCalled();
  });
});

describe("policy write provenance", () => {
  it("attributes create, update and delete to the authenticated key and passes the change note", async () => {
    const created = await call("POST", "", "policies:write", { name: "refunds", matchKind: "custom", changeNote: "Initial" });
    expect(created.status).toBe(201);
    expect(create).toHaveBeenCalledWith("ws_test", expect.objectContaining({ environmentId: "env_test", changeNote: "Initial" }),
      { actor: { type: "api_key", id: "key_test" } });

    expect((await call("PATCH", "/apol_1", "policies:write", { enabled: false, changeNote: "Pause" })).status).toBe(200);
    expect(update).toHaveBeenCalledWith("ws_test", "apol_1", { enabled: false, changeNote: "Pause" },
      { environmentId: "env_test", actor: { type: "api_key", id: "key_test" } });

    expect((await call("DELETE", "/apol_1", "policies:write")).status).toBe(200);
    expect(remove).toHaveBeenCalledWith("ws_test", "apol_1", { environmentId: "env_test", actor: { type: "api_key", id: "key_test" } });
  });
  it("never accepts provenance from the request body", async () => {
    const body = { enabled: false, actor: { type: "user", id: "someone_else" } };
    expect((await call("PATCH", "/apol_1", "policies:write", body)).status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
  it("rejects an over-long change note", async () => {
    expect((await call("PATCH", "/apol_1", "policies:write", { enabled: false, changeNote: "x".repeat(1001) })).status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("policy file routes", () => {
  const digest = "a".repeat(64);
  beforeEach(() => {
    fileService.plan.mockResolvedValue({ digest });
    fileService.apply.mockResolvedValue({ applied: true });
    fileService.test.mockResolvedValue({ passed: 1, failed: 0 });
  });

  it("plans and tests with policies:read, bound to the credential environment", async () => {
    expect((await call("POST", "/files/plan", "policies:read", { source: "x" })).status).toBe(200);
    expect(fileService.plan).toHaveBeenCalledWith("ws_test", "env_test", "x");
    expect((await call("POST", "/files/test", "policies:read", { source: "x", cases: "cases: []" })).status).toBe(200);
    expect(fileService.test).toHaveBeenCalledWith("ws_test", "env_test", "x", "cases: []");
  });

  it("applies only with policies:write and records the credential as the actor", async () => {
    expect((await call("POST", "/files/apply", "policies:read", { source: "x", digest })).status).toBe(403);
    expect(fileService.apply).not.toHaveBeenCalled();
    expect((await call("POST", "/files/apply", "policies:write", { source: "x", digest, changeNote: "FIN-42" })).status).toBe(200);
    expect(fileService.apply).toHaveBeenCalledWith("ws_test", "env_test", "x", digest,
      { environmentId: "env_test", actor: { type: "api_key", id: "key_test" } }, "FIN-42");
  });

  it("refuses a malformed digest, extra fields and a cross-environment request", async () => {
    expect((await call("POST", "/files/apply", "policies:write", { source: "x", digest: "nope" })).status).toBe(400);
    expect((await call("POST", "/files/plan", "policies:read", { source: "x", environment: "other" })).status).toBe(400);
    expect((await call("POST", "/files/plan?environmentId=other", "policies:read", { source: "x" })).status).toBe(403);
    expect((await call("POST", "/files/plan", "policies:write", { source: "x" })).status).toBe(403);
    expect(fileService.plan).not.toHaveBeenCalled();
  });
});

