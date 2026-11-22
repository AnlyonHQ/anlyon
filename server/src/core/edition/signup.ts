import { env } from "../../config/env.ts";
import { isEmailConfigured } from "../../lib/resend-client.ts";
import { getPendingInvitationsForEmail } from "../workspace/invitations.ts";
import { instanceSetting } from "../instance/settings.ts";
import { isSetupPending } from "../instance/setup.ts";
import { isCloudEdition } from "./edition.ts";

export type SignupMode = "open" | "invite" | "closed";

export function signupMode(): SignupMode {
  if (isCloudEdition()) return env.SIGNUP_MODE ?? "open";
  return (instanceSetting("accounts.signup_mode") as SignupMode | undefined) ?? "invite";
}

export function requiresEmailVerification(): boolean {
  return isCloudEdition() || isEmailConfigured();
}

export interface SignupChecks {
  mode: SignupMode;
  setupPending: () => Promise<boolean>;
  hasPendingInvitation: (email: string) => Promise<boolean>;
}

export async function signupRefusal(email: string, checks: SignupChecks): Promise<string | null> {
  if (await checks.setupPending()) {
    return "This server is not set up yet. Its administrator creates the first account from the setup page, with the setup token.";
  }
  switch (checks.mode) {
    case "open":
      return null;
    case "closed":
      return "Sign-up is closed on this server. Ask its administrator to create your account.";
    case "invite":
      if (await checks.hasPendingInvitation(email)) return null;
      return "Sign-up on this server is by invitation. Ask a workspace owner to invite this email address.";
  }
}

export const defaultSignupChecks = (): SignupChecks => ({
  mode: signupMode(),
  setupPending: isCloudEdition() ? async () => false : isSetupPending,
  hasPendingInvitation: async (email) => (await getPendingInvitationsForEmail(email)).length > 0,
});

export function ssoSignupChecks(checks: SignupChecks): SignupChecks {
  return checks.mode === "invite" ? { ...checks, mode: "open" } : checks;
}
