import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ApiError } from "../src/utils/errors.ts";

const gate = vi.hoisted(() => ({ off: false }));
vi.mock("@anlyon/feature-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anlyon/feature-flags")>();
  return { ...actual, isFeatureEnabled: (key: string) => !(gate.off && key === "connected-accounts") && actual.isFeatureEnabled(key as never) };
});

const { isFeatureEnabled } = await import("@anlyon/feature-flags");

describe("connected-accounts feature gate", () => {
  it("is reachable in this build", () => {
    expect(isFeatureEnabled("connected-accounts")).toBe(true);
  });

  it("the connections router and the consent routes answer 404 with no credentials while unavailable", async () => {
    gate.off = true;
    try {
      const connections = (await import("../src/api/routes/connections.ts")).default;
      const consent = (await import("../src/api/routes/connection-consent.ts")).default;
      const app = new Hono();
      app.onError((error, c) => c.json({ code: error instanceof ApiError ? error.code : "ERR" }, error instanceof ApiError ? (error.statusCode as 404) : 500));
      app.route("/api/v2/connections", connections);
      app.route("/api/v2/connection-consent", consent);
      app.route("/", (await import("../src/api/routes/connection-consent.ts")).connectPagesRouter);
      for (const [method, path] of [["GET", "/api/v2/connections"], ["GET", "/api/v2/connections/integrations"], ["GET", "/api/v2/connections/integrations/find?name=figma"], ["POST", "/api/v2/connections/sessions"], ["POST", "/api/v2/connections/HUBSPOT/check"], ["POST", "/api/v2/connections/HUBSPOT/reconnect"], ["GET", "/api/v2/connection-consent/start"], ["GET", "/api/v2/connection-consent/callback"]]) {
        const res = await app.request(path, { method });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    } finally {
      gate.off = false;
    }
  }, 30_000);
});
