import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  bindExtensionRoutes, enabledStartTasks, extensionSweeps, registerExtension, registeredExtensions, resetExtensions,
  runStartTasks, runStopTasks, type ExtensionApi, type ServerExtension,
} from "./registry.ts";
import { enabledModules, filterOpenApiPaths, isModuleEnabled, isPathEnabled, moduleDefinition } from "../edition/modules.ts";
import { getPlanLimits, upgradesPurchasable, SELF_HOSTED_LIMITS } from "../plans/limits.ts";
import { capture, productEventsEnabled } from "../../lib/product-events.ts";
import { expensiveWorkPaused } from "../billing/work-admission.ts";
import { plannedSweeps } from "../../workers/manager.ts";
import { partitionedLogs } from "../archival/partitioned-logs.ts";
import { KNOWN_VENDORS, knownVendors, type KnownVendor } from "../connections/known-vendors.ts";
import { findIntegrationRoute, isVerifiedVendorEndpoint } from "../connections/integration-route.ts";
import mcpVendorsRouter from "../../api/routes/mcp-vendors.ts";

afterEach(() => resetExtensions());

const router = (body: string) => {
  const r = new Hono();
  r.get("/", (c) => c.text(body));
  return r;
};

const extension = (register: (api: ExtensionApi) => void, name = "test"): ServerExtension => ({ name, register });

describe("modules", () => {
  it("join the registry when an extension defines them, and gate paths like core modules", () => {
    expect(isModuleEnabled("test-module")).toBe(false);
    expect(moduleDefinition("test-module")).toBeUndefined();
    void registerExtension(extension((api) => api.modules.define("test-module", { kind: "cloud", editions: ["cloud"], paths: ["/api/v2/test/*"], summary: "t" })));
    expect(isModuleEnabled("test-module", "cloud")).toBe(true);
    expect(isModuleEnabled("test-module", "community")).toBe(false);
    expect(enabledModules("cloud")).toContain("test-module");
    expect(isPathEnabled("/api/v2/test/x", "cloud")).toBe(true);
    expect(isPathEnabled("/api/v2/test/x", "community")).toBe(false);
    expect(Object.keys(filterOpenApiPaths({ paths: { "/api/v2/test/x": {} } }, "community").paths)).toEqual([]);
  });

  it("never shadow a core module", async () => {
    await expect(registerExtension(extension((api) => api.modules.define("core", { kind: "cloud", editions: ["cloud"], paths: [], summary: "t" }))))
      .rejects.toThrow(/core module/);
  });
});

describe("routes", () => {
  const define = (api: ExtensionApi, editions: ("cloud" | "community")[]) =>
    api.modules.define("test-module", { kind: "cloud", editions, paths: ["/api/v2/test/*"], summary: "t" });

  it("mount on the bound app, whether they register before or after it is bound", async () => {
    const early = new Hono();
    await registerExtension(extension((api) => { define(api, ["cloud"]); api.routes.mount("test-module", "/api/v2/test", router("early")); }, "early"));
    bindExtensionRoutes(early);
    expect(await (await early.request("/api/v2/test")).text()).toBe("early");

    resetExtensions();
    const late = new Hono();
    bindExtensionRoutes(late);
    await registerExtension(extension((api) => { define(api, ["cloud"]); api.routes.mount("test-module", "/api/v2/test", router("late")); }, "late"));
    expect(await (await late.request("/api/v2/test")).text()).toBe("late");
  });

  it("are not mounted in an edition the module is absent from", async () => {
    const app = new Hono();
    bindExtensionRoutes(app);
    await registerExtension(extension((api) => { define(api, ["community"]); api.routes.mount("test-module", "/api/v2/test", router("x")); }));
    expect((await app.request("/api/v2/test")).status).toBe(404);
  });

  it("refuse a path the module does not declare", async () => {
    bindExtensionRoutes(new Hono());
    await expect(registerExtension(extension((api) => { define(api, ["cloud"]); api.routes.mount("test-module", "/api/v2/other", router("x")); })))
      .rejects.toThrow(/does not declare/);
  });
});

describe("sweeps and lifecycle", () => {
  it("add sweeps the worker manager schedules in the module's editions", async () => {
    await registerExtension(extension((api) => {
      api.modules.define("test-module", { kind: "cloud", editions: ["cloud"], paths: [], summary: "t" });
      api.sweeps.add({ name: "Test sweep", context: "test", intervalMs: 1000, module: "test-module", run: async () => {} });
    }));
    expect(extensionSweeps().map((sweep) => sweep.name)).toEqual(["Test sweep"]);
    expect(plannedSweeps("cloud")).toContain("Test sweep");
    expect(plannedSweeps("community")).not.toContain("Test sweep");
  });

  it("run start tasks only in the module's editions, in order, and every stop task", async () => {
    const ran: string[] = [];
    await registerExtension(extension((api) => {
      api.modules.define("on", { kind: "cloud", editions: ["cloud"], paths: [], summary: "t" });
      api.modules.define("off", { kind: "cloud", editions: ["community"], paths: [], summary: "t" });
      api.lifecycle.onStart({ name: "a", module: "on", run: async () => void ran.push("a") });
      api.lifecycle.onStart({ name: "b", module: "off", run: () => void ran.push("b") });
      api.lifecycle.onStart({ name: "c", run: () => void ran.push("c") });
      api.lifecycle.onStop({ name: "d", run: () => { throw new Error("stop failed"); } });
      api.lifecycle.onStop({ name: "e", run: () => void ran.push("e") });
    }));
    expect(enabledStartTasks().map((task) => task.name)).toEqual(["a", "c"]);
    await runStartTasks();
    expect(() => runStopTasks()).not.toThrow();
    expect(ran).toEqual(["a", "c", "e"]);
  });
});

describe("hooks", () => {
  it("default to the self-host core with no extension", () => {
    expect(registeredExtensions()).toEqual([]);
    expect(getPlanLimits("free")).toBe(SELF_HOSTED_LIMITS);
    expect(upgradesPurchasable()).toBe(false);
    expect(productEventsEnabled()).toBe(false);
    expect(expensiveWorkPaused()).toBe(false);
  });

  it("reach core through the API, and go with resetExtensions", async () => {
    const limits = { ...SELF_HOSTED_LIMITS, maxSeats: 3 };
    const events = { enabled: () => true, capture: vi.fn(), captureMilestoneOnce: vi.fn(), captureUserSignedUp: vi.fn(), captureMcpToolCall: vi.fn() };
    await registerExtension(extension((api) => {
      expect(api.name).toBe("test");
      expect(api.edition).toBe("cloud");
      api.plans.provide({ limits: () => limits, purchasable: () => true, epoch: () => 1 });
      api.productEvents.provide(events);
      api.workAdmission.provide({ expensiveWorkPaused: () => true, modelCallsPaused: () => false });
    }));
    expect(getPlanLimits("free")).toBe(limits);
    expect(upgradesPurchasable()).toBe(true);
    capture("e", "ws");
    expect(events.capture).toHaveBeenCalledOnce();
    expect(expensiveWorkPaused()).toBe(true);
    resetExtensions();
    expect(getPlanLimits("free")).toBe(SELF_HOSTED_LIMITS);
    expect(expensiveWorkPaused()).toBe(false);
  });

  it("add a partitioned log the upkeep keeps, until resetExtensions", async () => {
    expect(partitionedLogs().map((spec) => spec.table)).toEqual(["message_execution_logs"]);
    await registerExtension(extension((api) => api.logPartitions.add({
      logType: "test_event", table: "test_event_logs", partitionColumn: "at", partitionFunction: "create_test_log_partition",
      columns: ["id uuid NOT NULL", "at timestamp NOT NULL"], primaryKey: ["id", "at"], indexes: [],
    })));
    expect(partitionedLogs().map((spec) => spec.table)).toEqual(["message_execution_logs", "test_event_logs"]);
    resetExtensions();
    expect(partitionedLogs().map((spec) => spec.table)).toEqual(["message_execution_logs"]);
  });

  it("add a vendor the resolver, the shared client identity and the public list know, until resetExtensions", async () => {
    const acme: KnownVendor = {
      name: "Acme Tools", slug: "acme-tools", domains: ["acme.example"],
      server: { registryName: "example.acme/mcp", url: "https://mcp.acme.example/mcp" }, proven: true,
    };
    expect(knownVendors()).toBe(KNOWN_VENDORS);
    expect(isVerifiedVendorEndpoint("https://mcp.acme.example/mcp")).toBe(false);
    await registerExtension(extension((api) => api.vendors.add(acme)));
    expect(knownVendors()).toEqual([...KNOWN_VENDORS, acme]);
    expect(isVerifiedVendorEndpoint("https://mcp.acme.example/mcp")).toBe(true);
    const route = findIntegrationRoute("Acme Tools", { consoleUrl: "https://console.example", mcpEnabled: true });
    expect(route.route.kind).toBe("mcp");
    expect(route.route.mcp?.registryName).toBe("example.acme/mcp");
    const listed = (await (await mcpVendorsRouter.request("/")).json()) as { data: { vendors: { slug: string }[] } };
    expect(listed.data.vendors.map((vendor) => vendor.slug)).toContain("acme-tools");
    expect(listed.data.vendors).toHaveLength(KNOWN_VENDORS.length + 1);
    resetExtensions();
    expect(knownVendors()).toBe(KNOWN_VENDORS);
    expect(isVerifiedVendorEndpoint("https://mcp.acme.example/mcp")).toBe(false);
  });

  it("refuse a vendor that fails its own check or takes a slug already known", async () => {
    const lookalike: KnownVendor = {
      name: "Acme Tools", slug: "acme-tools", domains: ["acme.example"],
      server: { registryName: "example.acme-mcp/mcp", url: "https://mcp.acme-mcp.example/mcp" },
    };
    await expect(registerExtension(extension((api) => api.vendors.add(lookalike), "lookalike"))).rejects.toThrow(/fails its own check/);
    const [linear] = KNOWN_VENDORS.filter((vendor) => vendor.slug === "linear");
    await expect(registerExtension(extension((api) => api.vendors.add({ ...linear! }), "twice"))).rejects.toThrow(/already known/);
    expect(knownVendors()).toBe(KNOWN_VENDORS);
  });

  it("register an extension once, however often it is asked", async () => {
    const register = vi.fn();
    const ext = extension(register);
    await Promise.all([registerExtension(ext), registerExtension(ext)]);
    expect(register).toHaveBeenCalledOnce();
  });
});
