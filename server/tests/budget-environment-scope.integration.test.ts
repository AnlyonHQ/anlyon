import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
vi.mock("../src/api/governance-gate.ts", async (importOriginal) => ({ ...(await importOriginal<object>()), signOffIfLoosening: async () => null }));

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

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("budget environment scope (real stack, HTTP)", () => {
  let pool: Pool;
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let keysSvc: typeof import("../src/core/auth/api-keys.ts");
  let envSvc: typeof import("../src/core/environments/service.ts");

  let userId: string;
  let workspaceId: string;
  let production: { id: string };
  let staging: { id: string };
  let productionKeyId: string;
  let stagingKeyId: string;
  let productionKey: string;
  let stagingKey: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = (await import("../src/api/index.ts")).default as typeof app;
    keysSvc = await import("../src/core/auth/api-keys.ts");
    envSvc = await import("../src/core/environments/service.ts");

    userId = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'T', $2, false, now(), now())`,
      [userId, `${userId}@test.dev`],
    );
    workspaceId = (
      await pool.query(`INSERT INTO workspaces (name, slug, plan) VALUES ('B', $1, 'enterprise') RETURNING id`, [
        `ws-${randomUUID().slice(0, 8)}`,
      ])
    ).rows[0].id;
    production = await envSvc.ensureDefaultEnvironment(workspaceId);
    staging = await envSvc.createEnvironment(workspaceId, {
      name: "Staging",
      slug: `staging-${randomUUID().slice(0, 8)}`,
    });

    const budgetScopes = ["budgets:read", "budgets:write"] as const;
    const prod = await keysSvc.createApiKey(
      workspaceId, userId, "prod", undefined, [...budgetScopes], production.id,
    );
    const stage = await keysSvc.createApiKey(
      workspaceId, userId, "staging", undefined, [...budgetScopes], staging.id,
    );
    productionKey = prod.key;
    stagingKey = stage.key;
    productionKeyId = (
      await pool.query("SELECT id FROM api_keys WHERE workspace_id = $1 AND environment_id = $2", [
        workspaceId,
        production.id,
      ])
    ).rows[0].id;
    stagingKeyId = (
      await pool.query("SELECT id FROM api_keys WHERE workspace_id = $1 AND environment_id = $2", [
        workspaceId,
        staging.id,
      ])
    ).rows[0].id;

    for (const apiKeyId of [productionKeyId, stagingKeyId]) {
      await pool.query(
        `INSERT INTO key_budgets (workspace_id, api_key_id, monthly_cost_cents_cap, enabled)
         VALUES ($1, $2, 100, true)`,
        [workspaceId, apiKeyId],
      );
    }
  }, 60_000);

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
    }
    await pool?.end().catch(() => {});
  });

  const authed = (key: string, init: RequestInit = {}) => ({
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

  const capOf = async (apiKeyId: string) =>
    (
      await pool.query("SELECT monthly_cost_cents_cap AS cap FROM key_budgets WHERE api_key_id = $1", [
        apiKeyId,
      ])
    ).rows[0]?.cap ?? null;

  it("lists only the budgets of keys in the calling environment", async () => {
    const res = await app.request("/api/v2/budgets", authed(stagingKey));
    expect(res.status).toBe(200);
    const ids = (await res.json()).data.map((b: { apiKeyId: string }) => b.apiKeyId);
    expect(ids).toEqual([stagingKeyId]);
  });

  it("cannot read another environment's key budget", async () => {
    const res = await app.request(`/api/v2/budgets/${productionKeyId}`, authed(stagingKey));
    expect(res.status).toBe(404);
  });

  it("cannot raise another environment's spend cap", async () => {
    const res = await app.request(
      `/api/v2/budgets/${productionKeyId}`,
      authed(stagingKey, { method: "PUT", body: JSON.stringify({ monthlyCostCentsCap: 1_000_000 }) }),
    );
    expect(res.status).toBe(404);
    expect(await capOf(productionKeyId)).toBe(100);
  });

  it("cannot delete another environment's budget", async () => {
    const res = await app.request(
      `/api/v2/budgets/${productionKeyId}`,
      authed(stagingKey, { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
    expect(await capOf(productionKeyId)).toBe(100);
  });

  it("still administers its own environment's budget", async () => {
    const res = await app.request(
      `/api/v2/budgets/${stagingKeyId}`,
      authed(stagingKey, { method: "PUT", body: JSON.stringify({ monthlyCostCentsCap: 250 }) }),
    );
    expect(res.status).toBe(200);
    expect(await capOf(stagingKeyId)).toBe(250);

    const read = await app.request(`/api/v2/budgets/${productionKeyId}`, authed(productionKey));
    expect(read.status).toBe(200);
  });
});
