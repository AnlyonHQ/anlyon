import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL = process.env.DATABASE_URL ?? "";

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("a stored secret names its hosts (real stack, HTTP)", () => {
  let pool: Pool;
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let userId: string;
  let workspaceId: string;
  let environmentId: string;
  let key: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = (await import("../src/api/index.ts")).default as typeof app;
    const keys = await import("../src/core/auth/api-keys.ts");
    const envSvc = await import("../src/core/environments/service.ts");

    userId = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'T', $2, true, now(), now())`,
      [userId, `${userId}@test.dev`],
    );
    workspaceId = (
      await pool.query(`INSERT INTO workspaces (name, slug, plan) VALUES ('S', $1, 'enterprise') RETURNING id`, [
        `ws-${randomUUID().slice(0, 8)}`,
      ])
    ).rows[0].id;
    environmentId = (await envSvc.ensureDefaultEnvironment(workspaceId)).id;
    key = (await keys.createApiKey(workspaceId, userId, "secrets", undefined, ["secrets:read", "secrets:write"], environmentId)).key;
  }, 60_000);

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
    }
    await pool?.end().catch(() => {});
  });

  const put = async (name: string, body: unknown) => {
    const res = await app.request(`/api/v2/secrets/${name}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  const stored = async (name: string) =>
    (await pool.query("SELECT allowed_hosts FROM workspace_secrets WHERE workspace_id = $1 AND name = $2", [workspaceId, name])).rows;

  it("refuses a secret with no allowedHosts, null, or an empty list with 400, and stores nothing", async () => {
    for (const hosts of [{}, { allowedHosts: null }, { allowedHosts: [] }]) {
      const res = await put("STRIPE_KEY", { value: "value-1234", ...hosts });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(JSON.stringify(res.body.error)).toContain("allowedHosts");
    }
    expect(await stored("STRIPE_KEY")).toHaveLength(0);
  });

  it("stores a secret that names its hosts, and rotates it without naming them again", async () => {
    const created = await put("MAILER_KEY", { value: "value-1234", allowedHosts: ["api.mailer.example"] });
    expect(created.status).toBe(200);
    expect(created.body.data.allowedHosts).toEqual(["api.mailer.example"]);
    expect(JSON.stringify(created.body)).not.toContain("value-1234");

    const rotated = await put("MAILER_KEY", { value: "value-5678" });
    expect(rotated.status).toBe(200);
    expect(rotated.body.data.allowedHosts).toEqual(["api.mailer.example"]);

    expect((await put("MAILER_KEY", { value: "value-9999", allowedHosts: [] })).status).toBe(400);
    expect((await stored("MAILER_KEY"))[0].allowed_hosts).toEqual(["api.mailer.example"]);
  });
});
