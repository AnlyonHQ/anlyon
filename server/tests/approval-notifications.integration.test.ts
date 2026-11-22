import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

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

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("approval alerts (real Postgres + Redis)", () => {
  let pool: Pool;
  let envSvc: typeof import("../src/core/environments/service.ts");
  let approvalsSvc: typeof import("../src/core/approvals/service.ts");

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    envSvc = await import("../src/core/environments/service.ts");
    approvalsSvc = await import("../src/core/approvals/service.ts");
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  async function seedBareWorkspace() {
    const ws = await pool.query(`INSERT INTO workspaces (name, slug) VALUES ('WS', $1) RETURNING id`, [
      `ws-${randomUUID().slice(0, 8)}`,
    ]);
    const workspaceId = ws.rows[0].id as string;
    const env = await envSvc.ensureDefaultEnvironment(workspaceId);
    return { workspaceId, environmentId: env.id };
  }

  it("a zero-setup workspace still gets an in-app alert when an approval is requested", async () => {
    const { workspaceId, environmentId } = await seedBareWorkspace();

    const before = await pool.query(
      `SELECT 1 FROM notification_preferences WHERE workspace_id = $1`,
      [workspaceId],
    );
    expect(before.rowCount).toBe(0);

    const approval = await approvalsSvc.createApproval(
      workspaceId,
      { title: "Refund a customer?" },
      { requestedByKeyId: randomUUID(), environmentId },
    );

    const notifications = await pool.query(
      `SELECT type, title, action_url FROM notifications WHERE workspace_id = $1 AND type = 'approval_requested'`,
      [workspaceId],
    );
    expect(notifications.rowCount).toBe(1);
    expect(notifications.rows[0].title).toContain("Refund a customer?");
    expect(notifications.rows[0].action_url).toMatch(/^https?:\/\/.+\/approvals\?id=/);
    expect(notifications.rows[0].action_url).toContain(approval.id);

    const prefs = await pool.query(
      `SELECT enabled_types, in_app_enabled FROM notification_preferences WHERE workspace_id = $1`,
      [workspaceId],
    );
    expect(prefs.rowCount).toBe(1);
    expect(prefs.rows[0].in_app_enabled).toBe(true);
    expect(prefs.rows[0].enabled_types).toContain("approval_requested");
    expect(prefs.rows[0].enabled_types).toContain("budget_alert");
  });

  it("createWorkspace seeds preferences with its creator as email recipient", async () => {
    const workspaceSvc = await import("../src/core/workspace/service.ts");
    const userId = `user_${randomUUID()}`;
    const email = `${userId}@test.dev`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'Owner', $2, false, now(), now())`,
      [userId, email],
    );

    const workspace = await workspaceSvc.createWorkspace(userId, {
      name: `Alerts ${randomUUID().slice(0, 6)}`,
    });

    const prefs = await pool.query(
      `SELECT email_recipients, enabled_types FROM notification_preferences WHERE workspace_id = $1`,
      [workspace.id],
    );
    expect(prefs.rowCount).toBe(1);
    expect(prefs.rows[0].email_recipients).toContain(email);
    expect(prefs.rows[0].enabled_types).toContain("approval_requested");
  });
});
