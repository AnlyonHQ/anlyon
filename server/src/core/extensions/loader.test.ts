import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { fileURLToPath } from "node:url";
import { defaultExtensionsDir, discoverExtensions, loadExtensions } from "./loader.ts";
import { bindExtensionRoutes, registeredExtensions, resetExtensions } from "./registry.ts";
import { isModuleEnabled, isPathEnabled } from "../edition/modules.ts";
import { defineExtensionModules } from "./directory.ts";

const fixtures = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

afterEach(() => resetExtensions());

describe("the extension loader", () => {
  it("looks in the server's own extensions directory", () => {
    expect(defaultExtensionsDir()).toBe(fileURLToPath(new URL("../../extensions", import.meta.url)));
  });

  it("finds each directory's index module in name order, skipping _ and . directories", () => {
    expect(discoverExtensions(fixtures("extensions")).map((entry) => entry.name)).toEqual(["alpha"]);
    expect(discoverExtensions(fixtures("does-not-exist"))).toEqual([]);
  });

  it("registers what it finds: modules and routes", async () => {
    const app = new Hono();
    bindExtensionRoutes(app);
    expect(await loadExtensions(fixtures("extensions"))).toEqual(["alpha"]);
    expect(registeredExtensions()).toEqual(["alpha"]);
    expect(isModuleEnabled("alpha-module")).toBe(true);
    expect(await (await app.request("/api/v2/alpha")).text()).toBe("alpha");
  });

  it("loads nothing from a missing directory: the self-host core", async () => {
    expect(await loadExtensions(fixtures("does-not-exist"))).toEqual([]);
    expect(registeredExtensions()).toEqual([]);
  });

  it("reads extensions' module tables without loading them, for tools", async () => {
    expect(await defineExtensionModules(fixtures("extensions"))).toEqual(["alpha-tool-module"]);
    expect(registeredExtensions()).toEqual([]);
    expect(isPathEnabled("/api/v2/alpha-tool/x", "cloud")).toBe(true);
    expect(isPathEnabled("/api/v2/alpha-tool/x", "community")).toBe(false);
  });

  it("fails the boot on a module that is not an extension", async () => {
    await expect(loadExtensions(fixtures("broken"))).rejects.toThrow(/does not default-export a ServerExtension/);
  });
});
