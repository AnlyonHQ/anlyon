import { describe, expect, it } from "vitest";
import { twoFactor } from "../src/db/schema/two-factor.ts";
import { user } from "../src/db/schema/user.ts";

describe("two-factor authentication schema", () => {
  it("keeps the enabled flag separate from encrypted authenticator material", () => {
    expect(user.twoFactorEnabled.name).toBe("two_factor_enabled");
    expect(user.twoFactorEnabled.notNull).toBe(true);
    expect(user.twoFactorEnabled.default).toBe(false);

    expect(twoFactor.secret.name).toBe("secret");
    expect(twoFactor.backupCodes.name).toBe("backup_codes");
    expect(twoFactor.userId.name).toBe("user_id");
    expect(twoFactor.failedVerificationCount.default).toBe(0);
    expect(twoFactor.lockedUntil.name).toBe("locked_until");
  });
});
