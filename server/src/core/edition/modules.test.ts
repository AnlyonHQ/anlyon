import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { loadContract } from "../../../scripts/contract.ts";
import { mountModule } from "../../api/mount-module.ts";
import { loadExtensions } from "../extensions/loader.ts";
import { EDITIONS } from "./edition.ts";
import {
  enabledModules,
  filterOpenApiPaths,
  isModuleEnabled,
  isPathEnabled,
  MODULES,
  moduleDefinition,
  modulesOwningPath,
  type CoreModuleId,
} from "./modules.ts";

const ids = Object.keys(MODULES) as CoreModuleId[];
const openapi = loadContract(fileURLToPath(new URL("../../../", import.meta.url))) as {
  paths: Record<string, unknown>;
};

describe("module registry", () => {
  it("runs every core module but the self-hosted stand-ins on cloud", () => {
    for (const id of ids) {
      expect(isModuleEnabled(id, "cloud")).toBe(MODULES[id].kind !== "self-hosted");
    }
  });

  it("runs no cloud-only module in a self-hosted edition", () => {
    for (const edition of ["community", "team", "enterprise"] as const) {
      for (const id of enabledModules(edition)) {
        expect(["core", "enterprise", "self-hosted"]).toContain(MODULES[id as CoreModuleId].kind);
      }
      expect(isModuleEnabled("core", edition)).toBe(true);
    }
  });

  it("runs the dead-letter queue and the first-run sandbox in every edition", () => {
    for (const edition of ["cloud", "community", "team", "enterprise"] as const) {
      for (const id of ["dlq", "sandbox", "public-sandbox"] as const) {
        expect(MODULES[id].kind).toBe("core");
        expect(isModuleEnabled(id, edition)).toBe(true);
      }
    }
  });

  it("knows no module nobody defined", () => {
    expect(isModuleEnabled("no-such-module", "cloud")).toBe(false);
  });

  it("assigns every documented API path to a module of this build", async () => {
    await loadExtensions();
    const unowned = Object.keys(openapi.paths).filter((path) => modulesOwningPath(path).length === 0);
    expect(unowned).toEqual([]);
  });

  it("keeps the whole OpenAPI document on cloud, except what only self-hosted modules serve", async () => {
    await loadExtensions();
    const filtered = filterOpenApiPaths(openapi, "cloud");
    const selfHostedOnly = (path: string) => {
      const owners = modulesOwningPath(path);
      return owners.length > 0 && owners.every((id) => moduleDefinition(id)?.kind === "self-hosted");
    };
    const expected = Object.keys(openapi.paths).filter((path) => !selfHostedOnly(path));
    expect(Object.keys(filtered.paths)).toEqual(expected);
    expect(expected.some((path) => path.startsWith("/api/v2/instance/") || path.startsWith("/api/v2/setup"))).toBe(false);
  });

  it("serves first-run setup and instance settings in every self-hosted edition and never on cloud", () => {
    expect(isModuleEnabled("instance", "cloud")).toBe(false);
    for (const edition of ["community", "team", "enterprise"] as const) {
      expect(isModuleEnabled("instance", edition)).toBe(true);
      expect(isPathEnabled("/api/v2/instance/settings", edition)).toBe(true);
      expect(isPathEnabled("/api/v2/setup/owner", edition)).toBe(true);
    }
    expect(isPathEnabled("/api/v2/instance/settings", "cloud")).toBe(false);
    expect(isPathEnabled("/api/v2/setup", "cloud")).toBe(false);
  });

  it("drops cloud-only paths from a self-hosted OpenAPI document", () => {
    for (const edition of ["community", "team", "enterprise"] as const) {
      const paths = Object.keys(filterOpenApiPaths(openapi, edition).paths);
      expect(paths.length).toBeGreaterThan(0);
      expect(paths).toContain("/api/v2/dlq");
      expect(paths).toContain("/api/v2/sandbox/token");
      expect(paths).toContain("/api/v2/public/sandbox/echo");
      expect(paths.some((path) => path.startsWith("/api/v2/public/") && !path.startsWith("/api/v2/public/sandbox/"))).toBe(false);
      expect(paths.some((path) => path.startsWith("/api/v2/feedback"))).toBe(false);
      const billing = paths.filter((path) => path.startsWith("/api/v2/billing"));
      expect(billing.every((path) => MODULES["self-hosted-plan"].paths.includes(path as never))).toBe(true);
      expect(paths).toContain("/api/v2/actions");
    }
  });

  it("matches a subtree pattern on its base path and below, and nothing else", () => {
    expect(isPathEnabled("/api/v2/functions", "community")).toBe(false);
    expect(isPathEnabled("/api/v2/functions/{functionId}", "community")).toBe(false);
    expect(isPathEnabled("/api/v2/functions/{functionId}", "cloud")).toBe(true);
    expect(isPathEnabled("/api/v2/functionsx", "cloud")).toBe(false);
    expect(isPathEnabled("/api/v2/dlq/{messageId}", "community")).toBe(true);
    expect(isPathEnabled("/api/v2/dlqx", "community")).toBe(false);
    expect(isPathEnabled("/mcp", "community")).toBe(true);
  });

  it("serves an MCP server per integration in every edition", () => {
    expect(modulesOwningPath("/mcp/{pack}")).toContain("core");
    for (const edition of EDITIONS) expect(isPathEnabled("/mcp/{pack}", edition)).toBe(true);
  });

  it("offers hosted functions on cloud only: a self-hosted install has no runner to run them", () => {
    expect(isModuleEnabled("functions", "cloud")).toBe(true);
    for (const edition of ["community", "team", "enterprise"] as const) {
      expect(isModuleEnabled("functions", edition)).toBe(false);
    }
  });

  it("keeps licensed paths out of the community edition only", () => {
    for (const path of ["/api/v2/scim/Users", "/api/v2/audit/events", "/api/v2/workspaces/{workspaceId}/audit/sinks", "/api/v2/secret-stores"]) {
      expect(isPathEnabled(path, "community")).toBe(false);
      for (const edition of ["cloud", "team", "enterprise"] as const) expect(isPathEnabled(path, edition)).toBe(true);
    }
    expect(isPathEnabled("/api/v2/workspaces/{workspaceId}/sso", "community")).toBe(true);
    expect(isPathEnabled("/api/v2/slack-approvals", "community")).toBe(true);
  });
});

describe("mountModule", () => {
  const router = () => {
    const r = new Hono();
    r.get("/", (c) => c.text("ok"));
    return r;
  };

  it("mounts an enabled module and serves its routes", async () => {
    const app = new Hono();
    expect(mountModule(app, "dlq", "/api/v2/dlq", router(), "cloud")).toBe(true);
    expect((await app.request("/api/v2/dlq")).status).toBe(200);
  });

  it("leaves a disabled module with no routes at all", async () => {
    for (const edition of EDITIONS.filter((e) => e !== "cloud")) {
      const app = new Hono();
      expect(mountModule(app, "functions", "/api/v2/functions", router(), edition)).toBe(false);
      expect((await app.request("/api/v2/functions")).status).toBe(404);
    }
  });

  it("refuses a mount path the module does not declare", () => {
    expect(() => mountModule(new Hono(), "dlq", "/api/v2/queues", router(), "cloud")).toThrow(/does not declare/);
  });
});

describe("api/index.ts", () => {
  it("mounts nothing cloud-only or legacy without going through mountModule", () => {
    const source = readFileSync(new URL("../../api/index.ts", import.meta.url), "utf8");
    const direct = [...source.matchAll(/app\.route\("([^"]+)"/g)].map((match) => match[1]);
    expect(direct.length).toBeGreaterThan(0);
    for (const path of direct) {
      const owners = modulesOwningPath(path);
      expect({ path, ok: owners.length === 0 || owners.includes("core") }).toEqual({ path, ok: true });
    }
  });
});
