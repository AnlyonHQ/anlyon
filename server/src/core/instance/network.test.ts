import { afterEach, describe, expect, it, vi } from "vitest";

async function load(edition: "cloud" | "community" | "enterprise") {
  vi.resetModules();
  vi.stubEnv("EDITION", edition);
  vi.stubEnv("PRIVATE_NETWORK_DESTINATIONS", undefined);
  const settings = await import("./settings.ts");
  const admin = await import("./settings-admin.ts");
  const network = await import("./network.ts");
  return { ...settings, ...admin, ...network };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("private network destinations", () => {
  it("are left to each workspace's admins by default on a self-hosted edition, as before the setting", async () => {
    const m = await load("community");
    expect(m.instanceSetting("network.private_destinations")).toBe("workspace");
    expect(m.privateDestinationPolicy()).toBe("workspace");
    expect(m.privateDestinationsOffered()).toBe(true);
    expect(m.privateDestinationsRefusal("audit sinks")).toBeNull();
  });

  it("are refused in every workspace once an instance admin turns them off", async () => {
    const m = await load("enterprise");
    m.setStoredInstanceSettingsForTest({ "network.private_destinations": "off" });
    expect(m.privateDestinationPolicy()).toBe("off");
    expect(m.privateDestinationsOffered()).toBe(false);
    expect(m.privateDestinationsRefusal("secret stores")).toMatch(/instance admin has turned off private network destinations on this install, so secret stores must use public addresses/);
    m.setStoredInstanceSettingsForTest({ "network.private_destinations": "workspace" });
    expect(m.privateDestinationsOffered()).toBe(true);
  });

  it("follow PRIVATE_NETWORK_DESTINATIONS over the stored setting, and treat a mistyped value as off", async () => {
    const m = await load("community");
    m.setStoredInstanceSettingsForTest({ "network.private_destinations": "workspace" });
    vi.stubEnv("PRIVATE_NETWORK_DESTINATIONS", "off");
    expect(m.privateDestinationPolicy()).toBe("off");
    expect(m.instanceSettingSource("network.private_destinations")).toBe("environment");
    vi.stubEnv("PRIVATE_NETWORK_DESTINATIONS", "never");
    expect(m.privateDestinationPolicy()).toBe("off");
    vi.stubEnv("PRIVATE_NETWORK_DESTINATIONS", "workspace");
    expect(m.privateDestinationPolicy()).toBe("workspace");
  });

  it("are never offered on cloud, whatever is stored or set", async () => {
    const m = await load("cloud");
    m.setStoredInstanceSettingsForTest({ "network.private_destinations": "workspace" });
    vi.stubEnv("PRIVATE_NETWORK_DESTINATIONS", "workspace");
    expect(m.privateDestinationPolicy()).toBe("cloud");
    expect(m.privateDestinationsOffered()).toBe(false);
    expect(m.privateDestinationsRefusal("audit sinks")).toBe("Private network destinations are available on self-hosted deployments only.");
  });

  it("is an instance setting that takes workspace or off, nothing else", async () => {
    const m = await load("community");
    expect(m.validateInstanceSettingChanges({ "network.private_destinations": "off" })).toEqual({ "network.private_destinations": "off" });
    expect(m.validateInstanceSettingChanges({ "network.private_destinations": null })).toEqual({ "network.private_destinations": null });
    expect(() => m.validateInstanceSettingChanges({ "network.private_destinations": "all" })).toThrow(/not valid/);
    const view = m.describeInstanceSettings().find((setting) => setting.key === "network.private_destinations");
    expect(view).toMatchObject({ group: "network", value: "workspace", source: "default", default: "workspace", env: "PRIVATE_NETWORK_DESTINATIONS", secret: false });
  });
});
