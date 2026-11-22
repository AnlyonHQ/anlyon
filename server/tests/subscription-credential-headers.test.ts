import { describe, it, expect } from "vitest";
import { createSubscriptionSchema, updateSubscriptionSchema } from "../src/utils/validation.ts";

const BASE = { url: "https://api.example.com/hook" };

function parse(headers: Record<string, string>) {
  return createSubscriptionSchema.safeParse({ ...BASE, headers });
}

describe("subscription credential headers must come from the vault", () => {
  it("refuses a raw bearer token", () => {
    const result = parse({ Authorization: "Bearer raw-token-value" });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/vaulted secret/);
  });

  it("accepts the same header as a secret reference", () => {
    expect(parse({ Authorization: "Bearer {{secret:STRIPE_KEY}}" }).success).toBe(true);
  });

  it("covers the other ways a credential travels", () => {
    for (const name of [
      "authorization",
      "Proxy-Authorization",
      "Cookie",
      "X-Api-Key",
      "api-key",
      "X-Auth-Token",
      "X-Access-Token",
    ]) {
      expect(parse({ [name]: "raw-value" }).success).toBe(false);
    }
  });

  it("is case-insensitive about the header name", () => {
    expect(parse({ AUTHORIZATION: "Bearer x" }).success).toBe(false);
    expect(parse({ aUtHoRiZaTiOn: "Bearer x" }).success).toBe(false);
  });

  it("leaves ordinary headers alone", () => {
    expect(parse({ "X-Correlation-Id": "abc", Accept: "application/json" }).success).toBe(true);
  });

  it("still refuses Anlyon's own reserved signing headers", () => {
    expect(parse({ "Anlyon-Signature": "forged" }).success).toBe(false);
  });

  it("applies when a subscription's headers are changed, not just when it is created", () => {
    expect(updateSubscriptionSchema.safeParse({ headers: { Authorization: "Bearer raw" } }).success).toBe(false);
    expect(updateSubscriptionSchema.safeParse({ headers: { "X-Fine": "ok" } }).success).toBe(true);
  });
});
