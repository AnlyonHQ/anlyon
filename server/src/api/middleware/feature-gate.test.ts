import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { buildErrorResponse } from "./error.ts";
import { requireFeature } from "./feature-gate.ts";

function app(deployed?: () => boolean) {
  const hono = new Hono();
  hono.onError((error, c) => buildErrorResponse(error, c));
  hono.use("*", requireFeature("functions", deployed));
  hono.get("/functions", (c) => c.json({ ok: true }));
  return hono;
}

describe("requireFeature", () => {
  it("serves a feature the build has, on a deployment that has it", async () => {
    expect((await app(() => true).request("/functions")).status).toBe(200);
  });

  it("answers 404 where the deployment does not have it: hosted functions without a runner", async () => {
    expect((await app(() => false).request("/functions")).status).toBe(404);
  });

  it("refuses a feature the build has switched off whatever the deployment says", async () => {
    const hono = new Hono();
    hono.onError((error, c) => buildErrorResponse(error, c));
    hono.use("*", requireFeature("mcp-events", () => true));
    hono.get("/chat", (c) => c.json({ ok: true }));
    expect((await hono.request("/chat")).status).toBe(404);
  });
});
