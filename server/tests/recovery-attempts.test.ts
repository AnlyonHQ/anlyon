import { describe, expect, it } from "vitest";
import {
  MAX_RECOVERY_DELIVERIES,
  RECOVERY_DELIVERIES_FIELD,
  nextRecoveryAttempt,
} from "../src/workers/recovery-attempts.ts";

describe("recovery delivery counting", () => {
  it("starts the count from the stream's own delivery count on a first re-add", () => {
    const { totalDeliveries, requeueFields } = nextRecoveryAttempt(["messageId", "msg_1"], 1);
    expect(totalDeliveries).toBe(1);
    expect(requeueFields).toEqual(["messageId", "msg_1", RECOVERY_DELIVERIES_FIELD, "1"]);
  });

  it("carries the count across re-adds instead of resetting it, replacing the old field", () => {
    const { totalDeliveries, requeueFields } = nextRecoveryAttempt(
      ["messageId", "msg_1", RECOVERY_DELIVERIES_FIELD, "4"],
      2,
    );
    expect(totalDeliveries).toBe(6);
    expect(requeueFields).toEqual(["messageId", "msg_1", RECOVERY_DELIVERIES_FIELD, "6"]);
  });

  it("reaches the DLQ threshold for a message that crashes its consumer on every delivery", () => {
    let fields = ["messageId", "msg_poison"];
    let total = 0;
    let readds = 0;
    while (true) {
      const next = nextRecoveryAttempt(fields, 1);
      total = next.totalDeliveries;
      if (total >= MAX_RECOVERY_DELIVERIES) break;
      fields = next.requeueFields;
      readds++;
    }
    expect(total).toBe(MAX_RECOVERY_DELIVERIES);
    expect(readds).toBe(MAX_RECOVERY_DELIVERIES - 1);
  });

  it("ignores a malformed carried count rather than trusting it", () => {
    expect(nextRecoveryAttempt(["messageId", "m", RECOVERY_DELIVERIES_FIELD, "nope"], 1).totalDeliveries).toBe(1);
    expect(nextRecoveryAttempt(["messageId", "m", RECOVERY_DELIVERIES_FIELD, "-5"], 1).totalDeliveries).toBe(1);
  });
});
