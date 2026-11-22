import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEditionTestOverride } from "../core/edition/edition.ts";
import { communityRouteTable, OWNER_CORE_ROUTES, recordedCommunityRoutes } from "./fixtures/community-routes.ts";

async function surface(edition: "community" | "cloud", decidedBy: "build" | "override" = "build") {
  vi.resetModules();
  useEditionTestOverride(decidedBy === "override");
  vi.stubEnv("EDITION", edition);
  if (decidedBy === "build") vi.stubEnv("ANLYON_EXTENSIONS", "none");
  const { currentEdition } = await import("../core/edition/edition.ts");
  expect(currentEdition()).toBe(edition);
  const { default: app } = await import("./index.ts");
  const { plannedSweeps } = await import("../workers/manager.ts");
  const { enabledStartTasks, registeredExtensions } = await import("../core/extensions/registry.ts");
  const routes = [...new Set(app.routes.map((route) => `${route.method} ${route.path}`))].sort();
  return { routes, sweeps: plannedSweeps(edition), startTasks: enabledStartTasks().map((task) => task.name), extensions: registeredExtensions() };
}

afterEach(() => {
  vi.unstubAllEnvs();
  useEditionTestOverride(true);
});

vi.setConfig({ testTimeout: 120_000 });

const CORE_SWEEPS = [
  "Log partition upkeep",
  "Usage sync",
  "Usage reconciliation",
  "Approval expiry sweep",
  "Sign-off expiry sweep",
  "Unconfirmed end-user grant sweep",
  "Halt state resync",
  "Assistant advice",
  "Approved invocation resume",
  "Effect reconciliation",
  "OAuth client sweep",
  "Licence seat check",
  "Connected account health sweep",
  "MCP tool check sweep",
  "Audit sink delivery",
  "Audit retention sweep",
];

describe("the community edition with no extensions", () => {
  it("serves exactly the community route table", async () => {
    const { routes, extensions } = await surface("community");
    expect(extensions).toEqual([]);
    expect(routes).toEqual(communityRouteTable());
  });

  it("had none of the routes the owner made core in the recorded table", () => {
    expect(OWNER_CORE_ROUTES.filter((route) => recordedCommunityRoutes().includes(route))).toEqual([]);
  });

  it("schedules core's sweeps and the self-hosted instance telemetry, and starts no extension task", async () => {
    const { sweeps, startTasks } = await surface("community");
    expect([...sweeps].sort()).toEqual([...CORE_SWEEPS, "Instance telemetry"].sort());
    expect(startTasks).toEqual([]);
  });
});

describe("the cloud edition with no extensions (the test override: no build runs it)", () => {
  it("schedules core's sweeps only", async () => {
    const { sweeps } = await surface("cloud", "override");
    expect([...sweeps].sort()).toEqual([...CORE_SWEEPS].sort());
  });
});
