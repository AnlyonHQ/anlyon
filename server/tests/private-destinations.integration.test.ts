import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

vi.stubEnv("EDITION", "enterprise");
vi.stubEnv("PRIVATE_NETWORK_DESTINATIONS", undefined);
vi.mock("../src/core/edition/features.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/edition/features.ts")>()),
  isFeatureEnabled: () => true,
}));

const settings = await import("../src/core/instance/settings.ts");
const { updateInstanceSettings } = await import("../src/core/instance/settings-admin.ts");
const audit = await import("../src/core/audit/service.ts");
const stores = await import("../src/core/secret-stores/service.ts");
const { currentEdition } = await import("../src/core/edition/edition.ts");

const KEY = "network.private_destinations";
const run = Math.random().toString(36).slice(2, 10);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let ws = "";
const userId = `user_pd_${run}`;
const admin = { actor: { type: "user" as const, id: userId }, context: {} };

beforeAll(async () => {
  expect(currentEdition()).toBe("enterprise");
  await pool.query(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'PD', $2, true, now(), now())`, [userId, `${userId}@example.com`]);
  ws = (await pool.query<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('PD', $1) RETURNING id`, [`pd-${run}`])).rows[0]!.id;
  await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [ws, userId]);
  await pool.query(`INSERT INTO audit_settings (workspace_id, allow_private_destinations) VALUES ($1, true)`, [ws]);
  await pool.query(`INSERT INTO secret_store_settings (workspace_id, allow_private_network, updated_at) VALUES ($1, true, now())`, [ws]);
  await pool.query(`DELETE FROM instance_settings WHERE key = $1`, [KEY]);
  await settings.loadInstanceSettings();
});

afterAll(async () => {
  await pool.query(`DELETE FROM instance_settings WHERE key = $1`, [KEY]);
  if (ws) await pool.query(`DELETE FROM workspaces WHERE id = $1`, [ws]);
  await pool.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
  await pool.end();
});

describe("private network destinations, an instance setting", () => {
  it("leave the choice to each workspace by default, as before the setting existed", async () => {
    expect(settings.instanceSettingSource(KEY)).toBe("default");
    expect(await audit.privateNetworkAllowed(ws)).toBe(true);
    expect(await stores.privateNetworkAllowed(ws)).toBe(true);
    expect(await audit.getAuditSettings(ws)).toMatchObject({ allowPrivateDestinations: true, privateDestinationsAvailable: true });
    expect(await stores.getSecretStoreSettings(ws)).toMatchObject({ allowPrivateNetwork: true, available: true, effective: true });
  });

  it("turned off by an instance admin, are saved with an audit record and refused in every workspace at once", async () => {
    expect(await updateInstanceSettings({ [KEY]: "off" }, userId)).toEqual([KEY]);
    const stored = await pool.query(`SELECT value, encrypted_value, updated_by FROM instance_settings WHERE key = $1`, [KEY]);
    expect(stored.rows).toEqual([{ value: "off", encrypted_value: null, updated_by: userId }]);
    const records = await pool.query<{ data: { changed: string[] } }>(
      `SELECT data FROM audit_events WHERE workspace_id = $1 AND type = 'instance.settings_updated'`, [ws],
    );
    expect(records.rows.some((row) => row.data.changed.includes(KEY))).toBe(true);

    expect(await audit.privateNetworkAllowed(ws)).toBe(false);
    expect(await stores.privateNetworkAllowed(ws)).toBe(false);
    expect(await audit.getAuditSettings(ws)).toMatchObject({ allowPrivateDestinations: true, privateDestinationsAvailable: false });
    expect(await stores.getSecretStoreSettings(ws)).toMatchObject({ allowPrivateNetwork: true, available: false, effective: false });
    await expect(audit.updateAuditSettings(ws, { allowPrivateDestinations: true }, admin)).rejects.toMatchObject({ statusCode: 400 });
    await expect(stores.updateSecretStoreSettings(ws, { allowPrivateNetwork: true }, userId)).rejects.toThrow(/instance admin has turned off/);
    await expect(audit.createSink(ws, { name: "Internal", type: "webhook", config: { url: "https://10.0.0.5/audit" } }, admin))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("reach another server from the database on its next reload", async () => {
    settings.setStoredInstanceSettingsForTest({});
    expect(await audit.privateNetworkAllowed(ws)).toBe(true);
    await settings.loadInstanceSettings();
    expect(settings.instanceSettingSource(KEY)).toBe("database");
    expect(await audit.privateNetworkAllowed(ws)).toBe(false);
  });

  it("go back to the workspaces' choice when the setting is cleared", async () => {
    await updateInstanceSettings({ [KEY]: null }, userId);
    expect((await pool.query(`SELECT 1 FROM instance_settings WHERE key = $1`, [KEY])).rowCount).toBe(0);
    expect(settings.instanceSetting(KEY)).toBe("workspace");
    expect(await audit.privateNetworkAllowed(ws)).toBe(true);
    expect(await stores.privateNetworkAllowed(ws)).toBe(true);
  });

  it("refuse a value that is neither workspace nor off, and change nothing", async () => {
    await expect(updateInstanceSettings({ [KEY]: "everyone" }, userId)).rejects.toMatchObject({ statusCode: 400 });
    expect((await pool.query(`SELECT 1 FROM instance_settings WHERE key = $1`, [KEY])).rowCount).toBe(0);
  });
});
