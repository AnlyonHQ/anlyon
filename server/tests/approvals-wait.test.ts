import { describe, it, expect, vi } from "vitest";
import { pollUntilDecided } from "../src/core/approvals/service.ts";
import { getApprovalQuerySchema, MAX_APPROVAL_WAIT_SECONDS } from "../src/utils/validation.ts";

type Approval = Awaited<ReturnType<typeof pollUntilDecided>>;

function approval(status: Approval["status"]): Approval {
  return {
    id: "apr_test",
    kind: "custom",
    status,
    title: "Send the contract?",
    description: null,
    payload: {},
    decisionNote: null,
    expiresAt: new Date(Date.now() + 3600_000),
    decidedAt: status === "pending" ? null : new Date(),
    createdAt: new Date(),
  };
}

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
}

describe("pollUntilDecided", () => {
  it("returns immediately when the approval is already decided", async () => {
    const clock = fakeClock();
    const read = vi.fn().mockResolvedValue(approval("approved"));

    const result = await pollUntilDecided(read, { waitSeconds: 30, ...clock });

    expect(result.status).toBe("approved");
    expect(read).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("resolves as soon as the human decides mid-wait", async () => {
    const clock = fakeClock();
    const read = vi
      .fn()
      .mockResolvedValueOnce(approval("pending"))
      .mockResolvedValueOnce(approval("pending"))
      .mockResolvedValueOnce(approval("denied"));

    const result = await pollUntilDecided(read, {
      waitSeconds: 30,
      intervalMs: 1500,
      ...clock,
    });

    expect(result.status).toBe("denied");
    expect(read).toHaveBeenCalledTimes(3);
    expect(clock.sleep).toHaveBeenCalledTimes(2);
  });

  it("returns the pending approval once the deadline passes (a timeout is not an error)", async () => {
    const clock = fakeClock();
    const read = vi.fn().mockResolvedValue(approval("pending"));

    const result = await pollUntilDecided(read, {
      waitSeconds: 5,
      intervalMs: 1500,
      ...clock,
    });

    expect(result.status).toBe("pending");
    expect(clock.sleep).toHaveBeenCalledTimes(4);
    expect(clock.sleep).toHaveBeenLastCalledWith(500);
  });

  it("never sleeps past the deadline", async () => {
    const clock = fakeClock();
    const read = vi.fn().mockResolvedValue(approval("pending"));

    await pollUntilDecided(read, { waitSeconds: 1, intervalMs: 5000, ...clock });

    expect(clock.sleep).toHaveBeenCalledTimes(1);
    expect(clock.sleep).toHaveBeenCalledWith(1000);
  });

  it("waitSeconds=0 is a plain read", async () => {
    const clock = fakeClock();
    const read = vi.fn().mockResolvedValue(approval("pending"));

    const result = await pollUntilDecided(read, { waitSeconds: 0, ...clock });

    expect(result.status).toBe("pending");
    expect(read).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("clamps an over-long wait to the ceiling", async () => {
    const clock = fakeClock();
    const read = vi.fn().mockResolvedValue(approval("pending"));

    await pollUntilDecided(read, { waitSeconds: 600, intervalMs: 10_000, ...clock });

    const slept = clock.sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0);
    expect(slept).toBe(MAX_APPROVAL_WAIT_SECONDS * 1000);
  });
});

describe("getApprovalQuerySchema", () => {
  it("coerces the query string to an int", () => {
    expect(getApprovalQuerySchema.parse({ waitSeconds: "30" })).toEqual({ waitSeconds: 30 });
  });

  it("clamps rather than rejects an over-long wait", () => {
    expect(getApprovalQuerySchema.parse({ waitSeconds: "300" })).toEqual({
      waitSeconds: MAX_APPROVAL_WAIT_SECONDS,
    });
  });

  it("clamps a negative wait to zero", () => {
    expect(getApprovalQuerySchema.parse({ waitSeconds: "-5" })).toEqual({ waitSeconds: 0 });
  });

  it("is optional  a plain read passes no param", () => {
    expect(getApprovalQuerySchema.parse({})).toEqual({});
  });

  it("rejects a non-numeric wait", () => {
    expect(getApprovalQuerySchema.safeParse({ waitSeconds: "soon" }).success).toBe(false);
  });
});
