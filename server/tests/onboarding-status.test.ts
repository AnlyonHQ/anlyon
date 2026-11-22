import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined }));

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client) };
});
vi.mock("../src/lib/redis.ts", () => ({ redis: {}, RedisKeys: {} }));

const { getOnboardingStatus } = await import("../src/core/analytics/service.ts");

const ws = "00000000-0000-4000-8000-00000000ab01";
const env = "00000000-0000-4000-8000-00000000ab02";
const otherWs = "00000000-0000-4000-8000-00000000ab03";
const otherEnv = "00000000-0000-4000-8000-00000000ab04";
const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => state.client!.query<T>(text, params);

async function workspace(id: string, environmentId: string, slug: string) {
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'ws', $2)", [id, slug]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug) VALUES ($1, $2, 'prod', 'prod')", [environmentId, id]);
}

async function apiKey(workspaceId: string, environmentId: string, suffix: string) {
  await sql(
    "INSERT INTO api_keys (workspace_id, environment_id, name, key_hash, key_prefix) VALUES ($1, $2, 'agent', $3, 'ak_test')",
    [workspaceId, environmentId, `hash-${suffix}`],
  );
}

async function invocation(workspaceId: string, environmentId: string, suffix: string, status: string) {
  const { rows: [action] } = await sql<{ id: string }>(
    "INSERT INTO actions (workspace_id, environment_id, action_id, name, url_template, input_schema) VALUES ($1, $2, $3, 'refund_order', 'https://e.test', '{}') RETURNING id",
    [workspaceId, environmentId, `act_${suffix}`],
  );
  await sql(
    "INSERT INTO action_invocations (workspace_id, environment_id, action_id, invocation_id, status) VALUES ($1, $2, $3, $4, $5)",
    [workspaceId, environmentId, action.id, `inv_${suffix}`, status],
  );
}

beforeAll(async () => {
  await workspace(ws, env, "ws-onboarding");
  await workspace(otherWs, otherEnv, "ws-onboarding-other");
  await apiKey(otherWs, otherEnv, "other");
  await invocation(otherWs, otherEnv, "other", "succeeded");
});

describe("getOnboardingStatus", () => {
  it("offers two steps, both pending, for a fresh workspace", async () => {
    const status = await getOnboardingStatus(ws);
    expect(status).toEqual({
      isOnboarded: false,
      hasApiKey: false,
      hasInvocations: false,
      totalInvocations: 0,
      steps: [
        { id: "api_key", completed: false, label: "Create an API key" },
        { id: "first_invocation", completed: false, label: "Invoke your first action" },
      ],
      completedSteps: 0,
      totalSteps: 2,
      completionPercentage: 0,
    });
  });

  it("completes the key step without calling the workspace onboarded", async () => {
    await apiKey(ws, env, "mine");
    const status = await getOnboardingStatus(ws);
    expect(status.hasApiKey).toBe(true);
    expect(status.isOnboarded).toBe(false);
    expect(status.steps.map((step) => step.completed)).toEqual([true, false]);
    expect(status.completedSteps).toBe(1);
    expect(status.completionPercentage).toBe(50);
  });

  it("is onboarded once an action has been invoked, whatever the outcome", async () => {
    await invocation(ws, env, "denied", "denied");
    const status = await getOnboardingStatus(ws);
    expect(status.isOnboarded).toBe(true);
    expect(status.hasInvocations).toBe(true);
    expect(status.totalInvocations).toBe(1);
    expect(status.completedSteps).toBe(2);
    expect(status.completionPercentage).toBe(100);
  });

  it("does not expose legacy message fields", async () => {
    const status = await getOnboardingStatus(ws);
    expect(status).not.toHaveProperty("hasMessages");
    expect(status).not.toHaveProperty("totalMessages");
    expect(status).not.toHaveProperty("hasDeliverySecret");
  });
});
