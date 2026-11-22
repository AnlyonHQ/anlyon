import { describe, expect, it } from "vitest";
import { deciderActor, haltActor, provenanceActor } from "./actors.ts";
import { MAX_ATTEMPTS, backoffMs, planAfterFailure } from "./delivery.ts";
import { approvalActor } from "./records.ts";

describe("retry schedule", () => {
  it("doubles from 30 seconds and stops growing at an hour", () => {
    const noJitter = () => 0;
    expect([1, 2, 3, 4].map((n) => backoffMs(n, noJitter))).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(backoffMs(20, noJitter)).toBe(3_600_000);
  });

  it("jitters downward by at most a fifth", () => {
    expect(backoffMs(1, () => 1)).toBe(24_000);
    expect(backoffMs(1, () => 0.5)).toBe(27_000);
  });

  it("retries until the last attempt, then dead-letters", () => {
    const now = new Date("2026-10-19T00:00:00Z");
    const first = planAfterFailure(0, now, () => 0);
    expect(first).toEqual({ kind: "retry", attempts: 1, nextAttemptAt: new Date(now.getTime() + 30_000) });
    expect(planAfterFailure(MAX_ATTEMPTS - 2, now).kind).toBe("retry");
    expect(planAfterFailure(MAX_ATTEMPTS - 1, now)).toEqual({ kind: "dead_letter", attempts: MAX_ATTEMPTS, nextAttemptAt: now });
  });

  it("spans about five hours of retries before giving up on a batch", () => {
    let total = 0;
    for (let n = 1; n < MAX_ATTEMPTS; n++) total += backoffMs(n, () => 0);
    expect(total / 3_600_000).toBeGreaterThan(4);
    expect(total / 3_600_000).toBeLessThan(8);
  });
});

describe("actors", () => {
  it("attributes an approval vote to whoever cast it", () => {
    expect(deciderActor({ deciderUserId: "user_1" })).toEqual({ type: "user", id: "user_1" });
    expect(deciderActor({ deciderKeyId: "key_1" })).toEqual({ type: "api_key", id: "key_1" });
    expect(deciderActor({ deciderOAuthClientId: "client_1", deciderUserId: "user_1" })).toEqual({
      type: "oauth_client", id: "client_1", onBehalfOf: "user_1",
    });
    expect(deciderActor({ assistant: { model: "m" }, deciderUserId: "user_1" })).toEqual({ type: "assistant", id: null });
  });

  it("reads the halt actor string", () => {
    expect(haltActor("key:abc")).toEqual({ type: "api_key", id: "abc" });
    expect(haltActor("user_1")).toEqual({ type: "user", id: "user_1" });
    expect(haltActor(undefined)).toEqual({ type: "system", id: null });
    expect(provenanceActor(undefined)).toEqual({ type: "system", id: null });
  });

  it("attributes approval records to the requester, then the decider", () => {
    const row = {
      requestedByKeyId: "key_req", requestedByUserId: null, requestedByOAuthClientId: null,
      decidedByUserId: "user_dec", decidedByKeyId: null, decisionOrigin: "human", matchedPolicyId: "pol_1",
    };
    expect(approvalActor("approval.requested", row)).toEqual({ type: "api_key", id: "key_req" });
    expect(approvalActor("approval.approved", row)).toEqual({ type: "user", id: "user_dec" });
    expect(approvalActor("approval.denied", { ...row, decisionOrigin: "policy" })).toEqual({ type: "policy", id: "pol_1" });
    expect(approvalActor("approval.approved", { ...row, decisionOrigin: "assistant" })).toEqual({ type: "assistant", id: null });
    expect(approvalActor("approval.expired", row)).toEqual({ type: "system", id: null });
  });
});
