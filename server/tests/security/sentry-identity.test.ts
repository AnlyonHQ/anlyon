import { describe, expect, it } from "vitest";
import { resolveSentryIdentity } from "../../src/lib/sentry.ts";

describe("resolveSentryIdentity", () => {
  it("refuses to call a non-production process production", () => {
    expect(resolveSentryIdentity({ nodeEnv: "development", sentryEnvironment: "production" })).toMatchObject({
      environment: "development",
      overridden: true,
    });
    expect(resolveSentryIdentity({ nodeEnv: "test", sentryEnvironment: "production" }).environment).toBe("test");
  });

  it("keeps production for a production process", () => {
    expect(resolveSentryIdentity({ nodeEnv: "production", sentryEnvironment: "production" })).toMatchObject({
      environment: "production",
      overridden: false,
    });
  });

  it("honours other explicit names, such as staging on a production build", () => {
    expect(resolveSentryIdentity({ nodeEnv: "production", sentryEnvironment: "staging" }).environment).toBe("staging");
    expect(resolveSentryIdentity({ nodeEnv: "development", sentryEnvironment: "local-dev" }).environment).toBe("local-dev");
  });

  it("falls back to NODE_ENV when no environment is configured", () => {
    expect(resolveSentryIdentity({ nodeEnv: "development" }).environment).toBe("development");
  });

  it("files the release under the image's build SHA, not a hand-kept label", () => {
    expect(resolveSentryIdentity({ nodeEnv: "production", sentryRelease: "v1.0.0", buildSha: "abc1234" }).release).toBe("abc1234");
    expect(resolveSentryIdentity({ nodeEnv: "production", sentryRelease: "v1.0.0", buildSha: "unknown" }).release).toBe("v1.0.0");
    expect(resolveSentryIdentity({ nodeEnv: "development" }).release).toBeUndefined();
  });
});
