import { describe, expect, it } from "vitest";
import {
  createApprovalPolicySchema,
  createEnvironmentApprovalPolicySchema,
  listApprovalsQuerySchema,
  updateApprovalPolicySchema,
  updateEnvironmentApprovalPolicySchema,
} from "./validation.ts";

describe("policy request validation", () => {
  it("requires explicit targeting on create; an omitted matchKind no longer means 'every request'", () => {
    expect(createEnvironmentApprovalPolicySchema.safeParse({ name: "p" }).success).toBe(false);
    expect(createEnvironmentApprovalPolicySchema.safeParse({ name: "p", matchKind: "any" }).success).toBe(true);
    const env = "00000000-0000-4000-8000-000000000000";
    expect(createApprovalPolicySchema.safeParse({ name: "p", environmentId: env }).success).toBe(false);
  });

  it("rejects a body that names an environment on the credential-scoped API", () => {
    const parsed = createEnvironmentApprovalPolicySchema.safeParse({
      name: "p",
      matchKind: "custom",
      environmentId: "00000000-0000-4000-8000-000000000000",
    });
    expect(parsed.success).toBe(false);
    expect(updateEnvironmentApprovalPolicySchema.safeParse({ environmentId: "x", enabled: true }).success).toBe(false);
  });

  it("rejects an empty action name", () => {
    expect(createEnvironmentApprovalPolicySchema.safeParse({ name: "p", matchKind: "action", matchActionName: "" }).success).toBe(false);
  });

  it("PATCH keeps an explicit null and omits what was not sent", () => {
    const parsed = updateEnvironmentApprovalPolicySchema.parse({ minAmount: null, matchAgentId: null, priority: 3 });
    expect(parsed).toEqual({ minAmount: null, matchAgentId: null, priority: 3 });
    expect(Object.prototype.hasOwnProperty.call(parsed, "matchActionName")).toBe(false);
    expect(updateEnvironmentApprovalPolicySchema.parse({ matchActionName: null }).matchActionName).toBeNull();
  });

  it("PATCH needs at least one field", () => {
    expect(updateApprovalPolicySchema.safeParse({}).success).toBe(false);
    expect(updateEnvironmentApprovalPolicySchema.safeParse({}).success).toBe(false);
  });

  it("the approvals inbox filters by who decided", () => {
    expect(listApprovalsQuerySchema.parse({ decisionOrigin: "automated" }).decisionOrigin).toBe("automated");
    expect(listApprovalsQuerySchema.safeParse({ decisionOrigin: "robot" }).success).toBe(false);
  });
});
