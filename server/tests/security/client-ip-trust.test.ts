import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.ts", () => ({ db: {} }));

const { trustedClientIp } = await import("../../src/api/client-ip.ts");
const { auditCaller } = await import("../../src/api/audit-caller.ts");

const headers = (values: Record<string, string>) => (name: string) => values[name.toLowerCase()];

describe("trustedClientIp", () => {
  it("takes the last X-Forwarded-For entry, the one the nearest proxy appended", () => {
    expect(trustedClientIp(headers({ "x-forwarded-for": "6.6.6.6, 198.51.100.4" }))).toBe("198.51.100.4");
    expect(trustedClientIp(headers({ "x-forwarded-for": " 203.0.113.9 " }))).toBe("203.0.113.9");
    expect(trustedClientIp(headers({ "x-forwarded-for": "6.6.6.6,, 2001:db8::7 ," }))).toBe("2001:db8::7");
  });

  it("falls back to X-Real-IP only without X-Forwarded-For, and never reads CF-Connecting-IP", () => {
    expect(trustedClientIp(headers({ "x-real-ip": "198.51.100.8" }))).toBe("198.51.100.8");
    expect(trustedClientIp(headers({ "x-forwarded-for": "198.51.100.4", "x-real-ip": "6.6.6.6" }))).toBe("198.51.100.4");
    expect(trustedClientIp(headers({ "cf-connecting-ip": "6.6.6.6" }))).toBeUndefined();
    expect(trustedClientIp(headers({}))).toBeUndefined();
  });
});

describe("auditCaller", () => {
  it("records the proxy's address, not a spoofed leftmost X-Forwarded-For value", async () => {
    const app = new Hono();
    app.get("/", (c) => c.json(auditCaller(c).context));
    const res = await app.request("/", { headers: { "x-forwarded-for": "6.6.6.6, 198.51.100.4", "user-agent": "test-agent" } });
    expect(await res.json()).toEqual({ ip: "198.51.100.4", userAgent: "test-agent" });
  });
});
