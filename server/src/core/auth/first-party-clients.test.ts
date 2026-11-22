import { describe, expect, it } from "vitest";
import { firstPartyConfigOf, isAllowedStartUrl, scopesNeedWorkspace, signUpProperties } from "./first-party-clients.ts";

const config = { key: "anlyon.dev", displayName: "anlyon.dev", startUrl: "https://anlyon.dev/auth/login" };

describe("firstPartyConfigOf", () => {
  it("reads the seeded configuration from a skip_consent client", () => {
    expect(firstPartyConfigOf({ skipConsent: true, metadata: { anlyonFirstParty: config } })).toEqual(config);
    expect(firstPartyConfigOf({ skipConsent: true, metadata: JSON.stringify({ anlyonFirstParty: config }) })).toEqual(config);
  });

  it("ignores the metadata of a client that does not skip consent: registration lets anyone write metadata", () => {
    expect(firstPartyConfigOf({ skipConsent: false, metadata: { anlyonFirstParty: config } })).toBeNull();
    expect(firstPartyConfigOf({ skipConsent: null, metadata: { anlyonFirstParty: config } })).toBeNull();
  });

  it("is not first-party while disabled", () => {
    expect(firstPartyConfigOf({ skipConsent: true, disabled: true, metadata: { anlyonFirstParty: config } })).toBeNull();
  });

  it("refuses a start URL that is not https", () => {
    const bad = { ...config, startUrl: "javascript:alert(1)" };
    expect(firstPartyConfigOf({ skipConsent: true, metadata: { anlyonFirstParty: bad } })).toBeNull();
  });
});

describe("isAllowedStartUrl", () => {
  it("allows https and loopback http only", () => {
    expect(isAllowedStartUrl("https://anlyon.dev/auth/login")).toBe(true);
    expect(isAllowedStartUrl("http://localhost:3000/auth/login")).toBe(true);
    expect(isAllowedStartUrl("http://anlyon.dev/auth/login")).toBe(false);
    expect(isAllowedStartUrl("https://user:pw@anlyon.dev/")).toBe(false);
    expect(isAllowedStartUrl("/auth/login")).toBe(false);
  });
});

describe("scopesNeedWorkspace", () => {
  it("is false for identity scopes and true once any anlyon:* group is asked for", () => {
    expect(scopesNeedWorkspace(["openid", "profile", "email"])).toBe(false);
    expect(scopesNeedWorkspace(["openid", "offline_access"])).toBe(false);
    expect(scopesNeedWorkspace([])).toBe(false);
    expect(scopesNeedWorkspace(undefined)).toBe(false);
    expect(scopesNeedWorkspace(["openid", "anlyon:actions"])).toBe(true);
  });
});

describe("signUpProperties", () => {
  it("names the method for email, GitHub and Google, and the first-party source when there is one", () => {
    expect(signUpProperties("/sign-up/email", "anlyon.dev")).toEqual({ method: "email", source: "anlyon.dev" });
    expect(signUpProperties("/callback/github", "anlyon.dev")).toEqual({ method: "github", source: "anlyon.dev" });
    expect(signUpProperties("/callback/google", "anlyon.dev")).toEqual({ method: "google", source: "anlyon.dev" });
  });

  it("sends no source for a sign-up outside a first-party authorize request", () => {
    expect(signUpProperties("/sign-up/email", undefined)).toEqual({ method: "email" });
    expect(signUpProperties("/callback/github", undefined)).toEqual({ method: "github" });
  });
});
