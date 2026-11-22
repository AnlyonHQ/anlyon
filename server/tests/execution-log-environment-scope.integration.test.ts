import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

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

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("execution-log environment scope (real stack, HTTP)", () => {
  let pool: Pool;
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let keys: typeof import("../src/core/auth/api-keys.ts");
  let envSvc: typeof import("../src/core/environments/service.ts");

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = (await import("../src/api/index.ts")).default as typeof app;
    keys = await import("../src/core/auth/api-keys.ts");
    envSvc = await import("../src/core/environments/service.ts");
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  const authed = (key: string) => ({ headers: { Authorization: `Bearer ${key}` } });

  async function accountWithLogs() {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const userId = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'T', $2, false, now(), now())`,
      [userId, `${userId}@test.dev`],
    );
    const workspace = await pool.query(
      `INSERT INTO workspaces (name, slug, plan) VALUES ('Logs', $1, 'enterprise') RETURNING id`,
      [`logs-${suffix}`],
    );
    const workspaceId = workspace.rows[0].id as string;
    const production = await envSvc.ensureDefaultEnvironment(workspaceId);
    const staging = await envSvc.createEnvironment(workspaceId, {
      name: "Staging",
      slug: `staging-${suffix}`,
    });
    const { key: productionKey } = await keys.createApiKey(
      workspaceId,
      userId,
      "production logs",
      undefined,
      ["logs:read"],
      production.id,
    );
    const { key: stagingKey } = await keys.createApiKey(
      workspaceId,
      userId,
      "staging logs",
      undefined,
      ["logs:read"],
      staging.id,
    );

    const publicId = (prefix: "msg") =>
      `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 21)}`;
    const productionMessageId = publicId("msg");
    const stagingMessageId = publicId("msg");

    await pool.query(
      `INSERT INTO messages (workspace_id, environment_id, message_id, url)
       VALUES ($1, $2, $3, 'https://example.com/production'),
              ($1, $4, $5, 'https://example.com/staging')`,
      [workspaceId, production.id, productionMessageId, staging.id, stagingMessageId],
    );
    await pool.query(
      `INSERT INTO message_execution_logs
         (message_id, workspace_id, attempt_number, status, request_url, response_status,
          error_code, duration, timestamp)
       VALUES ($1, $3, 1, 'SUCCESS', 'https://example.com/production', 200, NULL, 10, now()),
              ($2, $3, 1, 'ERROR', 'https://example.com/staging', 503, 'STAGING_ONLY', 90, now()),
              ($4, $3, 1, 'ERROR', 'https://example.com/orphan', 500, 'ORPHAN', 999, now())`,
      [productionMessageId, stagingMessageId, workspaceId, `msg_orphan_${suffix}`],
    );
    return {
      workspaceId,
      productionKey,
      stagingKey,
      productionIds: [productionMessageId],
      stagingIds: [stagingMessageId],
    };
  }

  it("scopes list results and their summary stats through message parents", async () => {
    const acc = await accountWithLogs();

    const productionResponse = await app.request("/api/v2/logs?type=all&limit=100", authed(acc.productionKey));
    expect(productionResponse.status).toBe(200);
    const production = await productionResponse.json();
    expect(production.data.map((log: { entityId: string }) => log.entityId).sort()).toEqual(
      [...acc.productionIds].sort(),
    );
    expect(production.pagination.total).toBe(1);
    expect(production.stats).toMatchObject({ totalSuccess: 1, totalError: 0, avgDuration: 10 });

    const stagingResponse = await app.request("/api/v2/logs?type=all&limit=100", authed(acc.stagingKey));
    expect(stagingResponse.status).toBe(200);
    const staging = await stagingResponse.json();
    expect(staging.data.map((log: { entityId: string }) => log.entityId).sort()).toEqual(
      [...acc.stagingIds].sort(),
    );
    expect(staging.pagination.total).toBe(1);
    expect(staging.stats).toMatchObject({ totalSuccess: 0, totalError: 1, avgDuration: 90 });
  });

  it("scopes detailed statistics and JSON export", async () => {
    const acc = await accountWithLogs();

    const statsResponse = await app.request("/api/v2/logs/stats?type=all", authed(acc.productionKey));
    expect(statsResponse.status).toBe(200);
    expect((await statsResponse.json()).data).toMatchObject({
      byStatus: { SUCCESS: 1 },
      byHttpStatus: { "200": 1 },
      byErrorCode: {},
      avgDuration: 10,
    });

    const exportResponse = await app.request(
      "/api/v2/logs/export?type=all&format=json",
      authed(acc.productionKey),
    );
    expect(exportResponse.status).toBe(200);
    const exportedIds = (await exportResponse.json()).logs.map((log: { entityId: string }) => log.entityId);
    expect(exportedIds.sort()).toEqual([...acc.productionIds].sort());
  });

  it("keeps logs inaccessible across workspaces", async () => {
    const owner = await accountWithLogs();
    const outsider = await accountWithLogs();

    const response = await app.request("/api/v2/logs?type=all&limit=100", authed(outsider.productionKey));
    expect(response.status).toBe(200);
    const entityIds = (await response.json()).data.map((log: { entityId: string }) => log.entityId);
    for (const ownerId of owner.productionIds) expect(entityIds).not.toContain(ownerId);
  });
});
