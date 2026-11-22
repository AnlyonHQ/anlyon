import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_NEEDS_EXTENSION, decideEdition, EditionConfigError, useEditionTestOverride } from "./edition.ts";
import { cloudEditionDeclaredBy, extensionManifests, extensionsDisabled } from "../extensions/manifest.ts";

const manifests = (name: string) => fileURLToPath(new URL(`../extensions/fixtures/manifests/${name}`, import.meta.url));
const SERVER_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("decideEdition, in a build without an extension that declares the cloud edition", () => {
  const core = (setting: string | undefined) => decideEdition({ setting, declaredBy: [] });

  it("runs community when EDITION is unset or empty", () => {
    expect(core(undefined)).toEqual({ edition: "community", declaredBy: [] });
    expect(core("")).toEqual({ edition: "community", declaredBy: [] });
    expect(core("  ")).toEqual({ edition: "community", declaredBy: [] });
  });

  it("lets EDITION select a self-hosted edition", () => {
    for (const edition of ["community", "team", "enterprise"]) expect(core(edition).edition).toBe(edition);
  });

  it("refuses EDITION=cloud, saying why", () => {
    expect(() => core("cloud")).toThrow(EditionConfigError);
    expect(() => core("cloud")).toThrow(CLOUD_NEEDS_EXTENSION);
    expect(CLOUD_NEEDS_EXTENSION).toMatch(/community, team or enterprise/);
  });

  it("refuses an edition that does not exist", () => {
    expect(() => core("free")).toThrow(/community, team or enterprise, not "free"/);
  });
});

describe("decideEdition, in the build that carries the cloud extension", () => {
  const cloud = (setting: string | undefined) => decideEdition({ setting, declaredBy: ["cloud"] });

  it("runs cloud with EDITION unset or set to cloud", () => {
    expect(cloud(undefined)).toEqual({ edition: "cloud", declaredBy: ["cloud"] });
    expect(cloud("cloud")).toEqual({ edition: "cloud", declaredBy: ["cloud"] });
  });

  it("runs cloud whatever EDITION says, and names the value it ignored", () => {
    for (const setting of ["community", "team", "enterprise", "anything"]) {
      expect(cloud(setting)).toEqual({ edition: "cloud", declaredBy: ["cloud"], ignoredSetting: setting });
    }
  });
});

describe("decideEdition under the test override", () => {
  it("is EDITION alone, cloud when unset, as the tests assume", () => {
    expect(decideEdition({ setting: undefined, declaredBy: [], testOverride: true }).edition).toBe("cloud");
    expect(decideEdition({ setting: "cloud", declaredBy: [], testOverride: true }).edition).toBe("cloud");
    expect(decideEdition({ setting: "team", declaredBy: ["cloud"], testOverride: true }).edition).toBe("team");
    expect(() => decideEdition({ setting: "free", declaredBy: [], testOverride: true })).toThrow(EditionConfigError);
  });
});

describe("extension manifests", () => {
  it("are read from <name>/extension.json of each extension with an index, in name order", () => {
    expect(extensionManifests(manifests("ok"))).toEqual([
      { name: "declares", manifest: { edition: "cloud" } },
      { name: "empty", manifest: {} },
    ]);
    expect(cloudEditionDeclaredBy(manifests("ok"), {})).toEqual(["declares"]);
    expect(cloudEditionDeclaredBy(manifests("none"), {})).toEqual([]);
    expect(cloudEditionDeclaredBy(manifests("does-not-exist"), {})).toEqual([]);
  });

  it("declare nothing with ANLYON_EXTENSIONS=none: the core alone", () => {
    expect(extensionsDisabled({ ANLYON_EXTENSIONS: "none" })).toBe(true);
    expect(extensionsDisabled({ ANLYON_EXTENSIONS: "None " })).toBe(true);
    expect(extensionsDisabled({})).toBe(false);
    expect(cloudEditionDeclaredBy(manifests("ok"), { ANLYON_EXTENSIONS: "none" })).toEqual([]);
  });

  it("refuse an edition other than cloud, an unknown key and broken JSON", () => {
    expect(() => extensionManifests(manifests("badedition"))).toThrow(/declares the edition "enterprise"; only cloud can be declared/);
    expect(() => extensionManifests(manifests("badkey"))).toThrow(/unknown keys: features/);
    expect(() => extensionManifests(manifests("badjson"))).toThrow(/not valid JSON/);
  });
});

describe("this process, with the override off and no extension loaded", () => {
  beforeEach(() => {
    useEditionTestOverride(false);
    vi.resetModules();
    vi.stubEnv("ANLYON_EXTENSIONS", "none");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    useEditionTestOverride(true);
  });

  it("runs community when EDITION is unset", async () => {
    vi.stubEnv("EDITION", undefined);
    const { currentEdition, isCloudEdition } = await import("./edition.ts");
    expect(currentEdition()).toBe("community");
    expect(isCloudEdition()).toBe(false);
  });

  it("refuses EDITION=cloud at the first read", async () => {
    vi.stubEnv("EDITION", "cloud");
    const { currentEdition } = await import("./edition.ts");
    expect(() => currentEdition()).toThrow(CLOUD_NEEDS_EXTENSION);
  });
});

describe("the boot of a build without the cloud extension", () => {
  function boot(extra: Record<string, string>) {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      ANLYON_EXTENSIONS: "none",
      ...extra,
    };
    return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'await import("./src/config/env.ts");'], {
      cwd: SERVER_ROOT,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  it("stops with a clear message when EDITION=cloud", () => {
    const result = boot({ EDITION: "cloud" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("EDITION: EDITION=cloud is the edition of anlyon.com's own build");
    expect(result.stderr).not.toMatch(/GITHUB_CLIENT_ID|ANLYON_ROOT_KEY/);
  }, 60_000);

  it("stops with a clear message when EDITION=cloud, even with a root key set", () => {
    const result = boot({ EDITION: "cloud", ANLYON_ROOT_KEY: "r".repeat(43) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("EDITION=cloud is the edition of anlyon.com's own build");
  }, 60_000);
});
