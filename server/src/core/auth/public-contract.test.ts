import { describe, expect, it } from "vitest";
import { apiKeyScopeSchema, createApiKeySchema } from "../../utils/validation.ts";
import { DEFAULT_API_KEY_SCOPES } from "./api-key-scopes.ts";
import { toPublicApiKey } from "./public-api-key.ts";
import { toPublicWorkspace } from "../workspace/public-workspace.ts";
import { toPublicWorkspaceMember } from "../workspace/public-member.ts";

describe("workspace administration public contract", () => {
  it("keeps API-key validation in lockstep with every supported scope", () => {
    for (const scope of DEFAULT_API_KEY_SCOPES) {
      expect(apiKeyScopeSchema.parse(scope)).toBe(scope);
    }
    expect(apiKeyScopeSchema.safeParse("root:everything").success).toBe(false);
  });

  it("never includes key hashes in public API-key metadata", () => {
    const storedKey = {
      id: "key-id",
      workspaceId: "workspace-id",
      name: "Production",
      keyPrefix: "anlyon_live_example",
      version: 1,
      isActive: "true",
      lastUsedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: null,
      scopes: null,
      keyHash: "should-not-compile-into-the-result",
    };
    const result = toPublicApiKey(storedKey);

    expect(result).not.toHaveProperty("keyHash");
    expect(result.scopes).toEqual(DEFAULT_API_KEY_SCOPES);
  });

  it("keeps payment-provider identifiers out of workspace responses", () => {
    const storedWorkspace = {
      id: "workspace-id",
      name: "Example",
      slug: "example",
      plan: "paygo",
      subscriptionStatus: "active",
      trialEndsAt: null,
      monthlyMessageQuota: "1000",
      currentMonthMessages: 10,
      currentMonthBandwidth: 20,
      usageResetDate: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      deliverySuspendedAt: new Date("2026-01-02T00:00:00.000Z"),
      deliverySuspendedReason: "internal review note",
    };
    const result = toPublicWorkspace(storedWorkspace);

    expect(result).not.toHaveProperty("deliverySuspendedAt");
    expect(result).not.toHaveProperty("deliverySuspendedReason");
  });

  it("rejects API-key expirations that are already in the past", () => {
    expect(createApiKeySchema.safeParse({
      name: "Expired",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }).success).toBe(false);
  });

  it("uses one member shape with nested user details", () => {
    const member = toPublicWorkspaceMember({
      id: "membership-id",
      workspaceId: "workspace-id",
      userId: "user-id",
      role: "member",
      invitedBy: null,
      invitedAt: null,
      joinedAt: new Date("2026-01-01T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      userName: "Ada",
      userEmail: "ada@example.com",
    });

    expect(member.user).toEqual({ name: "Ada", email: "ada@example.com" });
    expect(member).not.toHaveProperty("userName");
    expect(member).not.toHaveProperty("userEmail");
  });
});
