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

async function seedWorkspace(pool: Pool): Promise<{ workspaceId: string; userId: string }> {
  const userId = `user_${randomUUID()}`;
  await pool.query(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES ($1, 'T', $2, false, now(), now())`, [userId, `${userId}@test.dev`]);
  const ws = await pool.query(
    `INSERT INTO workspaces (name, slug, plan) VALUES ('WS', $1, 'enterprise') RETURNING id`,
    [`ws-${randomUUID().slice(0, 8)}`],
  );
  return { workspaceId: ws.rows[0].id, userId };
}

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("environments (real Postgres)", () => {
  let pool: Pool;
  let svc: typeof import("../src/core/environments/service.ts");
  let keys: typeof import("../src/core/auth/api-keys.ts");

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    svc = await import("../src/core/environments/service.ts");
    keys = await import("../src/core/auth/api-keys.ts");
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  it("creates exactly one default production environment, idempotently", async () => {
    const { workspaceId } = await seedWorkspace(pool);

    const first = await svc.ensureDefaultEnvironment(workspaceId);
    const second = await svc.ensureDefaultEnvironment(workspaceId);

    expect(first.id).toBe(second.id);
    expect(first.slug).toBe("production");
    expect(first.isDefault).toBe(true);
    expect(first.isProtected).toBe(true);

    const all = await svc.listEnvironments(workspaceId);
    expect(all.filter((e) => e.isDefault)).toHaveLength(1);
  });

  it("assigns a key with no environmentId to the workspace default", async () => {
    const { workspaceId, userId } = await seedWorkspace(pool);
    const def = await svc.ensureDefaultEnvironment(workspaceId);

    const { key } = await keys.createApiKey(workspaceId, userId, "default-key");
    const resolved = await keys.verifyApiKeyAndGetWorkspace(key);

    expect(resolved.workspaceId).toBe(workspaceId);
    expect(resolved.environmentId).toBe(def.id);
  });

  it("binds a key to the environment it was created in, and resolves it on auth", async () => {
    const { workspaceId, userId } = await seedWorkspace(pool);
    await svc.ensureDefaultEnvironment(workspaceId);
    const staging = await svc.createEnvironment(workspaceId, { name: "Staging", slug: "staging" });

    const { key } = await keys.createApiKey(workspaceId, userId, "staging-key", undefined, undefined, staging.id);
    const resolved = await keys.verifyApiKeyAndGetWorkspace(key);

    expect(resolved.environmentId).toBe(staging.id);
    expect(resolved.environmentId).not.toBe((await svc.getDefaultEnvironment(workspaceId)).id);
  });

  it("keeps two keys in the same workspace on their own environments", async () => {
    const { workspaceId, userId } = await seedWorkspace(pool);
    const prod = await svc.ensureDefaultEnvironment(workspaceId);
    const dev = await svc.createEnvironment(workspaceId, { name: "Dev", slug: "development" });

    const prodKey = await keys.createApiKey(workspaceId, userId, "prod", undefined, undefined, prod.id);
    const devKey = await keys.createApiKey(workspaceId, userId, "dev", undefined, undefined, dev.id);

    expect((await keys.verifyApiKeyAndGetWorkspace(prodKey.key)).environmentId).toBe(prod.id);
    expect((await keys.verifyApiKeyAndGetWorkspace(devKey.key)).environmentId).toBe(dev.id);
  });

  it("refuses to bind a key to an environment from another workspace", async () => {
    const a = await seedWorkspace(pool);
    const b = await seedWorkspace(pool);
    await svc.ensureDefaultEnvironment(a.workspaceId);
    const bEnv = await svc.ensureDefaultEnvironment(b.workspaceId);

    await expect(
      keys.createApiKey(a.workspaceId, a.userId, "cross", undefined, undefined, bEnv.id),
    ).rejects.toThrow();
  });

  it("does not expose one workspace's environment to another", async () => {
    const a = await seedWorkspace(pool);
    const b = await seedWorkspace(pool);
    const bEnv = await svc.ensureDefaultEnvironment(b.workspaceId);

    await expect(svc.getEnvironment(a.workspaceId, bEnv.id)).rejects.toThrow();
  });

  it("rejects a duplicate slug within a workspace", async () => {
    const { workspaceId } = await seedWorkspace(pool);
    await svc.ensureDefaultEnvironment(workspaceId);
    await svc.createEnvironment(workspaceId, { name: "Preview", slug: "preview" });

    await expect(svc.createEnvironment(workspaceId, { name: "Preview 2", slug: "preview" })).rejects.toThrow();
  });

  it("isolates event topic names by environment", async () => {
    const { workspaceId } = await seedWorkspace(pool);
    const production = await svc.ensureDefaultEnvironment(workspaceId);
    const staging = await svc.createEnvironment(workspaceId, { name: "Staging", slug: "staging-events" });
    const events = await import("../src/core/events/service.ts");

    const prodTopic = await events.createTopic(workspaceId, { name: "orders" }, production.id);
    const stagingTopic = await events.createTopic(workspaceId, { name: "orders" }, staging.id);

    expect(prodTopic.id).not.toBe(stagingTopic.id);
    await expect(events.getTopic(workspaceId, prodTopic.id, staging.id)).rejects.toThrow();
    expect((await events.listTopics(workspaceId, production.id)).map((topic) => topic.id)).toEqual([prodTopic.id]);
  });

  it("isolates actions, secrets, invocations, and approvals by environment", async () => {
    const { workspaceId } = await seedWorkspace(pool);
    const production = await svc.ensureDefaultEnvironment(workspaceId);
    const staging = await svc.createEnvironment(workspaceId, { name: "Staging", slug: "staging-actions" });
    const actions = await import("../src/core/actions/service.ts");
    const secrets = await import("../src/core/actions/secrets.ts");
    const approvals = await import("../src/core/approvals/service.ts");

    await secrets.putSecret(workspaceId, "API_TOKEN", { value: "prod-token" }, production.id);
    await secrets.putSecret(workspaceId, "API_TOKEN", { value: "staging-token" }, staging.id);
    const prodAction = await actions.createAction(workspaceId, {
      name: "notify", urlTemplate: "https://example.test/prod", requiresApproval: true,
    }, actions.UNSCOPED_AUTHORITY, production.id);
    const stagingAction = await actions.createAction(workspaceId, {
      name: "notify", urlTemplate: "https://example.test/staging", requiresApproval: true,
    }, actions.UNSCOPED_AUTHORITY, staging.id);

    expect(prodAction.id).not.toBe(stagingAction.id);
    await expect(actions.getAction(workspaceId, prodAction.id, staging.id)).rejects.toThrow();
    await expect(secrets.getSecretMetadata(workspaceId, "API_TOKEN", staging.id)).resolves.toMatchObject({ name: "API_TOKEN" });

    const pending = await actions.invokeAction(workspaceId, prodAction.id, {}, { environmentId: production.id });
    expect(pending.pendingApproval).toBe(true);
    await expect(actions.getInvocation(workspaceId, pending.id, staging.id)).rejects.toThrow();
    await expect(approvals.getApproval(workspaceId, pending.approvalId!, staging.id)).rejects.toThrow();
    expect((await actions.listInvocations(workspaceId, { environmentId: production.id })).invocations.map((invocation) => invocation.id)).toEqual([pending.id]);
  });
});
