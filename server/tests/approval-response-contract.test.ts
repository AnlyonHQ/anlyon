import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { toApproval, toApprovalVote } from "../src/core/approvals/service.ts";

const api = parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));
const schema = api.components.schemas.Approval as {
  required: string[];
  properties: Record<string, { type?: string; nullable?: boolean; enum?: unknown[] }>;
};

const base = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  environmentId: "00000000-0000-4000-8000-000000000003",
  approvalId: "apr_test",
  kind: "action",
  status: "denied",
  title: "Run action refund_order",
  description: null,
  payload: {},
  requestedByKeyId: null,
  decidedByUserId: null,
  decidedByKeyId: null,
  decisionNote: null,
  traceRunId: null,
  traceParentSpanId: null,
  traceStartedAt: null,
  expiresAt: new Date("2026-09-21T00:00:00Z"),
  decidedAt: new Date("2026-09-20T00:00:00Z"),
  createdAt: new Date("2026-09-20T00:00:00Z"),
};

const governed = {
  ...base,
  requiredApprovals: 2,
  approvedCount: 0,
  matchedPolicyId: "apol_1",
  matchedPolicyVersion: 3,
  policyExplanation: 'Matched policy "refund_order_denied"',
  decisionOrigin: "policy",
} as never;

const historical = {
  ...base,
  requiredApprovals: 1,
  approvedCount: 0,
  matchedPolicyId: null,
  matchedPolicyVersion: null,
  policyExplanation: null,
  decisionOrigin: null,
} as never;

const check = (value: Record<string, unknown>) => {
  const declared = Object.keys(schema.properties);
  expect(Object.keys(value).filter((k) => !declared.includes(k))).toEqual([]);
  for (const required of schema.required) expect(Object.keys(value), `missing ${required}`).toContain(required);
  for (const [key, def] of Object.entries(schema.properties)) {
    if (value[key] === null) expect(def.nullable, `${key} is null but the contract says it is not nullable`).toBe(true);
    if (def.enum && value[key] !== null) expect(def.enum, key).toContain(value[key]);
  }
};

describe("approval response contract", () => {

  it("reports persisted final reviewer identities without exposing key values or inventing names", () => {
    for (const identity of [
      { decidedByKeyId: "key_identity", decidedByUserId: null, type: "api_key", id: "key_identity" },
      { decidedByKeyId: null, decidedByUserId: "user_identity", type: "user", id: "user_identity" },
    ]) {
      const out = toApproval({ ...base, requiredApprovals: 1, approvedCount: 0,
        matchedPolicyId: null, matchedPolicyVersion: null, policyExplanation: null,
        decisionOrigin: "human", ...identity } as never);
      check(out as never);
      expect(out.decidedBy).toEqual({ type: identity.type, id: identity.id, displayName: null });
    }
  });

  it("never guesses a reviewer from pending, expired, absent or ambiguous identity data", () => {
    for (const patch of [
      { status: "pending", decidedByKeyId: "key" },
      { status: "expired", decidedByKeyId: "key" },
      { decisionOrigin: "policy", decidedByKeyId: "key" },
      { decisionOrigin: "assistant", decidedByKeyId: "key" },
      {},
      { decidedByKeyId: "key", decidedByUserId: "user" },
    ]) {
      expect(toApproval({ ...base, ...patch } as never).decidedBy).toBeNull();
    }
  });

  it("projects vote evidence without returning internal row IDs or extra fields", () => {
    const decidedAt = new Date("2026-09-25T20:39:30Z");
    expect(toApprovalVote({ id: "internal", approvalId: "internal_parent", decision: "deny",
      deciderKeyId: "key_id", deciderUserId: null, note: "Verified by support", decidedAt,
    })).toEqual({ decision: "deny", decidedBy: { type: "api_key", id: "key_id", displayName: null },
      note: "Verified by support", decidedAt });
  });
  it("a governed approval serializes exactly what OpenAPI declares", () => {
    const out = toApproval(governed);
    check(out as never);
    expect(out).toMatchObject({ requiredApprovals: 2, matchedPolicyId: "apol_1", matchedPolicyVersion: 3, decisionOrigin: "policy" });
    expect(out.policyExplanation).toContain("refund_order_denied");
  });

  it("a historical approval reports null policy fields, never an invented explanation", () => {
    const out = toApproval(historical);
    check(out as never);
    expect(out).toMatchObject({ matchedPolicyId: null, matchedPolicyVersion: null, policyExplanation: null, decisionOrigin: null });
  });

  it("version is null exactly when the policy id is", () => {
    for (const row of [governed, historical] as Array<{ matchedPolicyId: string | null; matchedPolicyVersion: number | null }>) {
      const out = toApproval(row as never);
      expect(out.matchedPolicyVersion === null).toBe(out.matchedPolicyId === null);
    }
  });
});
