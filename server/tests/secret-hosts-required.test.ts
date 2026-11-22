import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as PGlite | undefined }));
vi.mock("../src/db/index.ts", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migratedDatabase } = await import("./support/pglite-schema.ts");
  state.client = await migratedDatabase();
  return { db: drizzle(state.client), pool: { end: async () => {} } };
});
vi.mock("../src/lib/redis.ts", () => {
  const nothing = new Proxy({}, { get: () => async () => null });
  return {
    redis: nothing, redisBlocking: nothing,
    RedisKeys: new Proxy({}, { get: (_t, name) => (...parts: unknown[]) => [String(name), ...parts].join(":") }),
    createBlockingConnection: () => nothing, incrementWithTtl: async () => 1, USAGE_COUNTER_TTL_SECONDS: 1, WAITING_EVENT_TTL_SECONDS: 1,
  };
});

const sql = (text: string, params: unknown[] = []) => state.client!.query<Record<string, unknown>>(text, params);
const { assertSecretWillBeBound, putSecret } = await import("../src/core/actions/secrets.ts");

const ws = "00000000-0000-4000-8000-00000000f0a1";
const env = "00000000-0000-4000-8000-00000000f0b1";

beforeAll(async () => {
  await import("../src/db/index.ts");
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'ws', 'ws-secret-hosts')", [ws]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug, is_default) VALUES ($1, $2, 'prod', 'prod', true)", [env, ws]);
}, 120_000);

describe("a stored secret names its hosts", () => {
  it("is refused when created with none, with null, or with an empty list, and says what to send", async () => {
    for (const input of [{}, { allowedHosts: null }, { allowedHosts: [] }]) {
      const refused = await assertSecretWillBeBound(ws, "NEW_KEY", input, env).catch((error: unknown) => error);
      expect(refused).toMatchObject({ statusCode: 400 });
      expect((refused as Error).message).toContain("Nothing was stored");
      expect((refused as { fix?: { summary: string } }).fix?.summary).toContain("allowedHosts");
    }
  });

  it("is accepted with hosts, and a later rotation needs none", async () => {
    await expect(assertSecretWillBeBound(ws, "STRIPE_KEY", { allowedHosts: ["api.stripe.com"] }, env)).resolves.toBeUndefined();
    await putSecret(ws, "STRIPE_KEY", { value: "sk_test_one", allowedHosts: ["api.stripe.com"] }, env);
    await expect(assertSecretWillBeBound(ws, "STRIPE_KEY", {}, env)).resolves.toBeUndefined();
    const rotated = await putSecret(ws, "STRIPE_KEY", { value: "sk_test_two" }, env);
    expect(rotated.allowedHosts).toEqual(["api.stripe.com"]);
  });

  it("cannot have its hosts cleared", async () => {
    await putSecret(ws, "MAILER_KEY", { value: "mlr_one", allowedHosts: ["api.mailer.example"] }, env);
    for (const allowedHosts of [null, []]) {
      await expect(assertSecretWillBeBound(ws, "MAILER_KEY", { allowedHosts }, env)).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it("stored before the rule with no hosts: a rotation must name them, and naming them is enough", async () => {
    await putSecret(ws, "OLD_KEY", { value: "old_one" }, env);
    const refused = await assertSecretWillBeBound(ws, "OLD_KEY", {}, env).catch((error: unknown) => error);
    expect(refused).toMatchObject({ statusCode: 400 });
    expect((refused as Error).message).toContain("Nothing was changed");
    await expect(assertSecretWillBeBound(ws, "OLD_KEY", { allowedHosts: ["api.old.example"] }, env)).resolves.toBeUndefined();
  });

  it("is asked per environment: another environment's bound secret of the same name does not count", async () => {
    const other = "00000000-0000-4000-8000-00000000f0b2";
    await sql("INSERT INTO environments (id, workspace_id, name, slug) VALUES ($1, $2, 'staging', 'staging')", [other, ws]);
    await expect(assertSecretWillBeBound(ws, "STRIPE_KEY", {}, other)).rejects.toMatchObject({ statusCode: 400 });
  });
});
