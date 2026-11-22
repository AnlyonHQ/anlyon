import { describe, expect, it, vi } from "vitest";

vi.mock("../../db/index.ts", () => ({ db: {} }));

const { publicRegistrationBody, registrationScopes } = await import("./oauth-registration.ts");
const { DEFAULT_OAUTH_SCOPES } = await import("./oauth-scopes.ts");

describe("registrationScopes", () => {
  it("gives a client that asks for nothing the default grant, not every scope", () => {
    expect(registrationScopes(undefined)).toEqual(DEFAULT_OAUTH_SCOPES);
    expect(registrationScopes("")).toEqual(DEFAULT_OAUTH_SCOPES);
    expect(registrationScopes("   ")).toEqual(DEFAULT_OAUTH_SCOPES);
  });

  it("keeps exactly what a client asked for, sensitive groups only when named", () => {
    expect(registrationScopes("openid offline_access anlyon:actions anlyon:approvals.decide")).toEqual([
      "openid",
      "offline_access",
      "anlyon:actions",
      "anlyon:approvals.decide",
    ]);
    expect(registrationScopes("anlyon:actions  anlyon:actions")).toEqual(["anlyon:actions"]);
  });

  it("drops names it does not offer, and falls back to the default when nothing is left", () => {
    expect(registrationScopes("anlyon:actions made:up")).toEqual(["anlyon:actions"]);
    expect(registrationScopes("made:up")).toEqual(DEFAULT_OAUTH_SCOPES);
    expect(registrationScopes(["anlyon:secrets"])).toEqual(DEFAULT_OAUTH_SCOPES);
  });
});

describe("publicRegistrationBody", () => {
  it("makes every registered client public, whatever it asked for", () => {
    expect(publicRegistrationBody({ redirect_uris: ["http://127.0.0.1:1/cb"] })).toEqual({
      redirect_uris: ["http://127.0.0.1:1/cb"],
      token_endpoint_auth_method: "none",
    });
    expect(publicRegistrationBody({ token_endpoint_auth_method: "client_secret_post" })).toEqual({ token_endpoint_auth_method: "none" });
  });

  it("leaves a body it cannot read to the endpoint's own validation", () => {
    expect(publicRegistrationBody(undefined)).toBeUndefined();
    expect(publicRegistrationBody("text")).toBeUndefined();
    expect(publicRegistrationBody([])).toBeUndefined();
  });
});
