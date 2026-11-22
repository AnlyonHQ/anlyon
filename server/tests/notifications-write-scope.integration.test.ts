import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const destination = vi.fn();
vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return {
    ...actual,
    safeFetch: (...args: unknown[]) => {
      destination(...args);
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    },
  };
});

const TOKENS = {
  memberDefault: "member.default.grant",
  memberChannels: "member.channels.grant",
  adminDefault: "admin.default.grant",
  adminChannels: "admin.channels.grant",
} as const;
const oauth = vi.hoisted(() => ({
  workspaceId: "",
  environmentId: "",
  identities: new Map<string, { userId: string; groups: string[] }>(),
}));

vi.mock("../src/core/auth/oauth-tokens.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/auth/oauth-tokens.ts")>();
  const { expandOAuthScopes } = await import("../src/core/auth/oauth-scopes.ts");
  const { AuthenticationError } = await import("../src/utils/errors.ts");
  return {
    ...actual,
    verifyOAuthAccessToken: async (token: string) => {
      const identity = oauth.identities.get(token);
      if (!identity) throw new AuthenticationError("Invalid or expired access token");
      return {
        userId: identity.userId,
        clientId: "client_notifications_test",
        workspaceId: oauth.workspaceId,
        environmentId: oauth.environmentId,
        scopes: expandOAuthScopes(identity.groups),
        grantedGroups: identity.groups,
        expiresAt: null,
      };
    },
  };
});

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://anlyon:anlyon@localhost:5433/anlyon_test";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("notifications scopes (real Postgres, real HTTP)", () => {
  let pool: Pool;
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };

  let memberId: string;
  let adminId: string;
  let workspaceId: string;
  let readKey: string;
  let defaultKey: string;
  let manageKey: string;
  let notificationId: string;

  const ATTACKER_URL = "https://attacker.example/hook";

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = (await import("../src/api/index.ts")).default as typeof app;
    const keys = await import("../src/core/auth/api-keys.ts");
    const envSvc = await import("../src/core/environments/service.ts");
    const { DEFAULT_OAUTH_SCOPES } = await import("../src/core/auth/oauth-scopes.ts");

    memberId = `user_${randomUUID()}`;
    adminId = `user_${randomUUID()}`;
    for (const id of [memberId, adminId]) {
      await pool.query(
        `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
         VALUES ($1, 'T', $2, false, now(), now())`,
        [id, `${id}@test.dev`],
      );
    }
    workspaceId = (
      await pool.query(`INSERT INTO workspaces (name, slug) VALUES ('Notif', $1) RETURNING id`, [
        `ws-${randomUUID().slice(0, 8)}`,
      ])
    ).rows[0].id;
    await pool.query(`UPDATE workspaces SET plan = 'enterprise' WHERE id = $1`, [workspaceId]);
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [workspaceId, memberId]);
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [workspaceId, adminId]);
    const environmentId = (await envSvc.ensureDefaultEnvironment(workspaceId)).id;

    oauth.workspaceId = workspaceId;
    oauth.environmentId = environmentId;
    const channels = [...DEFAULT_OAUTH_SCOPES, "anlyon:integrations"];
    oauth.identities.set(TOKENS.memberDefault, { userId: memberId, groups: DEFAULT_OAUTH_SCOPES });
    oauth.identities.set(TOKENS.memberChannels, { userId: memberId, groups: channels });
    oauth.identities.set(TOKENS.adminDefault, { userId: adminId, groups: DEFAULT_OAUTH_SCOPES });
    oauth.identities.set(TOKENS.adminChannels, { userId: adminId, groups: channels });

    readKey = (await keys.createApiKey(workspaceId, adminId, "reader", undefined, ["notifications:read"], environmentId)).key;
    defaultKey = (await keys.createApiKey(workspaceId, adminId, "default", undefined, undefined, environmentId)).key;
    manageKey = (
      await keys.createApiKey(workspaceId, adminId, "operator", undefined, ["notifications:read", "notifications:manage"], environmentId)
    ).key;
  }, 60_000);

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [[memberId, adminId]]);
    }
    await pool?.end().catch(() => {});
  });

  const call = (credential: string, path: string, method = "GET", body?: unknown) =>
    app.request(`/api/v2/notifications${path}`, {
      method,
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  async function seedNotification(type: "security_alert" | "quota_warning" = "security_alert"): Promise<string> {
    const { createNotification } = await import("../src/core/notifications/notification-service.ts");
    const created = await createNotification({ workspaceId, type, priority: "high", title: "Seeded", message: "Seeded for the scope test" });
    return created.id;
  }

  type Route = { name: string; method: string; path: string; body?: unknown };
  const inboxWrites = (): Route[] => [
    { name: "mark one read", method: "PATCH", path: `/${notificationId}/read` },
    { name: "mark all read", method: "PATCH", path: "/read-all" },
    { name: "dismiss", method: "DELETE", path: `/${notificationId}` },
  ];
  const ownWrite: Route = { name: "change own preferences", method: "PATCH", path: "/preferences/me", body: { mutedTypes: ["quota_warning"] } };
  const manageWrites: Route[] = [
    {
      name: "change workspace preferences",
      method: "PATCH",
      path: "/preferences",
      body: { webhookEnabled: true, webhookUrl: ATTACKER_URL, webhookSecret: "attacker-secret", emailRecipients: ["a@attacker.example"] },
    },
    { name: "test webhook", method: "POST", path: "/preferences/test-webhook", body: { webhookUrl: ATTACKER_URL } },
  ];

  async function expectWorkspaceSettingsUntouched() {
    expect(destination).not.toHaveBeenCalled();
    const prefs = (await (await call(readKey, "/preferences")).json()) as {
      data: { webhookUrl: string | null; hasWebhookSecret: boolean; emailRecipients: string[] };
    };
    expect(prefs.data.webhookUrl).not.toBe(ATTACKER_URL);
    expect(prefs.data.hasWebhookSecret).toBe(false);
    expect(prefs.data.emailRecipients).not.toContain("a@attacker.example");
  }

  it("a key holding only notifications:read reads, and is refused every write and the test webhook", async () => {
    notificationId = await seedNotification();
    destination.mockClear();

    for (const path of ["", "/unread-count", "/preferences"]) {
      expect((await call(readKey, path)).status, `GET ${path}`).toBe(200);
    }
    for (const route of [...inboxWrites(), ownWrite, ...manageWrites]) {
      const res = await call(readKey, route.path, route.method, route.body);
      expect(res.status, route.name).toBe(403);
      expect(JSON.stringify(await res.json()), route.name).toMatch(/notifications:(write|manage)/);
    }
    await expectWorkspaceSettingsUntouched();
    const row = await pool.query(`SELECT is_read FROM notifications WHERE id = $1`, [notificationId]);
    expect(row.rows).toEqual([{ is_read: false }]);
  });

  it("a key created with the default scopes works the inbox and cannot change workspace settings", async () => {
    notificationId = await seedNotification();
    destination.mockClear();

    for (const route of manageWrites) {
      const res = await call(defaultKey, route.path, route.method, route.body);
      expect(res.status, route.name).toBe(403);
      expect(JSON.stringify(await res.json()), route.name).toContain("notifications:manage");
    }
    await expectWorkspaceSettingsUntouched();
    for (const route of inboxWrites()) {
      expect((await call(defaultKey, route.path, route.method, route.body)).status, route.name).toBe(200);
    }
  });

  it("an API key has no user, so its own preferences answer a clear 403", async () => {
    for (const [method, body] of [["GET", undefined], ["PATCH", { mutedTypes: ["quota_warning"] }]] as const) {
      const res = await call(defaultKey, "/preferences/me", method, body);
      expect(res.status, method).toBe(403);
      expect(JSON.stringify(await res.json()), method).toContain("USER_IDENTITY_REQUIRED");
    }
  });

  it("a default OAuth grant changes its own muted types and cannot change workspace settings, even for an admin", async () => {
    notificationId = await seedNotification();
    destination.mockClear();

    for (const token of [TOKENS.memberDefault, TOKENS.adminDefault]) {
      for (const route of manageWrites) {
        const res = await call(token, route.path, route.method, route.body);
        expect(res.status, `${token} ${route.name}`).toBe(403);
        expect(JSON.stringify(await res.json()), route.name).toContain("notifications:manage");
      }
    }
    await expectWorkspaceSettingsUntouched();

    const saved = await call(TOKENS.memberDefault, "/preferences/me", "PATCH", { mutedTypes: ["quota_warning"] });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { data: { mutedTypes: string[] } }).data.mutedTypes).toEqual(["quota_warning"]);
    for (const route of inboxWrites()) {
      expect((await call(TOKENS.memberDefault, route.path, route.method)).status, route.name).toBe(200);
    }
  });

  it("a member's muted type is left out of that member's list and count, and still shows for everyone else", async () => {
    await pool.query(`DELETE FROM notifications WHERE workspace_id = $1`, [workspaceId]);
    await seedNotification("quota_warning");
    await seedNotification("security_alert");
    expect((await call(TOKENS.memberDefault, "/preferences/me", "PATCH", { mutedTypes: ["quota_warning"] })).status).toBe(200);

    type List = { data: { notifications: { type: string }[]; unreadCount: number } };
    const types = (list: List) => list.data.notifications.map((n) => n.type).sort();

    const mine = (await (await call(TOKENS.memberDefault, "")).json()) as List;
    expect(types(mine)).toEqual(["security_alert"]);
    expect(mine.data.unreadCount).toBe(1);
    const myCount = (await (await call(TOKENS.memberDefault, "/unread-count")).json()) as { data: { count: number } };
    expect(myCount.data.count).toBe(1);

    for (const other of [TOKENS.adminDefault, readKey]) {
      const theirs = (await (await call(other, "")).json()) as List;
      expect(types(theirs), other).toEqual(["quota_warning", "security_alert"]);
      expect(theirs.data.unreadCount, other).toBe(2);
    }
    const own = (await (await call(TOKENS.adminDefault, "/preferences/me")).json()) as { data: { mutedTypes: string[] } };
    expect(own.data.mutedTypes).toEqual([]);
  });

  it("notifications:manage through the sensitive group is still held to the member's role", async () => {
    destination.mockClear();
    for (const route of manageWrites) {
      const res = await call(TOKENS.memberChannels, route.path, route.method, route.body);
      expect(res.status, route.name).toBe(403);
      expect(JSON.stringify(await res.json()), route.name).toContain("admin");
    }
    await expectWorkspaceSettingsUntouched();
  });

  it("an admin's connection holding the sensitive group, and a key holding notifications:manage, change workspace settings", async () => {
    destination.mockClear();

    const changed = await call(TOKENS.adminChannels, "/preferences", "PATCH", { webhookEnabled: true, webhookUrl: "https://hooks.example/alerts" });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as { data: { webhookUrl: string } }).data.webhookUrl).toBe("https://hooks.example/alerts");
    expect((await call(TOKENS.adminChannels, "/preferences/test-webhook", "POST", { webhookUrl: "https://hooks.example/alerts" })).status).toBe(200);

    const byKey = await call(manageKey, "/preferences", "PATCH", { quotaAlertThresholds: [80, 100] });
    expect(byKey.status).toBe(200);
    expect((await call(manageKey, "/preferences/test-webhook", "POST", { webhookUrl: "https://hooks.example/alerts" })).status).toBe(200);
    expect(destination).toHaveBeenCalledTimes(2);

    expect((await call(manageKey, "/read-all", "PATCH")).status).toBe(403);
  });
});
