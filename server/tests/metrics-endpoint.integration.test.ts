import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

process.env.METRICS_TOKEN = "test-metrics-token-32-characters!!";
process.env.INTERNAL_AUTH_SECRET ??= "internal-auth-test-secret-0000000000000";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://anlyon:anlyon@localhost:5433/anlyon_test";

let available = false;

beforeAll(async () => {
  const probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  try {
    await probe.query("SELECT 1");
    available = true;
  } catch {
    available = false;
  } finally {
    await probe.end().catch(() => {});
  }
});

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("metrics endpoint (real stack)", () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };

  beforeAll(async () => {
    app = (await import("../src/api/index.ts")).default as typeof app;
  }, 60_000);

  afterAll(async () => {});

  it("rejects a scrape without the token", async () => {
    const res = await app.request("/api/internal/metrics");
    expect(res.status).toBe(401);
  });

  it("serves Prometheus text with platform gauges for the right token", async () => {
    const res = await app.request("/api/internal/metrics", {
      headers: { Authorization: `Bearer ${process.env.METRICS_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const body = await res.text();
    expect(body).toContain("anlyon_workspaces_total");
    expect(body).toContain("anlyon_approvals_pending");
    expect(body).toContain("anlyon_environments_halted");
    expect(body).toContain("anlyon_workspaces_suspended");
    expect(body).toContain("anlyon_runs_last_24h");

    for (const line of body.trim().split("\n")) {
      if (line.startsWith("#")) continue;
      const [name, value] = line.split(" ");
      expect(name).toMatch(/^anlyon_[a-zA-Z0-9_]+$/);
      expect(Number.isFinite(Number(value))).toBe(true);
    }
  });
});
