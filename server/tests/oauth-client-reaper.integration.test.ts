import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://anlyon:anlyon@localhost:5433/anlyon_test";

let pool: Pool;
let available = false;
const suffix = randomUUID().slice(0, 8);
const userId = `reaper_user_${suffix}`;

const HOUR_MS = 60 * 60 * 1000;
const ids: string[] = [];

async function client(opts: { ageMs?: number; disabled?: boolean; owned?: boolean; skipConsent?: boolean } = {}): Promise<string> {
  const clientId = `reaper_${randomUUID().slice(0, 12)}`;
  ids.push(clientId);
  await pool.query(
    `INSERT INTO oauth_client (id, client_id, name, redirect_uris, public, disabled, user_id, skip_consent, created_at, updated_at)
     VALUES ($1, $2, 'Reaper Test', ARRAY['http://localhost:1/cb'], true, $3, $4, $5, now() - ($6 || ' milliseconds')::interval, now())`,
    [randomUUID(), clientId, opts.disabled ?? false, opts.owned ? userId : null, opts.skipConsent ?? false, String(opts.ageMs ?? 0)],
  );
  return clientId;
}

const exists = async (clientId: string) =>
  ((await pool.query(`SELECT 1 FROM oauth_client WHERE client_id = $1`, [clientId])).rowCount ?? 0) > 0;

beforeAll(async () => {
  const probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  try {
    await probe.query("SELECT 1");
    available = true;
  } catch {
    available = false;
  } finally {
    await probe.end();
  }
  if (!available) return;

  pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'Reaper', $2, true, now(), now())`,
    [userId, `${userId}@test.dev`],
  );
});

afterAll(async () => {
  if (!available || !pool) return;
  await pool.query(`DELETE FROM oauth_client WHERE client_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
  await pool.end();
});

describe("sweepAbandonedOAuthClients", () => {
  it("reaps a registration that never completed a flow", async () => {
    if (!available) return;
    const abandoned = await client({ ageMs: 2 * HOUR_MS });
    const { sweepAbandonedOAuthClients } = await import("../src/core/auth/oauth-client-maintenance.ts");
    await sweepAbandonedOAuthClients();
    expect(await exists(abandoned)).toBe(false);
  });

  it("spares a registration still inside the abandonment window", async () => {
    if (!available) return;
    const fresh = await client({ ageMs: 5 * 60 * 1000 });
    const { sweepAbandonedOAuthClients } = await import("../src/core/auth/oauth-client-maintenance.ts");
    await sweepAbandonedOAuthClients();
    expect(await exists(fresh)).toBe(true);
  });

  it("spares an old client that holds a consent", async () => {
    if (!available) return;
    const consented = await client({ ageMs: 30 * 24 * HOUR_MS });
    await pool.query(
      `INSERT INTO oauth_consent (id, client_id, user_id, scopes, created_at, updated_at)
       VALUES ($1, $2, $3, ARRAY['openid'], now(), now())`,
      [randomUUID(), consented, userId],
    );
    const { sweepAbandonedOAuthClients } = await import("../src/core/auth/oauth-client-maintenance.ts");
    await sweepAbandonedOAuthClients();
    expect(await exists(consented)).toBe(true);
  });

  it("spares an old client that holds a live refresh token", async () => {
    if (!available) return;
    const active = await client({ ageMs: 30 * 24 * HOUR_MS });
    await pool.query(
      `INSERT INTO oauth_refresh_token (id, token, client_id, user_id, scopes, expires_at, created_at)
       VALUES ($1, $2, $3, $4, ARRAY['openid'], now() + interval '30 days', now())`,
      [randomUUID(), `rt_${randomUUID()}`, active, userId],
    );
    const { sweepAbandonedOAuthClients } = await import("../src/core/auth/oauth-client-maintenance.ts");
    await sweepAbandonedOAuthClients();
    expect(await exists(active)).toBe(true);
  });

  it("reaps a disabled client immediately, however new", async () => {
    if (!available) return;
    const disabled = await client({ ageMs: 0, disabled: true });
    const { sweepAbandonedOAuthClients } = await import("../src/core/auth/oauth-client-maintenance.ts");
    await sweepAbandonedOAuthClients();
    expect(await exists(disabled)).toBe(false);
  });

  it("never touches a client a human registered deliberately", async () => {
    if (!available) return;
    const owned = await client({ ageMs: 30 * 24 * HOUR_MS, owned: true });
    const { sweepAbandonedOAuthClients } = await import("../src/core/auth/oauth-client-maintenance.ts");
    await sweepAbandonedOAuthClients();
    expect(await exists(owned)).toBe(true);
  });

  it("never touches a first-party client, though an identity-only sign-in leaves nothing behind", async () => {
    if (!available) return;
    const firstParty = await client({ ageMs: 30 * 24 * HOUR_MS, skipConsent: true });
    const { sweepAbandonedOAuthClients } = await import("../src/core/auth/oauth-client-maintenance.ts");
    await sweepAbandonedOAuthClients();
    expect(await exists(firstParty)).toBe(true);
  });

  it("keeps a disabled first-party client: disabling it is the operator's switch, not a deletion", async () => {
    if (!available) return;
    const paused = await client({ ageMs: 30 * 24 * HOUR_MS, skipConsent: true, disabled: true });
    const { sweepAbandonedOAuthClients } = await import("../src/core/auth/oauth-client-maintenance.ts");
    await sweepAbandonedOAuthClients();
    expect(await exists(paused)).toBe(true);
  });
});
