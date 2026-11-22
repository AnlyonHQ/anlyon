import { describe, it, expect, vi } from "vitest";

const rows = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/redis.ts", () => ({ RedisKeys: {}, redis: {} }));
vi.mock("../src/db/index.ts", () => ({
  db: { select: () => ({ from: () => ({ where: () => rows() }) }) },
}));

const { assertSecretsMayReachHost } = await import("../src/core/actions/secrets.ts");

describe("an external secret with no allowed hosts", () => {
  it("is refused with the fix in the message", async () => {
    rows.mockResolvedValue([{ name: "STRIPE_KEY", kind: "external", allowedHosts: null, allowedPlacements: ["header"] }]);
    const error = await assertSecretsMayReachHost("ws_1", ["STRIPE_KEY"], "https://api.stripe.com/v1/refunds", "env_1").catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/Set allowed hosts on secret STRIPE_KEY/);
    expect(error.message).toMatch(/include api\.stripe\.com/);
    expect(error.message).toMatch(/PUT \/secrets\/STRIPE_KEY/);
  });

  it("a stored secret with no hosts still goes anywhere public, as before", async () => {
    rows.mockResolvedValue([{ name: "PLAIN", kind: "static", allowedHosts: null, allowedPlacements: null }]);
    await expect(assertSecretsMayReachHost("ws_1", ["PLAIN"], "https://api.example.com", "env_1")).resolves.toBeUndefined();
  });
});
