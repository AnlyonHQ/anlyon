import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveMemberRole = vi.hoisted(() => vi.fn());
const apiKeyCreator = vi.hoisted(() => vi.fn());
const approvalDecidersIn = vi.hoisted(() => vi.fn());
vi.mock("../src/core/workspace/roles.ts", () => ({ resolveMemberRole, approvalDecidersIn }));
vi.mock("../src/core/approvals/requester.ts", () => ({ apiKeyCreator }));

const { assertMayDecide } = await import("../src/core/approvals/decider.ts");
const { AuthorizationError, SelfApprovalError } = await import("../src/utils/errors.ts");

const WS = "ws_1";
const PROD = "env_prod";
const STAGING = "env_staging";

const fromKey = { environmentId: PROD, requestedByKeyId: "key_agent", requestedByOAuthClientId: null, requestedByUserId: null };
const fromApp = { environmentId: PROD, requestedByKeyId: null, requestedByOAuthClientId: "client_1", requestedByUserId: "user_1" };
const fromConsole = { environmentId: PROD, requestedByKeyId: null, requestedByOAuthClientId: null, requestedByUserId: "user_1" };

const NOT_SELF = { selfApproved: false };
const SELF = { selfApproved: true };

const as = (role: string, workspaceRole = role) => ({ workspaceRole, role, grantedInEnvironmentId: role === workspaceRole ? null : PROD, emergencyAccess: false });

beforeEach(() => {
  resolveMemberRole.mockReset();
  apiKeyCreator.mockReset();
  approvalDecidersIn.mockReset();
  apiKeyCreator.mockResolvedValue("user_creator");
  approvalDecidersIn.mockResolvedValue(["user_1", "user_2", "user_3"]);
});

describe("a person's role in the approval's environment", () => {
  it.each(["admin", "member", "approver"])("lets a %s decide", async (role) => {
    resolveMemberRole.mockResolvedValue(as(role));
    await expect(assertMayDecide(WS, fromKey, { deciderUserId: "user_2" })).resolves.toEqual(NOT_SELF);
  });

  it("refuses a viewer", async () => {
    resolveMemberRole.mockResolvedValue(as("viewer"));
    await expect(assertMayDecide(WS, fromKey, { deciderUserId: "user_2" })).rejects.toThrow(AuthorizationError);
    await expect(assertMayDecide(WS, fromKey, { deciderUserId: "user_2" })).rejects.toThrow(/read-only/);
  });

  it("reads the role in the approval's environment, not the request's", async () => {
    resolveMemberRole.mockResolvedValue(as("approver", "viewer"));
    await assertMayDecide(WS, fromKey, { deciderUserId: "user_2" });
    expect(resolveMemberRole).toHaveBeenCalledWith(WS, "user_2", PROD);
  });

  it("an approver in production only cannot decide in staging", async () => {
    resolveMemberRole.mockImplementation(async (_ws: string, _user: string, env: string) =>
      env === PROD ? as("approver", "viewer") : as("viewer"));
    await expect(assertMayDecide(WS, fromKey, { deciderUserId: "user_2" })).resolves.toEqual(NOT_SELF);
    await expect(assertMayDecide(WS, { ...fromKey, environmentId: STAGING }, { deciderUserId: "user_2" }))
      .rejects.toThrow(AuthorizationError);
  });

  it("a member made read-only in production cannot decide there", async () => {
    resolveMemberRole.mockResolvedValue(as("viewer", "member"));
    await expect(assertMayDecide(WS, fromKey, { deciderUserId: "user_2" })).rejects.toThrow(AuthorizationError);
  });

  it("refuses someone who is not a member", async () => {
    resolveMemberRole.mockResolvedValue(null);
    await expect(assertMayDecide(WS, fromKey, { deciderUserId: "user_9" })).rejects.toThrow(/not a member/);
  });

  it("holds an OAuth app to its user's role", async () => {
    resolveMemberRole.mockResolvedValue(as("viewer"));
    await expect(assertMayDecide(WS, fromKey, { deciderUserId: "user_2", deciderOAuthClientId: "client_2" }))
      .rejects.toThrow(AuthorizationError);
  });
});

describe("credentials without a person", () => {
  it("an API key is governed by its scope, not a role", async () => {
    await expect(assertMayDecide(WS, fromKey, { deciderKeyId: "key_operator" })).resolves.toEqual(NOT_SELF);
    expect(resolveMemberRole).not.toHaveBeenCalled();
  });

  it("the approval assistant decides under the workspace's opt-in", async () => {
    await expect(assertMayDecide(WS, fromKey, { assistant: { model: "vigil" } })).resolves.toEqual(NOT_SELF);
    expect(resolveMemberRole).not.toHaveBeenCalled();
  });
});

describe("the requester never decides its own request, whatever the role", () => {
  it("refuses the requesting key", async () => {
    await expect(assertMayDecide(WS, fromKey, { deciderKeyId: "key_agent" })).rejects.toThrow(/auto_approve/);
  });

  it("refuses the requesting app for the same user, even an owner", async () => {
    resolveMemberRole.mockResolvedValue(as("admin"));
    await expect(assertMayDecide(WS, fromApp, { deciderUserId: "user_1", deciderOAuthClientId: "client_1" }))
      .rejects.toThrow(/An app cannot decide/);
    expect(resolveMemberRole).not.toHaveBeenCalled();
  });

});

describe("a person does not decide what their own credential requested", () => {
  beforeEach(() => resolveMemberRole.mockResolvedValue(as("admin")));

  it.each([
    ["the console", {}],
    ["another app", { deciderOAuthClientId: "client_2" }],
  ])("refuses their own app's request from %s", async (_surface, extra) => {
    const decision = assertMayDecide(WS, fromApp, { deciderUserId: "user_1", ...extra });
    await expect(decision).rejects.toThrow(SelfApprovalError);
    await expect(assertMayDecide(WS, fromApp, { deciderUserId: "user_1", ...extra }))
      .rejects.toThrow(/an app acting for you requested it/);
  });

  it("refuses a request made by an API key they created, from any surface", async () => {
    apiKeyCreator.mockResolvedValue("user_2");
    for (const extra of [{}, { deciderOAuthClientId: "client_9" }]) {
      await expect(assertMayDecide(WS, fromKey, { deciderUserId: "user_2", ...extra }))
        .rejects.toThrow(/an API key you created requested it/);
    }
    expect(apiKeyCreator).toHaveBeenCalledWith("key_agent");
  });

  it("says who can decide instead", async () => {
    apiKeyCreator.mockResolvedValue("user_2");
    const error = await assertMayDecide(WS, fromKey, { deciderUserId: "user_2" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthorizationError);
    expect((error as InstanceType<typeof SelfApprovalError>).code).toBe("SELF_APPROVAL_NOT_ALLOWED");
    expect((error as Error).message).toMatch(/Another member who can decide approvals in this environment/);
    expect((error as Error).message).toMatch(/separate approver key/);
  });

  it("checks the requester before the role, so no role lifts it", async () => {
    await expect(assertMayDecide(WS, fromApp, { deciderUserId: "user_1" })).rejects.toThrow(SelfApprovalError);
    expect(resolveMemberRole).not.toHaveBeenCalled();
  });

  it("lets a second person decide", async () => {
    apiKeyCreator.mockResolvedValue("user_2");
    await expect(assertMayDecide(WS, fromApp, { deciderUserId: "user_3" })).resolves.toEqual(NOT_SELF);
    await expect(assertMayDecide(WS, fromKey, { deciderUserId: "user_3" })).resolves.toEqual(NOT_SELF);
  });

  it("lets a separate approver key decide, even one the same person created", async () => {
    apiKeyCreator.mockResolvedValue("user_2");
    await expect(assertMayDecide(WS, fromKey, { deciderKeyId: "key_approver" })).resolves.toEqual(NOT_SELF);
    expect(apiKeyCreator).not.toHaveBeenCalled();
  });

  it("does not treat a key whose creator is gone as anyone's", async () => {
    apiKeyCreator.mockResolvedValue(null);
    await expect(assertMayDecide(WS, fromKey, { deciderUserId: "user_2" })).resolves.toEqual(NOT_SELF);
  });
});

describe("a request made from a console session", () => {
  beforeEach(() => resolveMemberRole.mockResolvedValue(as("admin")));

  it("is the requester's own: refused from the console and from an app while someone else can decide", async () => {
    for (const extra of [{}, { deciderOAuthClientId: "client_2" }]) {
      await expect(assertMayDecide(WS, fromConsole, { deciderUserId: "user_1", ...extra }))
        .rejects.toThrow(/you requested it/);
    }
    expect(apiKeyCreator).not.toHaveBeenCalled();
  });

  it("is decided by anyone else as usual", async () => {
    await expect(assertMayDecide(WS, fromConsole, { deciderUserId: "user_2" })).resolves.toEqual(NOT_SELF);
    await expect(assertMayDecide(WS, fromConsole, { deciderKeyId: "key_approver" })).resolves.toEqual(NOT_SELF);
  });
});

describe("the only approver in the approval's environment", () => {
  beforeEach(() => resolveMemberRole.mockResolvedValue(as("admin")));

  it("may decide their own app's request directly (console or Slack), marked self-approved", async () => {
    approvalDecidersIn.mockResolvedValue(["user_1"]);
    await expect(assertMayDecide(WS, fromApp, { deciderUserId: "user_1" })).resolves.toEqual(SELF);
    expect(approvalDecidersIn).toHaveBeenCalledWith(WS, PROD);
  });

  it("may decide their own console request directly, marked self-approved", async () => {
    approvalDecidersIn.mockResolvedValue(["user_1"]);
    await expect(assertMayDecide(WS, fromConsole, { deciderUserId: "user_1" })).resolves.toEqual(SELF);
  });

  it("never takes the exception through an app acting for them", async () => {
    apiKeyCreator.mockResolvedValue("user_1");
    approvalDecidersIn.mockResolvedValue(["user_1"]);
    for (const approval of [fromApp, fromConsole, fromKey]) {
      await expect(assertMayDecide(WS, approval, { deciderUserId: "user_1", deciderOAuthClientId: "client_2" }))
        .rejects.toThrow(SelfApprovalError);
    }
  });

  it("may decide a request made by an API key they created, marked self-approved", async () => {
    apiKeyCreator.mockResolvedValue("user_2");
    approvalDecidersIn.mockResolvedValue(["user_2"]);
    await expect(assertMayDecide(WS, fromKey, { deciderUserId: "user_2" })).resolves.toEqual(SELF);
  });

  it("never lets the requesting key or app itself decide", async () => {
    approvalDecidersIn.mockResolvedValue(["user_1"]);
    await expect(assertMayDecide(WS, fromKey, { deciderKeyId: "key_agent" })).rejects.toThrow(/auto_approve/);
    await expect(assertMayDecide(WS, fromApp, { deciderUserId: "user_1", deciderOAuthClientId: "client_1" }))
      .rejects.toThrow(/An app cannot decide/);
  });

  it("is refused again once a second member can decide", async () => {
    apiKeyCreator.mockResolvedValue("user_2");
    approvalDecidersIn.mockResolvedValue(["user_2", "user_5"]);
    await expect(assertMayDecide(WS, fromKey, { deciderUserId: "user_2" })).rejects.toThrow(SelfApprovalError);
  });

  it("counts a per-environment approver only in its environment", async () => {
    apiKeyCreator.mockResolvedValue("user_2");
    approvalDecidersIn.mockImplementation(async (_ws: string, env: string) => (env === PROD ? ["user_2", "user_7"] : ["user_2"]));
    await expect(assertMayDecide(WS, fromKey, { deciderUserId: "user_2" })).rejects.toThrow(SelfApprovalError);
    await expect(assertMayDecide(WS, { ...fromKey, environmentId: STAGING }, { deciderUserId: "user_2" })).resolves.toEqual(SELF);
  });

  it("still needs a role that decides", async () => {
    apiKeyCreator.mockResolvedValue("user_2");
    approvalDecidersIn.mockResolvedValue([]);
    resolveMemberRole.mockResolvedValue(as("viewer"));
    await expect(assertMayDecide(WS, fromKey, { deciderUserId: "user_2" })).rejects.toThrow(/read-only/);
  });

  it("is not marked for someone else's request", async () => {
    approvalDecidersIn.mockResolvedValue(["user_3"]);
    await expect(assertMayDecide(WS, fromApp, { deciderUserId: "user_3" })).resolves.toEqual(NOT_SELF);
  });
});

describe("through the approval service", () => {
  it("refuses a viewer before any vote is recorded", async () => {
    vi.resetModules();
    const transaction = vi.fn();
    vi.doMock("../src/db/index.ts", () => ({
      db: {
        select: () => ({
          from: () => ({
            where: () => {
              const result = Promise.resolve([{
                id: "uuid-1", approvalId: "apr_1", workspaceId: WS, environmentId: PROD, status: "pending",
                kind: "custom", requestedByKeyId: "key_agent", requestedByOAuthClientId: null, requestedByUserId: null,
                requiredApprovals: 1, expiresAt: new Date(Date.now() + 3_600_000),
              }]);
              return Object.assign(result, { limit: () => result });
            },
          }),
        }),
        transaction,
      },
    }));
    vi.doMock("../src/core/workspace/roles.ts", () => ({ resolveMemberRole: async () => as("viewer"), approvalDecidersIn: async () => [] }));
    vi.doMock("../src/core/approvals/requester.ts", () => ({ apiKeyCreator: async () => "user_creator" }));
    const { approveApproval, denyApproval } = await import("../src/core/approvals/service.ts");
    const errors = await import("../src/utils/errors.ts");

    await expect(approveApproval(WS, "apr_1", { deciderUserId: "user_2" }, PROD)).rejects.toThrow(errors.AuthorizationError);
    await expect(denyApproval(WS, "apr_1", { deciderUserId: "user_2" }, PROD)).rejects.toThrow(errors.AuthorizationError);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("quorum: distinct deciders", async () => {
  const { distinctApprovers } = await import("../src/core/approvals/decider.ts");
  const vote = (id: string, over: Partial<{ deciderKeyId: string; deciderUserId: string; keyCreatedBy: string }>) =>
    ({ id, deciderKeyId: null, deciderUserId: null, keyCreatedBy: null, ...over });

  it("counts a person's own vote and the votes of keys they created once", () => {
    expect(distinctApprovers([
      vote("v1", { deciderUserId: "user_1" }),
      vote("v2", { deciderKeyId: "key_a", keyCreatedBy: "user_1" }),
      vote("v3", { deciderKeyId: "key_b", keyCreatedBy: "user_1" }),
    ])).toBe(1);
  });

  it("counts different people, orphaned keys and assistant votes separately", () => {
    expect(distinctApprovers([
      vote("v1", { deciderUserId: "user_1" }),
      vote("v2", { deciderKeyId: "key_a", keyCreatedBy: "user_2" }),
      vote("v3", { deciderKeyId: "key_orphan" }),
      vote("v4", { deciderKeyId: "key_orphan_2" }),
      vote("v5", {}),
    ])).toBe(5);
  });
});
