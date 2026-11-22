import { describe, expect, it } from "vitest";
import { expiredDecision, humanDecision, policyDecision, toPublicDecision } from "./decision.ts";

const at = new Date("2026-09-20T08:14:03.221Z");
const policy = { id: "apol_1", name: "refund_order_denied", version: 2 };

describe("invocation decision snapshots", () => {
  it("explains a policy denial from the snapshot alone", () => {
    const d = policyDecision("denied", policy, at);
    expect(d).toMatchObject({ source: "policy", code: "POLICY_DENIED", effect: "denied", policy });
    expect(d.explanation).toBe('Denied by policy "refund_order_denied", version 2. The request was not sent.');
    expect(d.decidedAt).toBe(at.toISOString());
  });

  it("records who decided without naming a reviewer or a policy for a human decision", () => {
    expect(humanDecision("denied", at)).toMatchObject({ source: "human", code: "HUMAN_DENIED", policy: null });
    expect(humanDecision("approved", at).explanation).toBe("Approved by a reviewer.");
  });

  it("attributes expiry to the system", () => {
    expect(expiredDecision(at)).toMatchObject({ source: "system", code: "APPROVAL_EXPIRED", effect: "expired" });
  });

  it("cannot be broken by a hostile policy name: it is quoted and length-capped", () => {
    const d = policyDecision("denied", { ...policy, name: 'x" injected ' + "y".repeat(500) }, at);
    expect(d.explanation.length).toBeLessThan(200);
    expect(d.explanation).toContain('\\"');
  });

  it("re-projects a stored value field by field, so extra stored keys never reach the API", () => {
    const stored = {
      ...policyDecision("denied", policy, at),
      conditions: { amount: 9999 },
      secret: "sk_live_x",
      policy: { ...policy, matchers: ["internal"] },
    };
    const out = toPublicDecision(stored)!;
    expect(JSON.stringify(out)).not.toContain("sk_live_x");
    expect(JSON.stringify(out)).not.toContain("conditions");
    expect(JSON.stringify(out)).not.toContain("matchers");
    expect(out.policy).toEqual(policy);
  });

  it("returns null for absent or malformed snapshots rather than inventing one", () => {
    expect(toPublicDecision(null)).toBeNull();
    expect(toPublicDecision({})).toBeNull();
    expect(toPublicDecision("denied")).toBeNull();
  });
});
