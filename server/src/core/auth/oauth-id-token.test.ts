import { describe, expect, it } from "vitest";
import { idTokenProfileClaims } from "./oauth-id-token.ts";

const ada = { name: "Ada King Lovelace", email: "ada@example.com", emailVerified: true, image: "https://example.com/ada.png" };

describe("idTokenProfileClaims", () => {
  it("carries profile and email claims for the scopes that granted them", () => {
    expect(idTokenProfileClaims(ada, ["openid", "profile", "email"])).toEqual({
      name: "Ada King Lovelace",
      picture: "https://example.com/ada.png",
      given_name: "Ada King",
      family_name: "Lovelace",
      email: "ada@example.com",
      email_verified: true,
    });
  });

  it("adds nothing the scopes did not grant", () => {
    expect(idTokenProfileClaims(ada, ["openid"])).toEqual({});
    expect(Object.keys(idTokenProfileClaims(ada, ["openid", "email"]))).toEqual(["email", "email_verified"]);
    expect(Object.keys(idTokenProfileClaims(ada, ["openid", "profile"]))).not.toContain("email");
  });

  it("splits a name only when there is more than one part, and treats an unknown verification as false", () => {
    const claims = idTokenProfileClaims({ name: "Ada", email: "a@example.com", emailVerified: null, image: null }, ["profile", "email"]);
    expect(claims.given_name).toBeUndefined();
    expect(claims.family_name).toBeUndefined();
    expect(claims.picture).toBeUndefined();
    expect(claims.email_verified).toBe(false);
  });
});
