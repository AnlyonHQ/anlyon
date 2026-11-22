import { describe, expect, it, vi } from "vitest";
import { signupRefusal, ssoSignupChecks, type SignupChecks } from "./signup.ts";

function checks(overrides: Partial<SignupChecks>): SignupChecks {
  return {
    mode: "invite",
    setupPending: vi.fn(async () => false),
    hasPendingInvitation: vi.fn(async () => false),
    ...overrides,
  };
}

describe("signupRefusal", () => {
  it("lets anyone in when sign-up is open", async () => {
    const open = checks({ mode: "open" });
    expect(await signupRefusal("a@example.com", open)).toBeNull();
    expect(open.hasPendingInvitation).not.toHaveBeenCalled();
  });

  it("refuses every sign-up while the install waits for setup, whatever the mode", async () => {
    for (const mode of ["open", "invite", "closed"] as const) {
      const refusal = await signupRefusal("first@example.com", checks({ mode, setupPending: async () => true, hasPendingInvitation: async () => true }));
      expect(refusal, mode).toMatch(/not set up yet/);
    }
  });

  it("lets an invited email in once the install has an owner", async () => {
    expect(await signupRefusal("invited@example.com", checks({ hasPendingInvitation: async () => true }))).toBeNull();
  });

  it("refuses an uninvited email once the install has an owner", async () => {
    expect(await signupRefusal("stranger@example.com", checks({}))).toMatch(/by invitation/);
  });

  it("refuses everyone when sign-up is closed", async () => {
    const closed = checks({ mode: "closed", hasPendingInvitation: async () => true });
    expect(await signupRefusal("owner@example.com", closed)).toMatch(/closed/);
  });
});

describe("ssoSignupChecks (an SSO sign-in on a verified domain)", () => {
  it("needs no invitation when sign-up is by invitation", async () => {
    const invite = checks({ mode: "invite" });
    expect(await signupRefusal("new@acme.com", ssoSignupChecks(invite))).toBeNull();
    expect(invite.hasPendingInvitation).not.toHaveBeenCalled();
  });

  it("does not open a closed sign-up", async () => {
    expect(await signupRefusal("new@acme.com", ssoSignupChecks(checks({ mode: "closed" })))).toMatch(/closed/);
  });

  it("still waits for setup", async () => {
    const refusal = await signupRefusal("new@acme.com", ssoSignupChecks(checks({ setupPending: async () => true })));
    expect(refusal).toMatch(/not set up yet/);
  });
});
