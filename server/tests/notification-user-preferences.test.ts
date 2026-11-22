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
vi.mock("../src/core/integrations/integration-service.ts", () => ({
  sendToSlackIntegrations: vi.fn(),
  sendToDiscordIntegrations: vi.fn(),
}));

const {
  getNotifications,
  getUnreadCount,
  getNotificationUserPreferences,
  updateNotificationUserPreferences,
} = await import("../src/core/notifications/notification-service.ts");

const ws = "00000000-0000-4000-8000-00000000c401";
const otherWs = "00000000-0000-4000-8000-00000000c402";
const alice = "user_alice_0084";
const bob = "user_bob_0084";
const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => state.client!.query<T>(text, params);

async function notify(workspaceId: string, type: string) {
  await sql(
    "INSERT INTO notifications (workspace_id, type, title, message) VALUES ($1, $2::notification_type, $3, 'm')",
    [workspaceId, type, type],
  );
}

beforeAll(async () => {
  for (const [id, slug] of [[ws, "ws-0084"], [otherWs, "ws-0084-other"]]) {
    await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'ws', $2)", [id, slug]);
  }
  for (const id of [alice, bob]) {
    await sql(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'T', $2, false, now(), now())`,
      [id, `${id}@test.dev`],
    );
  }
  await notify(ws, "quota_warning");
  await notify(ws, "security_alert");
  await notify(ws, "approval_requested");
  await notify(otherWs, "quota_warning");
}, 120_000);

const types = (rows: { type: string }[]) => rows.map((row) => row.type).sort();

describe("a member's own notification preferences", () => {
  it("has nothing muted before the member saves anything", async () => {
    expect(await getNotificationUserPreferences(ws, alice)).toEqual({ mutedTypes: [], updatedAt: null });
  });

  it("saves one row per member and workspace, and replaces it on the next save", async () => {
    await updateNotificationUserPreferences(ws, alice, ["quota_warning", "quota_warning", "security_alert"]);
    const saved = await updateNotificationUserPreferences(ws, alice, ["quota_warning"]);
    expect(saved.mutedTypes).toEqual(["quota_warning"]);
    expect(saved.updatedAt).toBeInstanceOf(Date);
    const { rows } = await sql("SELECT muted_types FROM notification_user_preferences WHERE workspace_id = $1 AND user_id = $2", [ws, alice]);
    expect(rows).toEqual([{ muted_types: ["quota_warning"] }]);
    expect((await getNotificationUserPreferences(ws, alice)).mutedTypes).toEqual(["quota_warning"]);
  });

  it("leaves the muted type out of that member's list and unread count", async () => {
    const { mutedTypes } = await getNotificationUserPreferences(ws, alice);
    expect(types(await getNotifications(ws, { mutedTypes }))).toEqual(["approval_requested", "security_alert"]);
    expect(await getUnreadCount(ws, undefined, mutedTypes)).toBe(2);
  });

  it("still shows it to another member, and still stores it", async () => {
    const { mutedTypes } = await getNotificationUserPreferences(ws, bob);
    expect(mutedTypes).toEqual([]);
    expect(types(await getNotifications(ws, { mutedTypes }))).toEqual(["approval_requested", "quota_warning", "security_alert"]);
    expect(await getUnreadCount(ws, undefined, mutedTypes)).toBe(3);
    const { rows } = await sql<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE workspace_id = $1", [ws]);
    expect(rows[0]?.n).toBe(3);
  });

  it("is scoped to one workspace: the same member has nothing muted in another", async () => {
    expect((await getNotificationUserPreferences(otherWs, alice)).mutedTypes).toEqual([]);
    expect(types(await getNotifications(otherWs, { mutedTypes: [] }))).toEqual(["quota_warning"]);
  });

  it("unmutes with an empty list", async () => {
    await updateNotificationUserPreferences(ws, bob, ["security_alert"]);
    expect((await updateNotificationUserPreferences(ws, bob, [])).mutedTypes).toEqual([]);
    expect(await getUnreadCount(ws, undefined, (await getNotificationUserPreferences(ws, bob)).mutedTypes)).toBe(3);
  });
});

describe("migration 0084", () => {
  it("refuses a second row for the same member and workspace", async () => {
    await expect(
      sql("INSERT INTO notification_user_preferences (workspace_id, user_id) VALUES ($1, $2)", [ws, alice]),
    ).rejects.toThrow(/notification_user_preferences_ws_user_unique/);
  });

  it("defaults muted_types to an empty list", async () => {
    await sql("INSERT INTO notification_user_preferences (workspace_id, user_id) VALUES ($1, $2)", [otherWs, bob]);
    const { rows } = await sql("SELECT muted_types FROM notification_user_preferences WHERE workspace_id = $1", [otherWs]);
    expect(rows).toEqual([{ muted_types: [] }]);
  });

  it("removes a workspace's rows when the workspace is deleted", async () => {
    await sql("DELETE FROM workspaces WHERE id = $1", [otherWs]);
    const { rows } = await sql("SELECT 1 FROM notification_user_preferences WHERE workspace_id = $1", [otherWs]);
    expect(rows).toEqual([]);
  });
});
