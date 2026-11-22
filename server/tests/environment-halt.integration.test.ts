import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

vi.mock("../src/lib/safe-http.ts", () => {
  class SsrfBlockedError extends Error {}
  return {
    SsrfBlockedError,
    safeFetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  };
});

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

async function seedWorkspace(pool: Pool): Promise<{ workspaceId: string }> {
  const ws = await pool.query(
    `INSERT INTO workspaces (name, slug, plan) VALUES ('WS', $1, 'enterprise') RETURNING id`,
    [`ws-${randomUUID().slice(0, 8)}`],
  );
  return { workspaceId: ws.rows[0].id };
}

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("environment halt + protection (real Postgres + Redis)", () => {
  let pool: Pool;
  let envSvc: typeof import("../src/core/environments/service.ts");
  let halt: typeof import("../src/core/environments/halt.ts");
  let agentsSvc: typeof import("../src/core/agents/service.ts");
  let consumer: typeof import("../src/core/messaging/consumer.ts");
  let execute: typeof import("../src/core/actions/execute.ts");
  let redisLib: typeof import("../src/lib/redis.ts");
  let safeHttp: { safeFetch: ReturnType<typeof vi.fn> };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    envSvc = await import("../src/core/environments/service.ts");
    halt = await import("../src/core/environments/halt.ts");
    agentsSvc = await import("../src/core/agents/service.ts");
    consumer = await import("../src/core/messaging/consumer.ts");
    execute = await import("../src/core/actions/execute.ts");
    redisLib = await import("../src/lib/redis.ts");
    safeHttp = (await import("../src/lib/safe-http.ts")) as unknown as {
      safeFetch: ReturnType<typeof vi.fn>;
    };
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  beforeEach(() => {
    safeHttp.safeFetch.mockClear();
  });

  it("halts and resumes an environment, with DB and Redis in agreement", async () => {
    const { workspaceId } = await seedWorkspace(pool);
    const env = await envSvc.createEnvironment(workspaceId, { name: "Prod", slug: "prod" });

    const halted = await halt.haltEnvironment(workspaceId, env.id, {
      reason: "incident-42",
      actor: "user_ops",
    });
    expect(halted.haltedAt).not.toBeNull();
    expect(halted.haltedReason).toBe("incident-42");
    expect(await halt.isEnvironmentHalted(env.id)).toBe(true);

    await expect(halt.haltEnvironment(workspaceId, env.id)).rejects.toThrow(/already halted/);

    const resumed = await halt.resumeEnvironment(workspaceId, env.id);
    expect(resumed.haltedAt).toBeNull();
    expect(await halt.isEnvironmentHalted(env.id)).toBe(false);
    await expect(halt.resumeEnvironment(workspaceId, env.id)).rejects.toThrow(/not halted/);
  });

  it("stays halted when its Redis key is flushed or evicted", async () => {
    const { workspaceId } = await seedWorkspace(pool);
    const env = await envSvc.createEnvironment(workspaceId, { name: "Prod", slug: "prod" });
    await halt.haltEnvironment(workspaceId, env.id);
    const key = redisLib.RedisKeys.environmentHalt(env.id);

    await redisLib.redis.del(key);
    expect(await halt.isEnvironmentHalted(env.id)).toBe(true);
    await vi.waitFor(async () => expect(await redisLib.redis.get(key)).toMatch(/^1:\d+$/));

    expect(await halt.syncHaltedEnvironments()).toBeGreaterThanOrEqual(1);
    expect(await halt.isEnvironmentHalted(env.id)).toBe(true);
  });

  it("a resync that read the table before a resume cannot put the halt back", async () => {
    const { workspaceId } = await seedWorkspace(pool);
    const env = await envSvc.createEnvironment(workspaceId, { name: "Prod", slug: "prod" });
    const halted = await halt.haltEnvironment(workspaceId, env.id);

    const resumed = await halt.resumeEnvironment(workspaceId, env.id);
    expect(resumed.updatedAt.getTime()).toBeGreaterThan(halted.updatedAt.getTime());

    await halt.publishHaltState(env.id, true, halted.updatedAt);
    expect(await halt.isEnvironmentHalted(env.id)).toBe(false);

    const haltedAgain = await halt.haltEnvironment(workspaceId, env.id);
    await halt.publishHaltState(env.id, false, resumed.updatedAt);
    expect(haltedAgain.updatedAt.getTime()).toBeGreaterThan(resumed.updatedAt.getTime());
    expect(await halt.isEnvironmentHalted(env.id)).toBe(true);
  });

  it("defers message delivery while halted and delivers after resume", async () => {
    const { workspaceId } = await seedWorkspace(pool);
    const env = await envSvc.createEnvironment(workspaceId, { name: "Prod", slug: "prod" });
    const messageId = `msg_${randomUUID().slice(0, 12)}`;

    const messageData = {
      messageId,
      workspaceId,
      environmentId: env.id,
      url: "https://example.com/hook",
      method: "POST",
      headers: "{}",
      body: JSON.stringify({ hello: "world" }),
      maxRetries: "3",
      attempts: "0",
    };

    await halt.haltEnvironment(workspaceId, env.id);
    await consumer.deliverMessage(messageData);

    expect(safeHttp.safeFetch).not.toHaveBeenCalled();
    const score = await redisLib.redis.zscore(
      redisLib.RedisKeys.processingSet(workspaceId),
      messageId,
    );
    expect(score).not.toBeNull();

    await halt.resumeEnvironment(workspaceId, env.id);
    await consumer.deliverMessage(messageData);
    expect(safeHttp.safeFetch).toHaveBeenCalledTimes(1);
  });

  it("blocks action invocations while halted, recorded on the row for audit", async () => {
    const { workspaceId } = await seedWorkspace(pool);
    const env = await envSvc.createEnvironment(workspaceId, { name: "Prod", slug: "prod" });

    const actionRow = await pool.query(
      `INSERT INTO actions (workspace_id, environment_id, action_id, name, method, url_template)
       VALUES ($1, $2, $3, 'notify', 'POST', 'https://example.com/notify') RETURNING *`,
      [workspaceId, env.id, `act_${randomUUID().slice(0, 12)}`],
    );
    const invocationRow = await pool.query(
      `INSERT INTO action_invocations (workspace_id, environment_id, action_id, invocation_id, status, input)
       VALUES ($1, $2, $3, $4, 'pending_approval', '{}') RETURNING *`,
      [workspaceId, env.id, actionRow.rows[0].id, `inv_${randomUUID().slice(0, 12)}`],
    );

    const { db } = await import("../src/db/index.ts");
    const { actions, actionInvocations } = await import("../src/db/schema/actions.ts");
    const { eq } = await import("drizzle-orm");
    const [action] = await db.select().from(actions).where(eq(actions.id, actionRow.rows[0].id));
    const [invocation] = await db
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationRow.rows[0].id));

    await halt.haltEnvironment(workspaceId, env.id);
    const blocked = await execute.executeInvocation(action, invocation);

    expect(safeHttp.safeFetch).not.toHaveBeenCalled();
    expect(blocked.status).toBe("failed");
    expect(blocked.error).toMatch(/halted/);

    await halt.resumeEnvironment(workspaceId, env.id);
    const invocation2Row = await pool.query(
      `INSERT INTO action_invocations (workspace_id, environment_id, action_id, invocation_id, status, input)
       VALUES ($1, $2, $3, $4, 'pending_approval', '{}') RETURNING *`,
      [workspaceId, env.id, actionRow.rows[0].id, `inv_${randomUUID().slice(0, 12)}`],
    );
    const [invocation2] = await db
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocation2Row.rows[0].id));
    const executed = await execute.executeInvocation(action, invocation2);
    expect(safeHttp.safeFetch).toHaveBeenCalledTimes(1);
    expect(executed.status).toBe("succeeded");
  });

  it("rejects promotion into a protected environment without explicit confirmation", async () => {
    const { workspaceId } = await seedWorkspace(pool);
    const source = await envSvc.createEnvironment(workspaceId, { name: "Staging", slug: "staging" });
    const prod = await envSvc.createEnvironment(workspaceId, {
      name: "Prod",
      slug: "prod",
      isProtected: true,
    });
    const { agent } = await agentsSvc.createAgent(
      workspaceId,
      { name: "guarded", environmentId: source.id, config: { model: "v1" } },
      "user_1",
    );

    await expect(agentsSvc.promoteAgent(workspaceId, agent.id, prod.id, "user_1")).rejects.toThrow(
      /protected/,
    );

    const promoted = await agentsSvc.promoteAgent(workspaceId, agent.id, prod.id, "user_1", {
      confirmProtected: true,
    });
    expect(promoted.agent.environmentId).toBe(prod.id);
  });

  it("updates environment name and protection; slug and default stay fixed", async () => {
    const { workspaceId } = await seedWorkspace(pool);
    const env = await envSvc.createEnvironment(workspaceId, { name: "Stage", slug: "stage" });

    const updated = await envSvc.updateEnvironment(workspaceId, env.id, {
      name: "Staging",
      isProtected: true,
    });
    expect(updated.name).toBe("Staging");
    expect(updated.isProtected).toBe(true);
    expect(updated.slug).toBe("stage");
    expect(updated.isDefault).toBe(false);
  });
});
