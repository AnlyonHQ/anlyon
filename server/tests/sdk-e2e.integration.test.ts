import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";

vi.mock("../src/api/governance-gate.ts", async (importOriginal) => ({ ...(await importOriginal<object>()), signOffIfLoosening: async () => null }));
vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return {
    ...actual,
    safeFetch: () => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  };
});

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const targetsValidated = process.env.ANLYON_TEST_TARGETS === "ok";
const optedIn = process.env.ANLYON_RUN_SDK_E2E === "1";

const root = resolve(__dirname, "../..");
const tsSdk = resolve(root, "sdks/typescript/sdk");
const pySdk = resolve(root, "sdks/python/packages/anlyon");

const hasUv = spawnSync("uv", ["--version"], { shell: true }).status === 0;

const tsxBin = resolve(__dirname, "../node_modules/.bin/tsx");

describe.runIf(optedIn)("SDK end-to-end prerequisites", () => {
  it("has validated, explicitly designated disposable test targets", () => {
    expect(targetsValidated, "set TEST_DATABASE_URL, TEST_REDIS_URL and TEST_TARGETS_DISPOSABLE (see tests/support/test-target.ts)").toBe(true);
  });
  it("has uv available for the Python SDK", () => {
    expect(hasUv, "install uv: the Python SDK suite is a required scenario").toBe(true);
  });
});

function run(cmd: string, args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, shell: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    // eslint-disable-next-line no-control-regex
    child.on("close", (code) => done({ code: code ?? 1, out: out.replace(/\u001b\[[0-9;]*m/g, "") }));
  });
}

describe.runIf(optedIn && targetsValidated)("official SDKs against a real backend", () => {
  let pool: Pool;
  let server: { close: () => void };
  let baseUrl = "";
  let userId: string;
  let workspaceId: string;
  const creds: Record<string, string> = {};

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const keys = await import("../src/core/auth/api-keys.ts");
    const scopes = await import("../src/core/auth/api-key-scopes.ts");
    const envSvc = await import("../src/core/environments/service.ts");
    const actionSvc = await import("../src/core/actions/service.ts");
    const app = (await import("../src/api/index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
    const { serve } = await import("@hono/node-server");

    userId = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'T', $2, false, now(), now())`,
      [userId, `${userId}@test.dev`],
    );
    workspaceId = (
      await pool.query(`INSERT INTO workspaces (name, slug, plan) VALUES ('SDK E2E', $1, 'enterprise') RETURNING id`, [
        `ws-${randomUUID().slice(0, 8)}`,
      ])
    ).rows[0].id;
    const environmentId = (await envSvc.ensureDefaultEnvironment(workspaceId)).id;
    const otherEnvironmentId = (
      await pool.query(
        `INSERT INTO environments (workspace_id, name, slug, kind, is_default) VALUES ($1, 'Staging', 'staging', 'staging', false) RETURNING id`,
        [workspaceId],
      )
    ).rows[0].id;

    const mint = async (name: string, extra: string[], env: string) =>
      (await keys.createApiKey(workspaceId, userId, name, undefined, [...scopes.DEFAULT_API_KEY_SCOPES, ...extra] as never, env)).key;
    creds.ANLYON_E2E_OPERATOR_KEY = await mint("operator", ["actions:write", "policies:read", "policies:write"], environmentId);
    creds.ANLYON_E2E_RUNTIME_KEY = await mint("runtime", [], environmentId);
    creds.ANLYON_E2E_NARROW_KEY = (await keys.createApiKey(
      workspaceId, userId, "narrow-runtime", undefined,
      scopes.DEFAULT_API_KEY_SCOPES.filter((scope) => scope !== "runs:write"), environmentId,
    )).key;
    creds.ANLYON_E2E_OTHER_OPERATOR_KEY = await mint("other-operator", ["actions:write", "policies:read", "policies:write"], otherEnvironmentId);

    const action = (name: string, env: string) =>
      actionSvc.createAction(workspaceId, { name, urlTemplate: `https://shop.test/${name}`, method: "POST" }, actionSvc.UNSCOPED_AUTHORITY, env);
    await action("get_order", environmentId);
    await action("refund_order", environmentId);
    for (const lang of ["ts", "py"]) {
      await action(`read_${lang}`, environmentId);
      await action(`refund_${lang}`, environmentId);
      await action(`foreign_${lang}`, otherEnvironmentId);
    }

    const started = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    server = started as unknown as { close: () => void };
    await new Promise((ready) => (started as unknown as NodeJS.EventEmitter).once("listening", ready));
    baseUrl = `http://127.0.0.1:${((started as unknown as { address: () => AddressInfo }).address()).port}`;
    creds.ANLYON_E2E_BASE_URL = baseUrl;
    creds.ANLYON_BASE_URL = baseUrl;
    creds["ANLYON_OPERATOR_KEY"] = creds.ANLYON_E2E_OPERATOR_KEY;
    creds.ANLYON_RUNTIME_KEY = creds.ANLYON_E2E_RUNTIME_KEY;
  }, 120_000);

  afterAll(async () => {
    server?.close();
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
    }
    await pool?.end().catch(() => {});
  });

  const names = (lang: string) => ({
    ANLYON_E2E_READ_ACTION: `read_${lang}`,
    ANLYON_E2E_REFUND_ACTION: `refund_${lang}`,
    ANLYON_E2E_FOREIGN_ACTION: `foreign_${lang}`,
  });

  it("TypeScript SDK: the suite passes against the real API", async () => {
    const result = await run("pnpm", ["exec", "vitest", "run", "src/__tests__/real-backend.e2e.test.ts"], tsSdk, { ...creds, ...names("ts") });
    expect(result.out).toMatch(/Tests\s+5 passed/);
    expect(result.code, result.out).toBe(0);
  }, 300_000);

  it("TypeScript SDK: the runnable example succeeds", async () => {
    const build = await run("pnpm", ["exec", "tsup"], tsSdk, {});
    expect(build.code, build.out).toBe(0);
    const result = await run(tsxBin, ["examples/policy-governance.ts"], tsSdk, creds);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("refund_order: Denied by policy");
    expect(result.out).toContain("runtime key was refused");
  }, 300_000);

  it("Python SDK: the suite passes against the real API", async () => {
    const result = await run("uv", ["run", "--frozen", "--extra", "dev", "pytest", "tests/test_real_backend.py", "-q"], pySdk, { ...creds, ...names("py") });
    expect(result.out).toMatch(/5 passed/);
    expect(result.code, result.out).toBe(0);
  }, 300_000);

  it("Python SDK: the runnable example succeeds", async () => {
    const result = await run("uv", ["run", "--frozen", "--extra", "dev", "python", "examples/policy_governance.py"], pySdk, creds);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("refund_order: Denied by policy");
    expect(result.out).toContain("runtime key was refused");
  }, 300_000);
});
