import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const NOTIFICATION_ID = "22222222-2222-4222-8222-222222222222";

type AuthType = "apiKey" | "oauth" | "session";
interface Caller {
  authType: AuthType;
  scopes: string[];
  userId?: string;
}

const mocks = vi.hoisted(() => ({
  caller: { authType: "apiKey", scopes: [] } as { authType: string; scopes: string[]; userId?: string },
  role: "admin",
  getNotifications: vi.fn(),
  getUnreadCount: vi.fn(),
  updateNotificationPreferences: vi.fn(),
  getNotificationUserPreferences: vi.fn(),
  updateNotificationUserPreferences: vi.fn(),
  markNotificationAsRead: vi.fn(),
  markAllNotificationsAsRead: vi.fn(),
  deleteNotification: vi.fn(),
  sendTestWebhook: vi.fn(),
}));

vi.mock("../middleware/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../middleware/auth.ts")>();
  return {
    ...actual,
    requireApiKey: async (
      c: { set: (key: string, value: unknown) => void },
      next: () => Promise<void>,
    ) => {
      c.set("authType", mocks.caller.authType);
      c.set("apiKeyScopes", mocks.caller.scopes);
      c.set("workspaceId", WORKSPACE_ID);
      if (mocks.caller.userId) c.set("userId", mocks.caller.userId);
      await next();
    },
  };
});

vi.mock("../middleware/rateLimit.ts", () => ({
  rateLimitByWorkspace: async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock("../../core/workspace/roles.ts", () => ({
  resolveMemberRole: async () => ({ workspaceRole: mocks.role, role: mocks.role, grantedInEnvironmentId: null }),
}));

const preferences = { emailEnabled: true };

vi.mock("../../core/notifications/notification-service.ts", () => ({
  getNotifications: mocks.getNotifications,
  getUnreadCount: mocks.getUnreadCount,
  markNotificationAsRead: mocks.markNotificationAsRead,
  markAllNotificationsAsRead: mocks.markAllNotificationsAsRead,
  deleteNotification: mocks.deleteNotification,
  getNotificationPreferences: async () => preferences,
  updateNotificationPreferences: mocks.updateNotificationPreferences,
  initializeNotificationPreferences: async () => preferences,
  getNotificationUserPreferences: mocks.getNotificationUserPreferences,
  updateNotificationUserPreferences: mocks.updateNotificationUserPreferences,
  toPublicNotification: (notification: unknown) => notification,
  toPublicNotificationPreferences: (prefs: unknown) => prefs,
}));

vi.mock("../../core/notifications/webhook-service.ts", () => ({
  sendTestWebhook: mocks.sendTestWebhook,
}));

const { default: notificationsRouter } = await import("./notifications.ts");
const { buildErrorResponse } = await import("../middleware/error.ts");
const { DEFAULT_API_KEY_SCOPES, PRIVILEGED_API_KEY_SCOPES } = await import("../../core/auth/api-key-scopes.ts");
const { ADVERTISED_OAUTH_SCOPES, DEFAULT_OAUTH_SCOPES, OAUTH_SCOPE_GROUPS, expandOAuthScopes } = await import(
  "../../core/auth/oauth-scopes.ts"
);

const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/", notificationsRouter);

interface Route {
  name: string;
  method: string;
  path: string;
  body?: unknown;
}

const READS: Route[] = [
  { name: "list notifications", method: "GET", path: "/" },
  { name: "unread count", method: "GET", path: "/unread-count" },
  { name: "read workspace preferences", method: "GET", path: "/preferences" },
];
const OWN_READ: Route = { name: "read own preferences", method: "GET", path: "/preferences/me" };

const INBOX_WRITES: Route[] = [
  { name: "mark one read", method: "PATCH", path: `/${NOTIFICATION_ID}/read` },
  { name: "mark all read", method: "PATCH", path: "/read-all" },
  { name: "dismiss", method: "DELETE", path: `/${NOTIFICATION_ID}` },
];
const OWN_WRITE: Route = {
  name: "change own preferences",
  method: "PATCH",
  path: "/preferences/me",
  body: { mutedTypes: ["quota_warning"] },
};

const MANAGE_WRITES: Route[] = [
  {
    name: "change workspace preferences",
    method: "PATCH",
    path: "/preferences",
    body: { webhookUrl: "https://attacker.example/hook", webhookSecret: "s", emailRecipients: ["a@attacker.example"] },
  },
  {
    name: "test webhook",
    method: "POST",
    path: "/preferences/test-webhook",
    body: { webhookUrl: "https://attacker.example/hook" },
  },
];

const ALL_WRITES = [...INBOX_WRITES, OWN_WRITE, ...MANAGE_WRITES];

function request(caller: Caller, route: Route): Promise<Response> {
  mocks.caller = caller;
  return Promise.resolve(
    app.request(route.path, {
      method: route.method,
      headers: { "Content-Type": "application/json" },
      ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
    }),
  );
}

async function expectStatus(caller: Caller, routes: Route[], status: number) {
  for (const route of routes) {
    expect((await request(caller, route)).status, `${route.method} ${route.path} (${route.name})`).toBe(status);
  }
}

const writeCalls = () =>
  mocks.updateNotificationPreferences.mock.calls.length +
  mocks.updateNotificationUserPreferences.mock.calls.length +
  mocks.markNotificationAsRead.mock.calls.length +
  mocks.markAllNotificationsAsRead.mock.calls.length +
  mocks.deleteNotification.mock.calls.length +
  mocks.sendTestWebhook.mock.calls.length;

const manageCalls = () =>
  mocks.updateNotificationPreferences.mock.calls.length + mocks.sendTestWebhook.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = "admin";
  mocks.getNotifications.mockResolvedValue([]);
  mocks.getUnreadCount.mockResolvedValue(0);
  mocks.updateNotificationPreferences.mockResolvedValue(preferences);
  mocks.getNotificationUserPreferences.mockResolvedValue({ mutedTypes: [], updatedAt: null });
  mocks.updateNotificationUserPreferences.mockResolvedValue({ mutedTypes: ["quota_warning"], updatedAt: null });
  mocks.sendTestWebhook.mockResolvedValue(true);
});

describe("the route table covers the router", () => {
  it("names every route the router registers", () => {
    const registered = new Set(
      notificationsRouter.routes
        .filter((route) => route.method !== "ALL")
        .map((route) => `${route.method} ${route.path}`),
    );
    const tabled = new Set(
      [...READS, OWN_READ, ...ALL_WRITES].map((route) => `${route.method} ${route.path.replace(NOTIFICATION_ID, ":id")}`),
    );
    expect([...registered].sort()).toEqual([...tabled].sort());
  });
});

describe("a credential holding only notifications:read", () => {
  it.each(["apiKey", "oauth"] as const)("reads as %s", async (authType) => {
    await expectStatus({ authType, scopes: ["notifications:read"] }, READS, 200);
  });

  it.each(["apiKey", "oauth"] as const)("is refused every write as %s, and nothing is changed or sent", async (authType) => {
    const caller: Caller = { authType, scopes: ["notifications:read"], userId: authType === "oauth" ? "user_1" : undefined };
    for (const route of ALL_WRITES) {
      const response = await request(caller, route);
      expect(response.status, route.name).toBe(403);
      expect(JSON.stringify(await response.json()), route.name).toMatch(/notifications:(write|manage)/);
    }
    expect(writeCalls()).toBe(0);
  });
});

describe("a credential holding notifications:write", () => {
  const scopes = ["notifications:read", "notifications:write"];

  it.each(["apiKey", "oauth"] as const)("works the inbox as %s", async (authType) => {
    await expectStatus({ authType, scopes, userId: authType === "oauth" ? "user_1" : undefined }, INBOX_WRITES, 200);
  });

  it.each(["apiKey", "oauth"] as const)("cannot change workspace settings or send the test webhook as %s", async (authType) => {
    for (const route of MANAGE_WRITES) {
      const response = await request({ authType, scopes, userId: authType === "oauth" ? "user_1" : undefined }, route);
      expect(response.status, route.name).toBe(403);
      expect(JSON.stringify(await response.json()), route.name).toContain("notifications:manage");
    }
    expect(manageCalls()).toBe(0);
  });

  it("does not read without notifications:read", async () => {
    await expectStatus({ authType: "apiKey", scopes: ["notifications:write"] }, [...READS, OWN_READ], 403);
  });
});

describe("a credential holding notifications:manage", () => {
  it("changes workspace settings and sends the test webhook as an API key", async () => {
    await expectStatus({ authType: "apiKey", scopes: ["notifications:manage"] }, MANAGE_WRITES, 200);
    expect(manageCalls()).toBe(MANAGE_WRITES.length);
  });

  it("does not work the inbox without notifications:write", async () => {
    await expectStatus({ authType: "oauth", scopes: ["notifications:manage"], userId: "user_1" }, [...INBOX_WRITES, OWN_WRITE], 403);
  });

  it("is held to the consenting member's role on an OAuth connection", async () => {
    const scopes = expandOAuthScopes(["anlyon:integrations"]);
    expect(scopes).toContain("notifications:manage");
    mocks.role = "member";
    await expectStatus({ authType: "oauth", scopes, userId: "user_1" }, MANAGE_WRITES, 403);
    expect(manageCalls()).toBe(0);
    mocks.role = "admin";
    await expectStatus({ authType: "oauth", scopes, userId: "user_1" }, MANAGE_WRITES, 200);
  });
});

describe("own preferences need a person", () => {
  it("answers an API key with a clear 403 on both own-preference routes", async () => {
    const key: Caller = { authType: "apiKey", scopes: ["notifications:read", "notifications:write"] };
    for (const route of [OWN_READ, OWN_WRITE]) {
      const response = await request(key, route);
      expect(response.status, route.name).toBe(403);
      const body = JSON.stringify(await response.json());
      expect(body, route.name).toContain("USER_IDENTITY_REQUIRED");
      expect(body, route.name).toContain("An API key has no user");
    }
    expect(mocks.updateNotificationUserPreferences).not.toHaveBeenCalled();
  });

  it("saves the caller's own muted types under the caller's user, in the caller's workspace", async () => {
    const token: Caller = { authType: "oauth", scopes: ["notifications:read", "notifications:write"], userId: "user_7" };
    expect((await request(token, OWN_WRITE)).status).toBe(200);
    expect(mocks.updateNotificationUserPreferences).toHaveBeenCalledWith(WORKSPACE_ID, "user_7", ["quota_warning"]);
    expect((await request(token, OWN_READ)).status).toBe(200);
    expect(mocks.getNotificationUserPreferences).toHaveBeenCalledWith(WORKSPACE_ID, "user_7");
  });

  it("refuses a type that is not a notification type, and more than there are types", async () => {
    const token: Caller = { authType: "oauth", scopes: ["notifications:write"], userId: "user_7" };
    expect((await request(token, { ...OWN_WRITE, body: { mutedTypes: ["not_a_type"] } })).status).toBe(400);
    expect((await request(token, { ...OWN_WRITE, body: { mutedTypes: Array(16).fill("quota_warning") } })).status).toBe(400);
    expect((await request(token, { ...OWN_WRITE, body: {} })).status).toBe(400);
    expect(mocks.updateNotificationUserPreferences).not.toHaveBeenCalled();
  });
});

describe("a muted type shapes only the caller's own list and count", () => {
  it("passes the caller's muted types to the list and the unread count", async () => {
    mocks.getNotificationUserPreferences.mockResolvedValue({ mutedTypes: ["quota_warning"], updatedAt: null });
    const member: Caller = { authType: "session", scopes: [], userId: "user_1" };
    await request(member, READS[0]!);
    expect(mocks.getNotifications).toHaveBeenCalledWith(WORKSPACE_ID, expect.objectContaining({ mutedTypes: ["quota_warning"] }));
    expect(mocks.getUnreadCount).toHaveBeenLastCalledWith(WORKSPACE_ID, undefined, ["quota_warning"]);
    await request(member, READS[1]!);
    expect(mocks.getUnreadCount).toHaveBeenLastCalledWith(WORKSPACE_ID, undefined, ["quota_warning"]);
    expect(mocks.getNotificationUserPreferences).toHaveBeenCalledWith(WORKSPACE_ID, "user_1");
  });

  it("filters nothing for an API key, which has no user", async () => {
    await request({ authType: "apiKey", scopes: ["notifications:read"] }, READS[0]!);
    expect(mocks.getNotificationUserPreferences).not.toHaveBeenCalled();
    expect(mocks.getNotifications).toHaveBeenCalledWith(WORKSPACE_ID, expect.objectContaining({ mutedTypes: [] }));
    expect(mocks.getUnreadCount).toHaveBeenLastCalledWith(WORKSPACE_ID, undefined, []);
  });
});

describe("what is granted without asking", () => {
  it("puts notifications:write in the default API key scopes and keeps notifications:manage out", () => {
    expect(DEFAULT_API_KEY_SCOPES).toContain("notifications:read");
    expect(DEFAULT_API_KEY_SCOPES).toContain("notifications:write");
    expect(DEFAULT_API_KEY_SCOPES).not.toContain("notifications:manage");
    expect(PRIVILEGED_API_KEY_SCOPES).toContain("notifications:manage");
    expect(PRIVILEGED_API_KEY_SCOPES).not.toContain("notifications:write");
  });

  it("lets a default-scoped key work the inbox and refuses it the workspace settings", async () => {
    const key: Caller = { authType: "apiKey", scopes: [...DEFAULT_API_KEY_SCOPES] };
    await expectStatus(key, [...READS, ...INBOX_WRITES], 200);
    await expectStatus(key, MANAGE_WRITES, 403);
    expect(manageCalls()).toBe(0);
  });

  it("grants notifications:write through a group the default grant and discovery both cover", () => {
    const granting = Object.entries(OAUTH_SCOPE_GROUPS)
      .filter(([, group]) => (group.scopes as readonly string[]).includes("notifications:write"))
      .map(([name]) => name);
    expect(granting).toEqual(["anlyon:observability"]);
    expect(DEFAULT_OAUTH_SCOPES).toContain("anlyon:observability");
    expect(ADVERTISED_OAUTH_SCOPES).toContain("anlyon:observability");
  });

  it.each([
    ["the Observability group alone", ["anlyon:observability"]],
    ["the default grant", DEFAULT_OAUTH_SCOPES],
  ])("lets an OAuth token holding %s change its own muted types, and not the workspace's settings", async (_name, groups) => {
    mocks.role = "admin";
    const token: Caller = { authType: "oauth", scopes: expandOAuthScopes(groups), userId: "user_1" };
    await expectStatus(token, [...READS, OWN_READ, ...INBOX_WRITES, OWN_WRITE], 200);
    for (const route of MANAGE_WRITES) {
      const response = await request(token, route);
      expect(response.status, route.name).toBe(403);
      expect(JSON.stringify(await response.json()), route.name).toContain("notifications:manage");
    }
    expect(manageCalls()).toBe(0);
  });

  it("makes notifications:manage reachable through a sensitive group alone", () => {
    const granting = Object.entries(OAUTH_SCOPE_GROUPS).filter(([, group]) =>
      (group.scopes as readonly string[]).includes("notifications:manage"),
    );
    expect(granting.map(([name]) => name)).toEqual(["anlyon:integrations"]);
    for (const [name, group] of granting) {
      expect(group.sensitive).toBe(true);
      expect(DEFAULT_OAUTH_SCOPES).not.toContain(name);
    }
    expect(expandOAuthScopes(DEFAULT_OAUTH_SCOPES)).not.toContain("notifications:manage");
  });
});

describe("console sessions", () => {
  const session: Caller = { authType: "session", scopes: [], userId: "user_1" };

  it("lets a member read, mark read, dismiss and change their own preferences", async () => {
    mocks.role = "member";
    await expectStatus(session, [...READS, OWN_READ, ...INBOX_WRITES, OWN_WRITE], 200);
    expect(mocks.updateNotificationUserPreferences).toHaveBeenCalledWith(WORKSPACE_ID, "user_1", ["quota_warning"]);
  });

  it("refuses a member the workspace settings and the test webhook", async () => {
    mocks.role = "member";
    await expectStatus(session, MANAGE_WRITES, 403);
    expect(manageCalls()).toBe(0);
  });

  it.each(["admin"])("lets an %s do everything", async (role) => {
    mocks.role = role;
    await expectStatus(session, [...READS, OWN_READ, ...ALL_WRITES], 200);
  });
});
