import { describe, expect, it } from "vitest";
import { putSecretSchema } from "../src/utils/validation.ts";

const hosts = (allowedHosts: string[]) => putSecretSchema.safeParse({ value: "v", allowedHosts }).success;

describe("a secret's allowed hosts", () => {
  it("take a host name, or a suffix that names a domain", () => {
    for (const host of ["api.stripe.com", "localhost", "vault", ".stripe.com", ".api.example.co.uk"]) {
      expect(hosts([host]), host).toBe(true);
    }
  });

  it("refuse a suffix that is a whole top-level domain", () => {
    for (const host of [".com", ".io", ".internal", ".COM"]) {
      expect(hosts([host]), host).toBe(false);
    }
  });
});
