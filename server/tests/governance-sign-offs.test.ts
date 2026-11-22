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
vi.mock("../src/core/edition/features.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/edition/features.ts")>()),
  isFeatureEnabled: () => true,
}));
const announceSignOff = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/core/governance/notify.ts", () => ({ announceSignOff }));

const sql = (text: string, params: unknown[] = []) => state.client!.query<Record<string, unknown>>(text, params);
const signOffs = await import("../src/core/governance/sign-offs.ts");
const { signSignOffLink, verifySignOffLink } = await import("../src/core/governance/sign-off-links.ts");
const { createLimit, getLimit, updateLimit } = await import("../src/core/effects/impact.ts");

const ws = "00000000-0000-4000-8000-00000000e0a1";
const env = "00000000-0000-4000-8000-00000000e0b1";
const keyA = "00000000-0000-4000-8000-00000000e0c1";
const keyB = "00000000-0000-4000-8000-00000000e0c2";
const admin = "user_signoff_admin";
const member = "user_signoff_member";
const scope = { workspaceId: ws, environmentId: env };
const asKey = (keyId: string) => ({ type: "api_key" as const, keyId, oauthClientId: null, userId: null, scopes: ["impact-limits:read", "impact-limits:write"] });
const readerFor = (keyId: string) => ({ type: "credential" as const, workspaceId: ws, environmentId: env, keyId, oauthClientId: null, userId: null });
const byAdmin = { userId: admin, via: "console" as const };

const raise = (limitId: string, amount: number, keyId = keyA) =>
  signOffs.requestSignOffIfLoosening(scope, { operation: "impact_limit.update", target: { id: limitId }, input: { amount } }, asKey(keyId));

const records = async (type: string, signOffId: string) =>
  (await sql("SELECT * FROM audit_events WHERE workspace_id = $1 AND type = $2 AND resource_id = $3", [ws, type, signOffId])).rows;

let seq = 0;
async function newLimit(amount = 500) {
  seq += 1;
  return createLimit(ws, env, { name: `Refunds ${seq}`, dimension: "money", currency: "usd", period: "day", amount });
}

beforeAll(async () => {
  await import("../src/db/index.ts");
  await sql("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'ws', 'ws-sign-off')", [ws]);
  await sql("INSERT INTO environments (id, workspace_id, name, slug, is_default) VALUES ($1, $2, 'prod', 'prod', true)", [env, ws]);
  for (const [id, role] of [[admin, "admin"], [member, "member"]]) {
    await sql(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, $1, $2, true, now(), now())`, [id, `${id}@example.com`]);
    await sql("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)", [ws, id, role]);
  }
}, 120_000);

describe("asking", () => {
  it("holds a loosening change as a pending request and leaves the limit as it was", async () => {
    const limit = await newLimit(500);
    const asked = await raise(limit.id, 5000);
    expect(asked?.created).toBe(true);
    const signOff = asked!.signOff;
    expect(signOff).toMatchObject({
      object: "sign_off_request", status: "pending", operation: "impact_limit.update", environmentId: env,
      resource: { type: "impact_limit", id: limit.id }, requestedBy: { type: "api_key", id: keyA },
      pollUrl: `/api/v2/sign-offs/${signOff.id}`, pollAfterSeconds: 5, decidedAt: null, decidedBy: null,
    });
    expect(signOff.id).toMatch(/^sor_/);
    expect(signOff.signOffUrl).toMatch(new RegExp(`/sign-offs/${signOff.id}$`));
    expect(signOff.summary).toContain("from 500 to 5000");
    expect(signOff.diff).toContain("amount (loosens)");
    expect(Date.parse(signOff.expiresAt) - Date.parse(signOff.createdAt)).toBe(24 * 3600_000);
    expect((await getLimit(ws, env, limit.id)).limit).toBe(500);
    expect(await records("sign_off.requested", signOff.id)).toHaveLength(1);
    expect(announceSignOff).toHaveBeenCalled();
  });

  it("returns the same pending request when the same credential asks again", async () => {
    const limit = await newLimit(500);
    const first = await raise(limit.id, 900);
    const second = await raise(limit.id, 900);
    expect(second).toMatchObject({ created: false, signOff: { id: first!.signOff.id } });
    expect((await raise(limit.id, 900, keyB))!.signOff.id).not.toBe(first!.signOff.id);
  });

  it("lets a tightening change through: no request", async () => {
    const limit = await newLimit(500);
    expect(await raise(limit.id, 100)).toBeNull();
    expect(await raise(limit.id, 500)).toBeNull();
  });

  it("stores the request body sealed, never in the clear", async () => {
    const limit = await newLimit(500);
    const asked = await raise(limit.id, 777_777);
    const [row] = (await sql("SELECT sealed_input FROM sign_off_requests WHERE sign_off_id = $1", [asked!.signOff.id])).rows;
    expect(String(row.sealed_input)).not.toContain("777777");
    expect(String(row.sealed_input)).not.toContain("amount");
  });
});

describe("deciding", () => {
  it("applies the change when an admin approves, once, and records who approved", async () => {
    const limit = await newLimit(500);
    const { signOff } = (await raise(limit.id, 2000))!;
    const approved = await signOffs.approveSignOff(ws, signOff.id, { ...byAdmin, note: "for the sale" });
    expect(approved).toMatchObject({ status: "applied", decidedBy: { type: "user", id: admin, via: "console" }, decisionNote: "for the sale" });
    expect((await getLimit(ws, env, limit.id)).limit).toBe(2000);
    expect(await records("sign_off.approved", signOff.id)).toHaveLength(1);
    await expect(signOffs.approveSignOff(ws, signOff.id, byAdmin)).rejects.toMatchObject({ statusCode: 409, code: "SIGN_OFF_NOT_PENDING" });
    await expect(signOffs.rejectSignOff(ws, signOff.id, byAdmin)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses a member, and anyone outside the workspace", async () => {
    const limit = await newLimit(500);
    const { signOff } = (await raise(limit.id, 2000))!;
    await expect(signOffs.approveSignOff(ws, signOff.id, { userId: member, via: "console" })).rejects.toMatchObject({ statusCode: 403 });
    await expect(signOffs.approveSignOff(ws, signOff.id, { userId: "user_stranger", via: "console" })).rejects.toMatchObject({ statusCode: 403 });
    expect((await getLimit(ws, env, limit.id)).limit).toBe(500);
  });

  it("leaves the limit alone when an admin rejects", async () => {
    const limit = await newLimit(500);
    const { signOff } = (await raise(limit.id, 2000))!;
    const rejected = await signOffs.rejectSignOff(ws, signOff.id, { ...byAdmin, via: "email_link", note: "no" });
    expect(rejected).toMatchObject({ status: "rejected", decidedBy: { id: admin, via: "email_link" } });
    expect((await getLimit(ws, env, limit.id)).limit).toBe(500);
    expect(await records("sign_off.rejected", signOff.id)).toHaveLength(1);
  });

  it("fails instead of applying when the limit changed after the request", async () => {
    const limit = await newLimit(500);
    const { signOff } = (await raise(limit.id, 2000))!;
    await updateLimit(ws, env, limit.id, { amount: 300 });
    const result = await signOffs.approveSignOff(ws, signOff.id, byAdmin);
    expect(result).toMatchObject({ status: "failed", error: { code: "SIGN_OFF_STALE" } });
    expect((await getLimit(ws, env, limit.id)).limit).toBe(300);
    expect(await records("sign_off.failed", signOff.id)).toHaveLength(1);
  });
});

describe("expiry and cancelling", () => {
  it("expires a request past its time when read, and the sweep settles the rest", async () => {
    const limit = await newLimit(500);
    const a = (await raise(limit.id, 2000))!.signOff;
    const b = (await raise(limit.id, 3000))!.signOff;
    await sql("UPDATE sign_off_requests SET expires_at = now() - interval '1 minute' WHERE sign_off_id IN ($1, $2)", [a.id, b.id]);
    expect((await signOffs.getSignOff(a.id, readerFor(keyA))).status).toBe("expired");
    await expect(signOffs.approveSignOff(ws, a.id, byAdmin)).rejects.toMatchObject({ statusCode: 409 });
    expect(await signOffs.sweepSignOffs()).toBeGreaterThanOrEqual(1);
    expect((await signOffs.getSignOff(b.id, readerFor(keyA))).status).toBe("expired");
    expect(await records("sign_off.expired", a.id)).toHaveLength(1);
    expect(await records("sign_off.expired", b.id)).toHaveLength(1);
    expect((await getLimit(ws, env, limit.id)).limit).toBe(500);
  });

  it("lets only the credential that asked read or cancel its request", async () => {
    const limit = await newLimit(500);
    const { signOff } = (await raise(limit.id, 2000))!;
    await expect(signOffs.getSignOff(signOff.id, readerFor(keyB))).rejects.toMatchObject({ statusCode: 404 });
    await expect(signOffs.cancelSignOff(signOff.id, readerFor(keyB))).rejects.toMatchObject({ statusCode: 404 });
    expect((await signOffs.listSignOffs(readerFor(keyB))).map((s) => s.id)).not.toContain(signOff.id);
    expect((await signOffs.listSignOffs(readerFor(keyA), { status: "pending" })).map((s) => s.id)).toContain(signOff.id);
    expect((await signOffs.getSignOff(signOff.id, { type: "session", workspaceId: ws })).id).toBe(signOff.id);
    expect((await signOffs.cancelSignOff(signOff.id, readerFor(keyA))).status).toBe("cancelled");
    expect(await records("sign_off.cancelled", signOff.id)).toHaveLength(1);
    await expect(signOffs.approveSignOff(ws, signOff.id, byAdmin)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("the emailed link", () => {
  const key = "test-delivery-master-key-00000000";
  const claims = { signOffId: "sor_abc", userId: admin, expiresAt: Math.floor(Date.now() / 1000) + 3600 };

  it("round-trips its claims", () => {
    expect(verifySignOffLink(signSignOffLink(claims, key), key)).toEqual(claims);
  });

  it("refuses a changed, foreign, expired or malformed token", () => {
    const token = signSignOffLink(claims, key);
    const [v, body, mac] = token.split(".");
    const otherBody = Buffer.from(JSON.stringify({ s: "sor_abc", u: "user_someone_else", e: claims.expiresAt })).toString("base64url");
    expect(verifySignOffLink(`${v}.${otherBody}.${mac}`, key)).toBeNull();
    expect(verifySignOffLink(token, "another-master-key-of-32-characters!")).toBeNull();
    expect(verifySignOffLink(token, key, claims.expiresAt)).toBeNull();
    expect(verifySignOffLink(`${v}.${body}`, key)).toBeNull();
    expect(verifySignOffLink("", key)).toBeNull();
    expect(verifySignOffLink(`v2.${body}.${mac}`, key)).toBeNull();
  });

  const post = async (signOffId: string, decision: string, userId = admin) => {
    const { signOffLinksRouter } = await import("../src/api/routes/sign-offs.ts");
    const { env: config } = await import("../src/config/env.ts");
    const token = signSignOffLink({ signOffId, userId, expiresAt: Math.floor(Date.now() / 1000) + 3600 }, config.DELIVERY_SECRET_MASTER_KEY);
    const page = await signOffLinksRouter.request(`/${token}`);
    const answer = await signOffLinksRouter.request(`/${token}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ decision }).toString(),
    });
    return { page: await page.text(), status: answer.status, html: await answer.text() };
  };

  it("shows the change with a way to the console and a reject button, and no approve button", async () => {
    const limit = await newLimit(500);
    const { signOff } = await raise(limit.id, 900) as { signOff: { id: string } };
    const { page } = await post(signOff.id, "noop");
    expect(page).toContain("Review and approve in the console");
    expect(page).toContain('value="reject"');
    expect(page).not.toContain('value="approve"');
  });

  it("never applies a change, whoever posts approve: the request stays pending and the limit is as it was", async () => {
    const limit = await newLimit(500);
    const { signOff } = await raise(limit.id, 900) as { signOff: { id: string } };
    const answer = await post(signOff.id, "approve");
    expect(answer.status).toBe(403);
    expect(answer.html).toContain("Nothing changed");
    expect((await signOffs.getSignOff(signOff.id, readerFor(keyA))).status).toBe("pending");
    expect((await getLimit(ws, env, limit.id)).limit).toBe(500);
    expect(await records("sign_off.approved", signOff.id)).toHaveLength(0);
    expect((await signOffs.approveSignOff(ws, signOff.id, byAdmin)).status).toBe("applied");
    expect((await getLimit(ws, env, limit.id)).limit).toBe(900);
  });

  it("rejects from the link, as the admin it was sent to, and not for someone who is not an admin", async () => {
    const limit = await newLimit(500);
    const first = await raise(limit.id, 900) as { signOff: { id: string } };
    expect((await post(first.signOff.id, "reject", member)).status).toBe(403);
    expect((await signOffs.getSignOff(first.signOff.id, readerFor(keyA))).status).toBe("pending");
    const answer = await post(first.signOff.id, "reject");
    expect(answer.status).toBe(200);
    expect((await signOffs.getSignOff(first.signOff.id, readerFor(keyA))).status).toBe("rejected");
    expect((await getLimit(ws, env, limit.id)).limit).toBe(500);
  });
});
