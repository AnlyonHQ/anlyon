import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return {
    ...actual,
    safeFetch: () => Promise.resolve(new Response(JSON.stringify({ refunded: true }), { status: 200 })),
  };
});

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const targetsValidated = process.env.ANLYON_TEST_TARGETS === "ok";
const optedIn = process.env.ANLYON_RUN_CLI_E2E === "1";

const cliDir = resolve(__dirname, "../../sdks/typescript/cli");
const cliEntry = join(cliDir, "dist", "anlyon.js");
const DASHBOARD_ORIGIN = "http://localhost:3000";

describe.runIf(optedIn)("CLI end-to-end prerequisites", () => {
  it("has validated, explicitly designated disposable test targets", () => {
    expect(targetsValidated, "set TEST_DATABASE_URL, TEST_REDIS_URL and TEST_TARGETS_DISPOSABLE (see tests/support/test-target.ts)").toBe(true);
  });
});

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe.runIf(optedIn && targetsValidated)("anlyon CLI against the real API and OAuth server", () => {
  let pool: Pool;
  let server: { close: () => void };
  let baseUrl = "";
  let userId = "";
  let workspaceId = "";
  let environmentId = "";
  let cookie = "";
  let agentKey = "";
  const email = `cli-e2e-${randomUUID().slice(0, 8)}@test.dev`;
  const password = `pw-${randomUUID()}`;
  let reviewerId = "";
  let reviewerCookie = "";
  const reviewerEmail = `cli-e2e-reviewer-${randomUUID().slice(0, 8)}@test.dev`;
  const reviewerPassword = `pw-${randomUUID()}`;
  const configDir = mkdtempSync(join(tmpdir(), "anlyon-cli-e2e-"));
  const outputs: Run[] = [];

  const env = (overrides: Record<string, string | undefined> = {}) => {
    const merged: Record<string, string | undefined> = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ANLYON_"))),
      ANLYON_CONFIG_DIR: configDir,
      ANLYON_CREDENTIAL_STORE: "file",
      ANLYON_PROFILE: "e2e",
      ANLYON_NO_BROWSER: "1",
      ...overrides,
    };
    return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as Record<string, string>;
  };

  const asAgent = () => ({ ANLYON_API_KEY: agentKey, ANLYON_API_URL: baseUrl, ANLYON_PROFILE: undefined });

  function cli(argv: string[], onStderr?: (text: string) => void, overrides?: Record<string, string | undefined>): Promise<Run> {
    return new Promise((done) => {
      const child = spawn(process.execPath, [cliEntry, ...argv], { env: env(overrides), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => {
        stderr += d;
        onStderr?.(stderr);
      });
      child.on("close", (code) => {
        const run = { code, stdout, stderr };
        outputs.push(run);
        done(run);
      });
    });
  }

  async function browser(authorizationUrl: string, as: () => string = () => cookie): Promise<void> {
    const cookie = as();
    const authorize = await fetch(authorizationUrl, { headers: { Cookie: cookie, Accept: "text/html" }, redirect: "manual" });
    const consentPage =
      authorize.headers.get("location") ??
      (authorize.headers.get("content-type")?.includes("json") ? ((await authorize.json()) as { url?: string }).url : undefined);
    if (!consentPage) throw new Error(`authorize: HTTP ${authorize.status}`);
    const consentUrl = new URL(consentPage, baseUrl);
    if (!consentUrl.pathname.endsWith("/oauth/consent")) throw new Error(`authorize went to ${consentUrl.pathname}, not the consent page`);
    const consent = await fetch(`${baseUrl}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: DASHBOARD_ORIGIN },
      body: JSON.stringify({ accept: true, oauth_query: consentUrl.search.slice(1) }),
    });
    const body = (await consent.json()) as { redirect_uri?: string; url?: string };
    const back = body.redirect_uri ?? body.url;
    if (!consent.ok || !back) throw new Error(`consent: HTTP ${consent.status} ${JSON.stringify(body)}`);
    const callback = await fetch(back);
    if (callback.status !== 200) throw new Error(`loopback callback: HTTP ${callback.status}`);
  }

  function storedCredential(): { refreshToken?: string; accessToken?: string; accessTokenExpiresAt?: number } {
    const dir = join(configDir, "credentials");
    const [file] = readdirSync(dir);
    return JSON.parse(readFileSync(join(dir, file!), "utf8"));
  }

  function expireStoredAccessToken(): void {
    const dir = join(configDir, "credentials");
    const [file] = readdirSync(dir);
    const credential = JSON.parse(readFileSync(join(dir, file!), "utf8"));
    writeFileSync(join(dir, file!), JSON.stringify({ ...credential, accessTokenExpiresAt: 0 }), { mode: 0o600 });
  }

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    process.env.BETTER_AUTH_URL = baseUrl;

    const build = spawnSync("pnpm", ["exec", "tsup"], { cwd: cliDir, encoding: "utf8", shell: true });
    if (build.status !== 0) throw new Error(`CLI build failed:\n${build.stdout}\n${build.stderr}`);

    pool = new Pool({ connectionString: DATABASE_URL });
    const { hashPassword } = await import("better-auth/crypto");
    const envSvc = await import("../src/core/environments/service.ts");
    const actionSvc = await import("../src/core/actions/service.ts");
    const app = (await import("../src/api/index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
    const { serve } = await import("@hono/node-server");

    userId = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'CLI E2E', $2, true, now(), now())`,
      [userId, email],
    );
    await pool.query(
      `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES ($1, $2, 'credential', $2, $3, now(), now())`,
      [randomUUID(), userId, await hashPassword(password)],
    );
    workspaceId = (
      await pool.query(`INSERT INTO workspaces (name, slug, plan) VALUES ('CLI E2E', $1, 'enterprise') RETURNING id`, [
        `ws-${randomUUID().slice(0, 8)}`,
      ])
    ).rows[0].id;
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [workspaceId, userId]);
    reviewerId = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'CLI E2E reviewer', $2, true, now(), now())`,
      [reviewerId, reviewerEmail],
    );
    await pool.query(
      `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES ($1, $2, 'credential', $2, $3, now(), now())`,
      [randomUUID(), reviewerId, await hashPassword(reviewerPassword)],
    );
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'approver')`, [workspaceId, reviewerId]);
    environmentId = (await envSvc.ensureDefaultEnvironment(workspaceId)).id;
    await pool.query(
      `INSERT INTO environments (workspace_id, name, slug, kind, is_default) VALUES ($1, 'Staging', 'staging', 'staging', false)`,
      [workspaceId],
    );
    await actionSvc.createAction(
      workspaceId,
      { name: "cli_e2e_read", urlTemplate: "https://shop.test/read", method: "GET" },
      actionSvc.UNSCOPED_AUTHORITY,
      environmentId,
    );

    await actionSvc.createAction(
      workspaceId,
      { name: "cli_e2e_refund", urlTemplate: "https://shop.test/refund", method: "POST", requiresApproval: true },
      actionSvc.UNSCOPED_AUTHORITY,
      environmentId,
    );
    const keys = await import("../src/core/auth/api-keys.ts");
    const scopes = await import("../src/core/auth/api-key-scopes.ts");
    agentKey = (await keys.createApiKey(workspaceId, userId, "cli-e2e-agent", undefined, [...scopes.DEFAULT_API_KEY_SCOPES] as never, environmentId)).key;

    const started = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
    server = started as unknown as { close: () => void };
    await new Promise((ready) => (started as unknown as NodeJS.EventEmitter).once("listening", ready));

    const signIn = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: DASHBOARD_ORIGIN },
      body: JSON.stringify({ email, password }),
    });
    if (!signIn.ok) throw new Error(`sign-in: HTTP ${signIn.status} ${await signIn.text()}`);
    cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const reviewerSignIn = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: DASHBOARD_ORIGIN },
      body: JSON.stringify({ email: reviewerEmail, password: reviewerPassword }),
    });
    if (!reviewerSignIn.ok) throw new Error(`reviewer sign-in: HTTP ${reviewerSignIn.status} ${await reviewerSignIn.text()}`);
    reviewerCookie = reviewerSignIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  }, 180_000);

  afterAll(async () => {
    server?.close();
    if (workspaceId) await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    for (const id of [userId, reviewerId].filter(Boolean)) {
      await pool.query(`DELETE FROM oauth_client WHERE client_id IN (SELECT client_id FROM oauth_consent WHERE user_id = $1)`, [id]).catch(() => {});
      await pool.query('DELETE FROM "user" WHERE id = $1', [id]);
    }
    await pool?.end().catch(() => {});
    rmSync(configDir, { recursive: true, force: true });
  });

  it("logs in through registration, PKCE, consent and the loopback redirect", async () => {
    let started = false;
    let browserError: unknown;
    const login = await cli(["auth", "login", "--api-url", baseUrl, "--timeout", "60s", "--json"], (text) => {
      const match = /^\s+(http:\/\/127\.0\.0\.1:\d+\/api\/auth\/oauth2\/authorize\S+)/m.exec(text);
      if (match && !started) {
        started = true;
        browser(match[1]!).catch((error) => (browserError = error));
      }
    });
    expect(browserError).toBeUndefined();
    expect(login.code, login.stderr).toBe(0);
    const result = JSON.parse(login.stdout);
    expect(result).toMatchObject({ profile: "e2e", credentialType: "oauth", workspaceId, environment: { id: environmentId } });
    expect(result.grantedGroups).toEqual(expect.arrayContaining(["anlyon:actions", "anlyon:observability", "offline_access"]));
    expect(result.scopes).toEqual(expect.arrayContaining(["actions:read", "runs:read", "approvals:read"]));
    expect(result.scopes).not.toContain("approvals:decide");
    expect(result.scopes).not.toContain("policies:read");

    const consent = await pool.query(`SELECT client_id FROM oauth_consent WHERE user_id = $1`, [userId]);
    expect(consent.rowCount).toBe(1);
    const client = await pool.query(`SELECT public, client_secret FROM oauth_client WHERE client_id = $1`, [consent.rows[0].client_id]);
    expect(client.rows[0].public).toBe(true);
    expect(client.rows[0].client_secret).toBeNull();
  }, 120_000);

  it("reads through /api/v2 with the OAuth token, as the bound workspace and environment", async () => {
    const who = await cli(["whoami", "--json"]);
    expect(who.code, who.stderr).toBe(0);
    expect(JSON.parse(who.stdout)).toMatchObject({ credentialType: "oauth", workspaceId, environment: { id: environmentId }, user: { email } });

    const actions = await cli(["actions", "list", "--json"]);
    expect(actions.code, actions.stderr).toBe(0);
    expect(JSON.parse(actions.stdout).data.map((a: { name: string }) => a.name)).toContain("cli_e2e_read");
    for (const argv of [["runs", "list"], ["approvals", "list", "--status", "pending"], ["invocations", "list"]]) {
      const run = await cli([...argv, "--json"]);
      expect(run.code, `${argv.join(" ")}: ${run.stderr}`).toBe(0);
    }
  }, 120_000);

  it("stops where OAuth grants nothing, and never overrides the environment", async () => {
    const policies = await cli(["policies", "list", "--json"]);
    expect(policies.code).toBe(4);
    expect(JSON.parse(policies.stderr).error.message).toContain("policies:read");

    const staging = await cli(["actions", "list", "--environment", "staging", "--json"]);
    expect(staging.code).toBe(10);
    expect((await cli(["actions", "list", "--environment", "production", "--json"])).code).toBe(0);
  }, 120_000);

  it("refreshes against the real token endpoint, serialised across processes", async () => {
    const before = storedCredential();
    expireStoredAccessToken();
    const runs = await Promise.all([1, 2, 3].map(() => cli(["runs", "list", "--json"])));
    for (const run of runs) expect(run.code, run.stderr).toBe(0);
    const after = storedCredential();
    expect(after.refreshToken).not.toBe(before.refreshToken);

    const reuse = await fetch(`${baseUrl}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: before.refreshToken!,
        client_id: (await pool.query(`SELECT client_id FROM oauth_consent WHERE user_id = $1`, [userId])).rows[0].client_id,
        resource: `${baseUrl}/mcp`,
      }).toString(),
    }).then((r) => r.status);
    expect(reuse).toBe(400);
  }, 120_000);

  it("logout revokes the refresh token server-side", async () => {
    let started = false;
    let browserError: unknown;
    const login = await cli(["auth", "login", "--api-url", baseUrl, "--timeout", "60s", "--json"], (text) => {
      const match = /^\s+(http:\/\/127\.0\.0\.1:\d+\/api\/auth\/oauth2\/authorize\S+)/m.exec(text);
      if (match && !started) {
        started = true;
        browser(match[1]!).catch((error) => (browserError = error));
      }
    });
    expect(browserError).toBeUndefined();
    expect(login.code, login.stderr).toBe(0);
    const { refreshToken } = storedCredential();
    const clientId = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).profiles.e2e.oauth.clientId;

    const logout = await cli(["auth", "logout", "--json"]);
    expect(JSON.parse(logout.stdout)).toMatchObject({ revoked: true, deleted: true });
    const afterLogout = await fetch(`${baseUrl}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken!, client_id: clientId, resource: `${baseUrl}/mcp` }).toString(),
    });
    expect(afterLogout.status).toBe(400);
    expect((await cli(["whoami"])).code).toBe(3);
  }, 120_000);

  async function loginToDecide(profile: Record<string, string | undefined> | undefined, as: () => string): Promise<void> {
    let started = false;
    let browserError: unknown;
    const login = await cli(["auth", "login", "--api-url", baseUrl, "--scope", "anlyon:approvals.decide", "--timeout", "60s", "--json"], (text) => {
      const match = /^\s+(http:\/\/127\.0\.0\.1:\d+\/api\/auth\/oauth2\/authorize\S+)/m.exec(text);
      if (match && !started) {
        started = true;
        browser(match[1]!, as).catch((error) => (browserError = error));
      }
    }, profile);
    expect(browserError).toBeUndefined();
    expect(login.code, login.stderr).toBe(0);
    expect(JSON.parse(login.stdout).scopes).toContain("approvals:decide");
  }

  const reviewer = { ANLYON_PROFILE: "reviewer" };

  it("an agent's key requests a gated action; its creator is refused, a second member approves", async () => {
    const key = `cli-e2e-${randomUUID()}`;
    const invoke = ["actions", "invoke", "cli_e2e_refund", "--data", '{"amount":4000}', "--idempotency-key", key, "--yes", "--json"];
    const pending = await cli(invoke, undefined, asAgent());
    expect(pending.code, pending.stderr).toBe(12);
    const invocation = JSON.parse(pending.stdout).data;
    expect(invocation.status).toBe("pending_approval");
    expect(invocation.approvalId).toMatch(/^apr_/);

    const replay = await cli(invoke, undefined, asAgent());
    expect(JSON.parse(replay.stdout).data.id).toBe(invocation.id);
    const approvals = await pool.query(`SELECT count(*)::int AS n FROM approvals WHERE workspace_id = $1`, [workspaceId]);
    expect(approvals.rows[0].n).toBe(1);

    const selfApprove = await cli(["approvals", "approve", invocation.approvalId, "--yes", "--json"], undefined, asAgent());
    expect(selfApprove.code).toBe(4);

    await loginToDecide(undefined, () => cookie);
    const ownKey = await cli(["approvals", "approve", invocation.approvalId, "--yes", "--json"]);
    expect(ownKey.code).toBe(4);
    expect(JSON.parse(ownKey.stderr).error.code).toBe("SELF_APPROVAL_NOT_ALLOWED");
    const stillPending = await cli(["invocations", "get", invocation.id, "--json"], undefined, asAgent());
    expect(JSON.parse(stillPending.stdout).data.status).toBe("pending_approval");

    await loginToDecide(reviewer, () => reviewerCookie);
    const approved = await cli(["approvals", "approve", invocation.approvalId, "--note", "verified with customer", "--yes", "--json"], undefined, reviewer);
    expect(approved.code, approved.stderr).toBe(0);
    const decision = JSON.parse(approved.stdout).data;
    expect(decision.approval.status).toBe("approved");
    expect(decision.invocation).toMatchObject({ id: invocation.id, status: "succeeded" });

    const after = await cli(["invocations", "get", invocation.id, "--json"], undefined, asAgent());
    expect(JSON.parse(after.stdout).data.status).toBe("succeeded");
    const lateReplay = await cli(invoke, undefined, asAgent());
    expect(lateReplay.code).toBe(0);
    expect(JSON.parse(lateReplay.stdout).data).toMatchObject({ id: invocation.id, status: "succeeded" });
  }, 180_000);

  it("an OAuth app cannot approve its own request, nor can its person from another login; a second member can", async () => {
    const pending = await cli(["actions", "invoke", "cli_e2e_refund", "--data", '{"amount":900}', "--yes", "--json"]);
    expect(pending.code, pending.stderr).toBe(12);
    const { approvalId, id: invocationId } = JSON.parse(pending.stdout).data;
    const [row] = (await pool.query(
      `SELECT requested_by_user_id, requested_by_oauth_client_id FROM approvals WHERE approval_id = $1`,
      [approvalId],
    )).rows;
    expect(row.requested_by_user_id).toBe(userId);
    expect(row.requested_by_oauth_client_id).toBe(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).profiles.e2e.oauth.clientId);

    const self = await cli(["approvals", "approve", approvalId, "--yes", "--json"]);
    expect(self.code).toBe(4);
    expect(JSON.parse(self.stderr).error.message).toMatch(/cannot decide an approval it requested/i);
    const stillPending = await cli(["invocations", "get", invocationId, "--json"]);
    expect(JSON.parse(stillPending.stdout).data.status).toBe("pending_approval");

    const secondLogin = { ANLYON_PROFILE: "owner-second-login" };
    await loginToDecide(secondLogin, () => cookie);
    const samePerson = await cli(["approvals", "approve", approvalId, "--yes", "--json"], undefined, secondLogin);
    expect(samePerson.code).toBe(4);
    expect(JSON.parse(samePerson.stderr).error.code).toBe("SELF_APPROVAL_NOT_ALLOWED");

    const approved = await cli(["approvals", "approve", approvalId, "--yes", "--json"], undefined, reviewer);
    expect(approved.code, approved.stderr).toBe(0);
    expect(JSON.parse(approved.stdout).data.invocation).toMatchObject({ id: invocationId, status: "succeeded" });
  }, 180_000);

  it("never printed a credential", () => {
    const config = readFileSync(join(configDir, "config.json"), "utf8");
    for (const run of outputs) {
      for (const text of [run.stdout, run.stderr]) {
        expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
      }
    }
    expect(config).not.toMatch(/refresh/i);
    expect(config).not.toMatch(/eyJ/);
    for (const run of outputs) expect(`${run.stdout}${run.stderr}`).not.toContain(agentKey);
  });
});
