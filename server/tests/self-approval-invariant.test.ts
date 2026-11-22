import { describe, it, expect, vi, beforeEach } from "vitest";

const selectLimit = vi.fn();

vi.mock("../src/db/index.ts", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const result = selectLimit();
          return Object.assign(result, { limit: () => result });
        },
      }),
    }),
    transaction: vi.fn(),
  },
}));

vi.mock("../src/lib/logger.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/logger.ts")>()),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../src/core/workspace/roles.ts", () => ({
  resolveMemberRole: async () => ({ workspaceRole: "member", role: "member", grantedInEnvironmentId: null }),
  approvalDecidersIn: async () => ["user_creator", "user_1"],
}));
vi.mock("../src/core/approvals/requester.ts", () => ({ apiKeyCreator: async () => "user_creator" }));

const { approveApproval, denyApproval } = await import("../src/core/approvals/service.ts");
const { AuthorizationError } = await import("../src/utils/errors.ts");

function pending(over: Record<string, unknown> = {}) {
  return {
    id: "uuid-1",
    approvalId: "apr_1",
    workspaceId: "ws_1",
    environmentId: "env_1",
    status: "pending",
    kind: "action",
    requestedByKeyId: "key_agent",
    requiredApprovals: 1,
    expiresAt: new Date(Date.now() + 3_600_000),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockResolvedValue([pending()]);
});

describe("the requesting key", () => {
  it("cannot approve its own request", async () => {
    await expect(
      approveApproval("ws_1", "apr_1", { deciderKeyId: "key_agent" }, "env_1")
    ).rejects.toThrow(AuthorizationError);
  });

  it("cannot deny its own request either  it may not vote at all", async () => {
    await expect(
      denyApproval("ws_1", "apr_1", { deciderKeyId: "key_agent" }, "env_1")
    ).rejects.toThrow(AuthorizationError);
  });

  it("points at auto_approve, which is the supported way to skip the human", async () => {
    await expect(
      approveApproval("ws_1", "apr_1", { deciderKeyId: "key_agent" }, "env_1")
    ).rejects.toThrow(/auto_approve/);
  });

  it("is refused no matter what the governing policy said", async () => {
    selectLimit.mockResolvedValue([pending({ matchedPolicyId: "pol_permissive" })]);

    await expect(
      approveApproval("ws_1", "apr_1", { deciderKeyId: "key_agent" }, "env_1")
    ).rejects.toThrow(AuthorizationError);
  });
});

describe("the person behind the requesting key", () => {
  it("cannot decide it from the dashboard either while someone else can, whatever their role", async () => {
    const { SelfApprovalError } = await import("../src/utils/errors.ts");
    await expect(
      approveApproval("ws_1", "apr_1", { deciderUserId: "user_creator" }, "env_1")
    ).rejects.toThrow(SelfApprovalError);
    await expect(
      denyApproval("ws_1", "apr_1", { deciderUserId: "user_creator" }, "env_1")
    ).rejects.toThrow(/Another member who can decide approvals in this environment/);
  });
});

describe("everyone else is unaffected", () => {
  it("lets a different key decide", async () => {
    await expect(
      approveApproval("ws_1", "apr_1", { deciderKeyId: "key_operator" }, "env_1")
    ).rejects.not.toThrow(AuthorizationError);
  });

  it("lets a signed-in dashboard user decide", async () => {
    await expect(
      approveApproval("ws_1", "apr_1", { deciderUserId: "user_1" }, "env_1")
    ).rejects.not.toThrow(AuthorizationError);
  });
});
