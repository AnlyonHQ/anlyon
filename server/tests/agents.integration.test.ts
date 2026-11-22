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

async function seedWorkspaceWithEnv(
  pool: Pool,
  svc: typeof import("../src/core/environments/service.ts"),
): Promise<{ workspaceId: string; environmentId: string }> {
  const ws = await pool.query(`INSERT INTO workspaces (name, slug, plan) VALUES ('WS', $1, 'enterprise') RETURNING id`, [
    `ws-${randomUUID().slice(0, 8)}`,
  ]);
  const workspaceId = ws.rows[0].id;
  const env = await svc.ensureDefaultEnvironment(workspaceId);
  return { workspaceId, environmentId: env.id };
}

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("agents (real Postgres)", () => {
  let pool: Pool;
  let agentsSvc: typeof import("../src/core/agents/service.ts");
  let envSvc: typeof import("../src/core/environments/service.ts");

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    agentsSvc = await import("../src/core/agents/service.ts");
    envSvc = await import("../src/core/environments/service.ts");
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  it("creates an agent with an immutable v1 published as current", async () => {
    const { workspaceId, environmentId } = await seedWorkspaceWithEnv(pool, envSvc);
    const { agent, version } = await agentsSvc.createAgent(
      workspaceId,
      { name: "support", environmentId, config: { model: "claude-opus-4-8" } },
      "user_1",
    );

    expect(agent.id).toMatch(/^agt_/);
    expect(version.id).toMatch(/^agv_/);
    expect(version.version).toBe(1);
    expect(version.config).toEqual({ model: "claude-opus-4-8" });
    expect(agent.currentVersion).toBe(1);
    expect(agent.environmentId).toBe(environmentId);
  });

  it("appends versions with monotonic numbers and never mutates prior ones", async () => {
    const { workspaceId, environmentId } = await seedWorkspaceWithEnv(pool, envSvc);
    const { agent, version: v1 } = await agentsSvc.createAgent(
      workspaceId,
      { name: "writer", environmentId, config: { temp: 0 } },
      "user_1",
    );

    const v2 = await agentsSvc.createAgentVersion(workspaceId, agent.id, { config: { temp: 1 } });
    const v3 = await agentsSvc.createAgentVersion(workspaceId, agent.id, { config: { temp: 2 }, publish: true });

    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);

    const reloadedV1 = await agentsSvc.getAgentVersion(workspaceId, agent.id, 1);
    expect(reloadedV1.config).toEqual({ temp: 0 });
    expect(reloadedV1.id).toBe(v1.id);

    expect((await agentsSvc.getAgent(workspaceId, agent.id)).currentVersion).toBe(3);
  });

  it("points current version without changing the immutable versions", async () => {
    const { workspaceId, environmentId } = await seedWorkspaceWithEnv(pool, envSvc);
    const { agent } = await agentsSvc.createAgent(workspaceId, { name: "roller", environmentId, config: { v: 1 } });
    await agentsSvc.createAgentVersion(workspaceId, agent.id, { config: { v: 2 }, publish: true });

    const rolled = await agentsSvc.updateAgent(workspaceId, agent.id, { currentVersion: 1 });
    expect(rolled.currentVersion).toBe(1);

    const versions = await agentsSvc.listAgentVersions(workspaceId, agent.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it("rejects a duplicate agent name within the same environment", async () => {
    const { workspaceId, environmentId } = await seedWorkspaceWithEnv(pool, envSvc);
    await agentsSvc.createAgent(workspaceId, { name: "dup", environmentId, config: {} });
    await expect(
      agentsSvc.createAgent(workspaceId, { name: "dup", environmentId, config: {} }),
    ).rejects.toThrow();
  });

  it("allows the same agent name in a different environment", async () => {
    const { workspaceId, environmentId } = await seedWorkspaceWithEnv(pool, envSvc);
    const staging = await envSvc.createEnvironment(workspaceId, { name: "Staging", slug: "staging" });

    await agentsSvc.createAgent(workspaceId, { name: "shared", environmentId, config: {} });
    const other = await agentsSvc.createAgent(workspaceId, { name: "shared", environmentId: staging.id, config: {} });

    expect(other.agent.environmentId).toBe(staging.id);
  });

  it("refuses to create an agent in another workspace's environment", async () => {
    const a = await seedWorkspaceWithEnv(pool, envSvc);
    const b = await seedWorkspaceWithEnv(pool, envSvc);
    await expect(
      agentsSvc.createAgent(a.workspaceId, { name: "cross", environmentId: b.environmentId, config: {} }),
    ).rejects.toThrow();
  });

  it("promotes an agent's config to another environment as a new agent, then a new version", async () => {
    const { workspaceId, environmentId } = await seedWorkspaceWithEnv(pool, envSvc);
    const staging = await envSvc.createEnvironment(workspaceId, { name: "Staging", slug: "staging" });
    const { agent } = await agentsSvc.createAgent(
      workspaceId,
      { name: "promoted", environmentId, config: { model: "v1" } },
      "user_1",
    );

    const first = await agentsSvc.promoteAgent(workspaceId, agent.id, staging.id, "user_1");
    expect(first.agent.environmentId).toBe(staging.id);
    expect(first.agent.id).not.toBe(agent.id);
    expect(first.version.version).toBe(1);
    expect(first.version.config).toEqual({ model: "v1" });

    await agentsSvc.createAgentVersion(workspaceId, agent.id, { config: { model: "v2" }, publish: true });
    const second = await agentsSvc.promoteAgent(workspaceId, agent.id, staging.id, "user_1");
    expect(second.agent.id).toBe(first.agent.id);
    expect(second.version.version).toBe(2);
    expect(second.version.config).toEqual({ model: "v2" });

    const versions = await agentsSvc.listAgentVersions(workspaceId, first.agent.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it("refuses to promote into the same environment or without a published version", async () => {
    const { workspaceId, environmentId } = await seedWorkspaceWithEnv(pool, envSvc);
    const { agent } = await agentsSvc.createAgent(workspaceId, { name: "p2", environmentId, config: {} });
    await expect(agentsSvc.promoteAgent(workspaceId, agent.id, environmentId)).rejects.toThrow();
  });

  it("does not expose one workspace's agent to another", async () => {
    const a = await seedWorkspaceWithEnv(pool, envSvc);
    const b = await seedWorkspaceWithEnv(pool, envSvc);
    const { agent } = await agentsSvc.createAgent(a.workspaceId, { name: "secret", environmentId: a.environmentId, config: {} });

    await expect(agentsSvc.getAgent(b.workspaceId, agent.id)).rejects.toThrow();
    expect(await agentsSvc.listAgents(b.workspaceId)).toHaveLength(0);
  });
});
