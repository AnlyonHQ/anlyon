import { afterEach, describe, expect, it, vi } from "vitest";
import { INSTANCE_SETTINGS } from "./registry.ts";

async function load(edition: "cloud" | "community") {
  vi.resetModules();
  vi.stubEnv("EDITION", edition);
  for (const definition of INSTANCE_SETTINGS) vi.stubEnv(definition.env, undefined);
  vi.stubEnv("RESEND_API_KEY", undefined);
  return { ...(await import("./settings.ts")), ...(await import("./settings-admin.ts")) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("instance settings registry", () => {
  it("names every key and environment variable once", () => {
    const keys = INSTANCE_SETTINGS.map((definition) => definition.key);
    const envs = INSTANCE_SETTINGS.map((definition) => definition.env);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(envs).size).toBe(envs.length);
    for (const key of keys) expect(key.startsWith("internal.")).toBe(false);
  });

  it("marks every credential as a secret", () => {
    const secrets = INSTANCE_SETTINGS.filter((definition) => definition.secret).map((definition) => definition.env);
    for (const name of ["SMTP_URL", "S3_SECRET_ACCESS_KEY", "ANLYON_LICENSE_KEY", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET", "HUBSPOT_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_CLIENT_SECRET"]) {
      expect(secrets).toContain(name);
    }
  });

  it("keeps EDITION and ENFORCE_HTTPS out of the console", () => {
    const envs = INSTANCE_SETTINGS.map((definition) => definition.env);
    expect(envs).not.toContain("EDITION");
    expect(envs).not.toContain("ENFORCE_HTTPS");
    expect(envs).not.toContain("ANLYON_ROOT_KEY");
  });
});

describe("instanceSetting", () => {
  it("prefers the environment, then the stored setting, then the default", async () => {
    const settings = await load("community");
    expect(settings.instanceSetting("accounts.signup_mode")).toBe("invite");
    expect(settings.instanceSettingSource("accounts.signup_mode")).toBe("default");

    settings.setStoredInstanceSettingsForTest({ "accounts.signup_mode": "closed" });
    expect(settings.instanceSetting("accounts.signup_mode")).toBe("closed");
    expect(settings.instanceSettingSource("accounts.signup_mode")).toBe("database");

    vi.stubEnv("SIGNUP_MODE", "open");
    expect(settings.instanceSetting("accounts.signup_mode")).toBe("open");
    expect(settings.instanceSettingSource("accounts.signup_mode")).toBe("environment");
  });

  it("reads nothing stored on cloud", async () => {
    const settings = await load("cloud");
    settings.setStoredInstanceSettingsForTest({ "email.smtp_url": "smtp://u:p@mail.example.com:587" });
    expect(settings.instanceSetting("email.smtp_url")).toBeUndefined();
    vi.stubEnv("SMTP_URL", "smtp://u:p@env.example.com:587");
    expect(settings.instanceSetting("email.smtp_url")).toBe("smtp://u:p@env.example.com:587");
  });

  it("turns ANLYON_TELEMETRY into the stored form", async () => {
    const settings = await load("community");
    expect(settings.instanceSetting("telemetry.enabled")).toBe("true");
    for (const off of ["off", "0", "false", "OFF"]) {
      vi.stubEnv("ANLYON_TELEMETRY", off);
      expect(settings.instanceSetting("telemetry.enabled")).toBe("false");
    }
    vi.stubEnv("ANLYON_TELEMETRY", "on");
    expect(settings.instanceSetting("telemetry.enabled")).toBe("true");
  });

  it("tells subscribers which settings changed", async () => {
    const settings = await load("community");
    const seen: string[][] = [];
    settings.onInstanceSettingsChange((changed) => seen.push(changed));
    settings.setStoredInstanceSettingsForTest({ "email.from": "anlyon@example.com" });
    expect(seen.at(-1)).toContain("email.from");
  });
});

describe("describeInstanceSettings", () => {
  it("never returns a secret's value, only whether it is set", async () => {
    const settings = await load("community");
    settings.setStoredInstanceSettingsForTest({ "email.smtp_url": "smtp://user:hunter2@mail.example.com:587", "email.from": "anlyon@example.com" });
    const views = settings.describeInstanceSettings();
    const smtp = views.find((view) => view.key === "email.smtp_url")!;
    expect(smtp).not.toHaveProperty("value");
    expect(smtp.set).toBe(true);
    expect(JSON.stringify(views)).not.toContain("hunter2");
    expect(views.find((view) => view.key === "email.from")?.value).toBe("anlyon@example.com");
  });

  it("shows a setting the environment sets as coming from it", async () => {
    const settings = await load("community");
    vi.stubEnv("FROM_EMAIL", "ops@example.com");
    const from = settings.describeInstanceSettings().find((view) => view.key === "email.from")!;
    expect(from.source).toBe("environment");
    expect(from.env).toBe("FROM_EMAIL");
  });
});

describe("validateInstanceSettingChanges", () => {
  it("refuses a setting the environment sets, with a conflict", async () => {
    const settings = await load("community");
    vi.stubEnv("SIGNUP_MODE", "open");
    expect(() => settings.validateInstanceSettingChanges({ "accounts.signup_mode": "closed" })).toThrow(/Set by the environment \(SIGNUP_MODE\)/);
  });

  it("refuses unknown keys, internal keys and invalid values", async () => {
    const settings = await load("community");
    expect(() => settings.validateInstanceSettingChanges({ "nope.nope": "x" })).toThrow(/not valid/);
    expect(() => settings.validateInstanceSettingChanges({ "internal.setup_completed_at": "x" })).toThrow(/not valid/);
    expect(() => settings.validateInstanceSettingChanges({ "accounts.signup_mode": "everyone" })).toThrow(/not valid/);
    expect(() => settings.validateInstanceSettingChanges({ "email.smtp_url": "https://mail.example.com" })).toThrow(/not valid/);
    expect(() => settings.validateInstanceSettingChanges({})).toThrow(/No settings/);
  });

  it("accepts valid values and turns an empty value into a clear", async () => {
    const settings = await load("community");
    expect(
      settings.validateInstanceSettingChanges({ "email.smtp_url": "smtps://u:p@mail.example.com:465", "email.from": " anlyon@example.com ", "storage.s3_bucket": "" }),
    ).toEqual({ "email.smtp_url": "smtps://u:p@mail.example.com:465", "email.from": "anlyon@example.com", "storage.s3_bucket": null });
  });
});
