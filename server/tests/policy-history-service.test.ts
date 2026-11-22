import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  client: undefined as PGlite | undefined,
  beforeWrite: undefined as (() => Promise<unknown>) | undefined,
}));

vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  const real = drizzle(state.client);
  const db = new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "transaction") {
        return async (...args: Parameters<typeof real.transaction>) => {
          const hook = state.beforeWrite;
          state.beforeWrite = undefined;
          await hook?.();
          return target.transaction(...args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db };
});
vi.mock("../src/core/environments/service.ts", async () => {
  const { NotFoundError } = await import("../src/utils/errors.ts");
  return {
    getEnvironment: async (workspaceId: string, environmentId: string) => {
      const { rows } = await state.client!.query("SELECT id FROM environments WHERE workspace_id = $1 AND id = $2", [workspaceId, environmentId]);
      if (!rows[0]) throw new NotFoundError("Environment");
      return rows[0];
    },
  };
});

const { createPolicy, deletePolicy, getPolicy, getPolicyVersion, listPolicyVersions, updatePolicy } = await import("../src/core/approvals/policy.ts");

const ws = "00000000-0000-4000-8000-0000000000a1";
const otherWs = "00000000-0000-4000-8000-0000000000a2";
const env = "00000000-0000-4000-8000-0000000000b1";
const otherEnv = "00000000-0000-4000-8000-0000000000b2";
const apiKey = { type: "api_key" as const, id: "key_operator" };
const user = { type: "user" as const, id: "user_operator" };
let names = 0;

const sql = (text: string, params: unknown[] = []) => state.client!.query<Record<string, unknown>>(text, params);
const create = (changeNote?: string) => createPolicy(ws, {
  environmentId: env, name: `refunds ${++names}`, matchKind: "action", matchActionName: "refund_order", minAmount: 50, changeNote,
}, { actor: apiKey });
const history = async (policyId: string) => (await sql(
  "SELECT version, operation, actor_type, actor_id, change_note, snapshot->>'min_amount' AS min_amount FROM approval_policy_versions WHERE policy_id = $1 ORDER BY version",
  [policyId],
)).rows;

beforeAll(async () => {
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'ws', 'ws-history'), ($2, 'other', 'ws-other')", [ws, otherWs]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug) VALUES ($1, $3, 'prod', 'prod'), ($2, $3, 'dev', 'dev')", [env, otherEnv, ws]);
  await sql("INSERT INTO actions (workspace_id, environment_id, action_id, name, url_template) VALUES ($1, $2, 'act_refund', 'refund_order', 'https://example.test/refund')", [ws, env]);
}, 120_000);

describe("policy service history", () => {
  it("records the authenticated actor and change note with each create, update and delete", async () => {
    const policy = await create("Finance threshold");
    const updated = await updatePolicy(ws, policy.id, { minAmount: 300, changeNote: "Raise after review" }, { environmentId: env, actor: user });
    expect([policy.version, updated.version]).toEqual([1, 2]);
    await deletePolicy(ws, policy.id, { environmentId: env, actor: user });

    await expect(getPolicy(ws, policy.id, { environmentId: env })).rejects.toMatchObject({ statusCode: 404 });
    const { versions } = await listPolicyVersions(ws, policy.id, { environmentId: env });
    expect(versions.map((v) => [v.version, v.operation, v.actor, v.changeNote])).toEqual([
      [3, "deleted", user, "Policy deleted"],
      [2, "updated", user, "Raise after review"],
      [1, "created", apiKey, "Finance threshold"],
    ]);
    expect(versions.map((v) => (v.snapshot as { min_amount: number }).min_amount)).toEqual([300, 300, 50]);
    const { rows } = await sql(
      "SELECT bool_and(content_hash = encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex')) AS valid FROM approval_policy_versions WHERE policy_id = $1",
      [policy.id],
    );
    expect(rows[0].valid).toBe(true);
  });

  it("refuses a stale edit instead of overwriting a concurrent change", async () => {
    const policy = await create();
    state.beforeWrite = () => sql("UPDATE approval_policies SET min_amount = 999 WHERE policy_id = $1", [policy.id]);
    await expect(updatePolicy(ws, policy.id, { minAmount: 0, changeNote: "stale" }, { environmentId: env, actor: user }))
      .rejects.toMatchObject({ statusCode: 409 });

    expect((await getPolicy(ws, policy.id)).match.minAmount).toBe(999);
    expect(await history(policy.id)).toEqual([
      { version: 1, operation: "created", actor_type: "api_key", actor_id: "key_operator", change_note: null, min_amount: "50" },
      { version: 2, operation: "updated", actor_type: "unknown", actor_id: null, change_note: null, min_amount: "999" },
    ]);
  });

  it("refuses a stale delete and keeps the live policy", async () => {
    const policy = await create();
    state.beforeWrite = () => sql("UPDATE approval_policies SET enabled = false WHERE policy_id = $1", [policy.id]);
    await expect(deletePolicy(ws, policy.id, { environmentId: env, actor: user })).rejects.toMatchObject({ statusCode: 409 });

    expect((await getPolicy(ws, policy.id)).enabled).toBe(false);
    expect((await history(policy.id)).map((row) => row.operation)).toEqual(["created", "updated"]);
  });

  it("rolls back history when the write itself fails", async () => {
    const name = `refunds ${++names}`;
    state.beforeWrite = () => sql(
      "INSERT INTO approval_policies (workspace_id, environment_id, policy_id, name) VALUES ($1, $2, 'apol_racing', $3)",
      [ws, env, name],
    );
    await expect(createPolicy(ws, { environmentId: env, name, matchKind: "action", matchActionName: "refund_order", changeNote: "lost" }, { actor: user }))
      .rejects.toMatchObject({ statusCode: 409 });

    const { rows } = await sql("SELECT policy_id, change_note FROM approval_policy_versions WHERE snapshot->>'name' = $1", [name]);
    expect(rows).toEqual([{ policy_id: "apol_racing", change_note: null }]);
  });

  it("scopes retained history to the credential's workspace and environment", async () => {
    const policy = await create();
    await deletePolicy(ws, policy.id, { environmentId: env, actor: user });

    await expect(listPolicyVersions(ws, policy.id, { environmentId: otherEnv })).rejects.toMatchObject({ statusCode: 404 });
    await expect(listPolicyVersions(otherWs, policy.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(listPolicyVersions(ws, "apol_unknown", { environmentId: env })).rejects.toMatchObject({ statusCode: 404 });
    expect((await listPolicyVersions(ws, policy.id)).versions).toHaveLength(2);
    await expect(getPolicyVersion(ws, policy.id, 1, { environmentId: otherEnv })).rejects.toMatchObject({ statusCode: 404 });
    await expect(getPolicyVersion(otherWs, policy.id, 1)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("pages history newest first with a stable version cursor, and reads one exact version", async () => {
    const policy = await create();
    for (let amount = 51; amount <= 56; amount++) {
      await updatePolicy(ws, policy.id, { minAmount: amount }, { environmentId: env, actor: user });
    }
    const first = await listPolicyVersions(ws, policy.id, { environmentId: env }, { limit: 3 });
    expect(first.versions.map((v) => v.version)).toEqual([7, 6, 5]);
    expect(first).toMatchObject({ nextBefore: 5, earliestVersion: 1, latestVersion: 7 });

    await updatePolicy(ws, policy.id, { minAmount: 57 }, { environmentId: env, actor: user });
    const second = await listPolicyVersions(ws, policy.id, { environmentId: env }, { limit: 3, before: first.nextBefore! });
    expect(second.versions.map((v) => v.version)).toEqual([4, 3, 2]);
    const last = await listPolicyVersions(ws, policy.id, { environmentId: env }, { limit: 3, before: second.nextBefore! });
    expect(last.versions.map((v) => v.version)).toEqual([1]);
    expect(last).toMatchObject({ nextBefore: null, latestVersion: 8 });
    expect((await listPolicyVersions(ws, policy.id, {}, { before: 1 })).versions).toEqual([]);
    expect((await listPolicyVersions(ws, policy.id, {}, { limit: 1000 })).versions).toHaveLength(8);

    expect(await getPolicyVersion(ws, policy.id, 4, { environmentId: env })).toMatchObject({
      version: 4, operation: "updated", snapshot: { min_amount: 53 },
    });
    await expect(getPolicyVersion(ws, policy.id, 99, { environmentId: env })).rejects.toMatchObject({ statusCode: 404 });
  });
});
