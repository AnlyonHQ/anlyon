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
    redis: nothing,
    redisBlocking: nothing,
    RedisKeys: new Proxy({}, { get: (_t, name) => (...parts: unknown[]) => [String(name), ...parts].join(":") }),
    createBlockingConnection: () => nothing,
    incrementWithTtl: async () => 1,
    USAGE_COUNTER_TTL_SECONDS: 1,
    WAITING_EVENT_TTL_SECONDS: 1,
  };
});
vi.mock("../src/core/edition/edition.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/edition/edition.ts")>()),
  currentEdition: () => "enterprise",
  isCloudEdition: () => false,
  isLicensedEdition: () => true,
}));
vi.mock("../src/core/edition/features.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/edition/features.ts")>()),
  isFeatureEnabled: () => true,
}));
vi.mock("../src/utils/auth.ts", () => {
  const sql = (text: string, params: unknown[]) => state.client!.query<Record<string, unknown>>(text, params);
  return {
    auth: {
      $context: Promise.resolve({
        internalAdapter: {
          findUserByEmail: async (email: string) => (await sql(`SELECT id FROM "user" WHERE email = $1`, [email])).rows[0] ?? null,
          createUser: async (input: { email: string; name: string; emailVerified: boolean }) => {
            const id = `user_setup_${Math.random().toString(36).slice(2, 10)}`;
            await sql(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())`, [id, input.name, input.email, input.emailVerified]);
            return { id, ...input };
          },
          linkAccount: async (input: { userId: string; providerId: string; accountId: string; password: string }) => {
            await sql(
              `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, now(), now())`,
              [`acc_${input.userId}`, input.accountId, input.providerId, input.userId, input.password],
            );
          },
        },
        password: { hash: async (password: string) => `hashed:${password.length}` },
      }),
    },
  };
});
vi.mock("../src/core/workspace/service.ts", () => ({
  createWorkspace: async (userId: string, input: { name: string }) => {
    const { rows } = await state.client!.query<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`,
      [input.name, `ws-${userId.slice(-8)}`],
    );
    await state.client!.query(`INSERT INTO workspace_members (workspace_id, user_id, role, emergency_access) VALUES ($1, $2, 'admin', true)`, [rows[0]!.id, userId]);
    return { id: rows[0]!.id, name: input.name, slug: `ws-${userId.slice(-8)}`, credentials: {} };
  },
}));

vi.stubEnv("ANLYON_SETUP_TOKEN", "installer-token-0123456789abcdefghijklmnop");
vi.stubEnv("RESEND_API_KEY", undefined);
for (const name of ["SMTP_URL", "FROM_EMAIL", "SIGNUP_MODE", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "HUBSPOT_OAUTH_CLIENT_ID", "HUBSPOT_OAUTH_CLIENT_SECRET", "ANLYON_TELEMETRY"]) {
  vi.stubEnv(name, undefined);
}

const sql = (text: string, params: unknown[] = []) => state.client!.query<Record<string, unknown>>(text, params);
const setup = await import("../src/core/instance/setup.ts");
const settings = { ...(await import("../src/core/instance/settings.ts")), ...(await import("../src/core/instance/settings-admin.ts")) };
const admins = await import("../src/core/instance/admins.ts");
const telemetry = await import("../src/core/instance/telemetry.ts");
const { signupRefusal, defaultSignupChecks } = await import("../src/core/edition/signup.ts");
const { oauthClientFromEnv, OAUTH_APPS } = await import("../src/core/connections/oauth-apps.ts");
const { mailTransport, isEmailConfigured } = await import("../src/lib/resend-client.ts");

const TOKEN = "installer-token-0123456789abcdefghijklmnop";
const owner = { token: TOKEN, name: "First Owner", email: "Owner@Example.test", password: "a long enough password" };

let ownerId = "";

beforeAll(async () => {
  await state.client!.query("SELECT 1");
}, 120_000);

describe("first run", () => {
  it("waits for setup on an empty install and refuses every sign-up meanwhile", async () => {
    expect(await setup.isSetupPending()).toBe(true);
    const refusal = await signupRefusal("someone@example.test", { ...defaultSignupChecks(), mode: "open" });
    expect(refusal).toMatch(/not set up yet/);
  });

  it("refuses the owner without the right token, and changes nothing", async () => {
    await expect(setup.completeSetup({ ...owner, token: "not-the-token" })).rejects.toThrow(/setup token is not valid/);
    expect((await sql(`SELECT count(*)::int AS n FROM "user"`)).rows[0]!.n).toBe(0);
    expect(await setup.isSetupPending()).toBe(true);
  });

  it("creates the owner, their workspace and their instance admin role with the token", async () => {
    const created = await setup.completeSetup(owner, { requestId: "req_setup" });
    ownerId = created.userId;
    const [user] = (await sql(`SELECT email, email_verified FROM "user" WHERE id = $1`, [ownerId])).rows;
    expect(user).toMatchObject({ email: "owner@example.test", email_verified: true });
    expect(await admins.isInstanceAdmin(ownerId)).toBe(true);
    const audit = (await sql(`SELECT type, actor_id, workspace_id FROM audit_events WHERE type = 'instance.setup_completed'`)).rows;
    expect(audit).toEqual([{ type: "instance.setup_completed", actor_id: ownerId, workspace_id: created.workspaceId }]);
  });

  it("closes setup for good: a second owner is refused even with the token", async () => {
    expect(await setup.isSetupPending()).toBe(false);
    await expect(setup.completeSetup({ ...owner, email: "second@example.test" })).rejects.toMatchObject({ statusCode: 404 });
    await sql(`DELETE FROM "user"`).catch(() => {});
    expect(await setup.isSetupPending()).toBe(false);
    await sql(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'First Owner', 'owner@example.test', true, now(), now())`, [ownerId]);
    await sql(`INSERT INTO instance_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [ownerId]);
    await sql(`INSERT INTO workspaces (name, slug) VALUES ('Restored', 'ws-restored')`);
  });

  it("lets invited people sign up afterwards, and nobody else", async () => {
    const checks = defaultSignupChecks();
    expect(checks.mode).toBe("invite");
    expect(await signupRefusal("stranger@example.test", checks)).toMatch(/by invitation/);
  });
});

describe("instance settings", () => {
  it("stores a secret only encrypted, never returns it, and uses it at once", async () => {
    expect(mailTransport()).toBe("none");
    await settings.updateInstanceSettings({ "email.smtp_url": "smtp://mailer:hunter2-secret@mail.example.com:587", "email.from": "anlyon@example.test" }, ownerId);
    const rows = (await sql(`SELECT key, value, encrypted_value, updated_by FROM instance_settings WHERE key LIKE 'email.%' ORDER BY key`)).rows;
    expect(rows).toHaveLength(2);
    const smtp = rows.find((row) => row.key === "email.smtp_url")!;
    expect(smtp.value).toBeNull();
    expect(String(smtp.encrypted_value)).not.toContain("hunter2");
    expect(rows.find((row) => row.key === "email.from")).toMatchObject({ value: "anlyon@example.test", encrypted_value: null, updated_by: ownerId });
    expect(JSON.stringify(settings.describeInstanceSettings())).not.toContain("hunter2");
    expect(mailTransport()).toBe("smtp");
    expect(isEmailConfigured()).toBe(true);
  });

  it("records each change in every workspace, by key name only, in the change's transaction", async () => {
    const before = Number((await sql(`SELECT count(*)::int AS n FROM audit_events WHERE type = 'instance.settings_updated'`)).rows[0]!.n);
    await settings.updateInstanceSettings({ "accounts.signup_mode": "closed", "storage.s3_bucket": null }, ownerId);
    const after = (await sql(`SELECT workspace_id, data FROM audit_events WHERE type = 'instance.settings_updated' ORDER BY seq`)).rows;
    const workspaces = Number((await sql(`SELECT count(*)::int AS n FROM workspaces`)).rows[0]!.n);
    expect(after.length - before).toBe(workspaces);
    expect(after.at(-1)!.data).toEqual({ changed: ["accounts.signup_mode"], cleared: ["storage.s3_bucket"] });
    expect(JSON.stringify(after)).not.toContain("hunter2");
  });

  it("refuses a setting the environment sets, and keeps the stored one", async () => {
    vi.stubEnv("SIGNUP_MODE", "invite");
    await expect(settings.updateInstanceSettings({ "accounts.signup_mode": "open" }, ownerId)).rejects.toMatchObject({ statusCode: 409 });
    expect(settings.instanceSetting("accounts.signup_mode")).toBe("invite");
    vi.stubEnv("SIGNUP_MODE", undefined);
    expect(settings.instanceSetting("accounts.signup_mode")).toBe("closed");
  });

  it("hands an OAuth app pair saved in the console to the connection flow", async () => {
    expect(oauthClientFromEnv(OAUTH_APPS.hubspot!)).toBeNull();
    await settings.updateInstanceSettings({ "oauth.hubspot.client_id": "hub-client", "oauth.hubspot.client_secret": "hub-secret" }, ownerId);
    expect(oauthClientFromEnv(OAUTH_APPS.hubspot!)).toEqual({ clientId: "hub-client", clientSecret: "hub-secret" });
  });

  it("writes nothing when a change's audit record cannot be written", async () => {
    await sql(`ALTER TABLE audit_events ADD CONSTRAINT no_more_records CHECK (type <> 'instance.settings_updated') NOT VALID`);
    try {
      await expect(settings.updateInstanceSettings({ "email.from": "other@example.test" }, ownerId)).rejects.toThrow();
      expect((await sql(`SELECT value FROM instance_settings WHERE key = 'email.from'`)).rows[0]!.value).toBe("anlyon@example.test");
    } finally {
      await sql(`ALTER TABLE audit_events DROP CONSTRAINT no_more_records`);
    }
  });
});

describe("instance admins", () => {
  it("grants by email, and never removes the last one", async () => {
    await sql(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('user_second_admin', 'Second', 'second-admin@example.test', true, now(), now())`);
    await admins.grantInstanceAdmin("Second-Admin@example.test", ownerId);
    expect((await admins.listInstanceAdmins()).map((admin) => admin.userId).sort()).toEqual([ownerId, "user_second_admin"].sort());
    await admins.revokeInstanceAdmin("user_second_admin", ownerId);
    await expect(admins.revokeInstanceAdmin(ownerId, ownerId)).rejects.toMatchObject({ statusCode: 409 });
    expect(await admins.isInstanceAdmin(ownerId)).toBe(true);
    const types = (await sql(`SELECT DISTINCT type FROM audit_events WHERE type LIKE 'instance.admin_%' ORDER BY type`)).rows.map((row) => row.type);
    expect(types).toEqual(["instance.admin_granted", "instance.admin_revoked"]);
  });
});

describe("telemetry", () => {
  it("counts workspaces, members and the last day's activity, under a stable random id", async () => {
    const preview = await telemetry.telemetryPreview(new Date());
    expect(preview.schema).toBe("anlyon.telemetry.v1");
    expect(preview.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(preview.counts.workspaces).toBe(Number((await sql(`SELECT count(*)::int AS n FROM workspaces`)).rows[0]!.n));
    expect((await telemetry.telemetryPreview(new Date())).instanceId).toBe(preview.instanceId);
  });

  it("is off when an admin turns it off", async () => {
    expect(telemetry.telemetryEnabled()).toBe(true);
    await settings.updateInstanceSettings({ "telemetry.enabled": "false" }, ownerId);
    expect(telemetry.telemetryEnabled()).toBe(false);
  });
});
