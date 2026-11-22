import { afterEach, describe, expect, it, vi } from "vitest";

async function load(edition: "cloud" | "community" | "enterprise") {
  vi.resetModules();
  vi.stubEnv("EDITION", edition);
  vi.stubEnv("RESEND_API_KEY", undefined);
  const [plans, origins, events, signup, mailer] = await Promise.all([
    import("../plans/limits.ts"),
    import("../../utils/origins.ts"),
    import("../../lib/product-events.ts"),
    import("./signup.ts"),
    import("../../lib/resend-client.ts"),
  ]);
  return { plans, origins, events, signup, mailer };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("self-hosted editions", () => {
  it("hold no workspace to a plan's limits", async () => {
    const { plans } = await load("community");
    const free = plans.getPlanLimits("free");
    expect(free).toBe(plans.SELF_HOSTED_LIMITS);
    expect(free.usagePolicy.actionInvokes.kind).toBe("unlimited");
    expect(free.maxSeats).toBe("unlimited");
    expect(free.features.protectedProduction).toBe(true);
  });

  it("trust no anlyon.com origin", async () => {
    const { origins } = await load("community");
    expect(origins.getAllowedOrigins().some((origin) => origin.includes("anlyon.com"))).toBe(false);
  });

  it("record no product events", async () => {
    const { events } = await load("enterprise");
    expect(events.productEventsEnabled()).toBe(false);
  });

  it("default to invitation-only sign-up, and skip email confirmation without a mail server", async () => {
    const { signup, mailer } = await load("community");
    expect(signup.signupMode()).toBe("invite");
    expect(mailer.mailTransport()).toBe("none");
    expect(signup.requiresEmailVerification()).toBe(false);
  });

  it("send email over SMTP when only SMTP is configured", async () => {
    vi.stubEnv("SMTP_URL", "smtp://user:pass@mail.example.com:587");
    vi.stubEnv("FROM_EMAIL", "anlyon@example.com");
    const { signup, mailer } = await load("community");
    expect(mailer.mailTransport()).toBe("smtp");
    expect(mailer.isEmailConfigured()).toBe(true);
    expect(signup.requiresEmailVerification()).toBe(true);
  });
});

describe("cloud", () => {
  it("keeps the anlyon.com console origin, open sign-up and email confirmation", async () => {
    const { origins, signup } = await load("cloud");
    expect(origins.getAllowedOrigins()).toContain("https://console.anlyon.com");
    expect(signup.signupMode()).toBe("open");
    expect(signup.requiresEmailVerification()).toBe(true);
  });
});
