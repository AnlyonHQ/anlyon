import { randomUUID, createHmac } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signDeliveryPayloadForEnvironment, appendDeliverySignature } from "../src/utils/crypto.ts";
import { Receiver } from "../../sdks/typescript/sdk/src/receiver.ts";
import { createSubscriptionSchema } from "../src/utils/validation.ts";

const payload = '{"text":"héllo 🌍","amount":2}';
function assertBound(header: string, secret: string, environment: string) {
  const parts = header.split(",");
  expect(parts.filter(p => p.startsWith("t="))).toHaveLength(1);
  expect(parts.filter(p => p.startsWith("env="))).toEqual([`env=${environment}`]);
  const t = parts[0].slice(2);
  expect(parts).toContain(`v2=${createHmac("sha256", secret).update(`anlyon-delivery-v2.${t}.${environment}.${payload}`).digest("hex")}`);
  expect(parts).toContain(`v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`);
}

describe("environment signature format", () => {
  it("retains one scope/timestamp and both secrets' v1/v2 values through rotation", () => {
    const header = appendDeliverySignature(signDeliveryPayloadForEnvironment(payload, "new", "env_prod", 123), signDeliveryPayloadForEnvironment(payload, "old", "env_prod", 123));
    assertBound(header, "new", "env_prod");
    assertBound(header, "old", "env_prod");
    expect(header.split(",").filter(p => p.startsWith("v2="))).toHaveLength(2);
  });
  it.each(["X-Anlyon-Environment-Id", "x-anlyon-environment-id", "X-ANLYON-ENVIRONMENT-ID"])("rejects caller override %s", header => {
    expect(createSubscriptionSchema.safeParse({ url: "https://example.com", headers: { [header]: "production" } }).success).toBe(false);
  });
  it.each(["env.prod", "env,env=prod", "env\r\nx:evil", ""])("rejects ambiguous signer scope %s", environment => {
    expect(() => signDeliveryPayloadForEnvironment(payload, "secret", environment, 123)).toThrow();
  });
});

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("workspace delivery signing with real Postgres and Redis", () => {
  let pool: Pool;
  let workspaceId: string;
  let userId: string;
  let signing: typeof import("../src/core/auth/delivery-secrets.ts");
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    signing = await import("../src/core/auth/delivery-secrets.ts");
    userId = `signing_${randomUUID()}`;
    await pool.query('INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at) VALUES ($1,\'signing\',$2,false,now(),now())', [userId, `${userId}@test.dev`]);
    workspaceId = (await pool.query("INSERT INTO workspaces (name,slug) VALUES ('signing',$1) RETURNING id", [randomUUID()])).rows[0].id;
  });
  afterAll(async () => {
    if (workspaceId) {
      await signing.deleteDeliverySecret(workspaceId);
      await pool.query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
    }
    if (userId) await pool.query('DELETE FROM "user" WHERE id=$1', [userId]);
    await pool.end();
  });
  it("signs both environments with distinct attribution and preserves key rotation overlap", async () => {
    const production = randomUUID();
    const staging = randomUUID();
    const old = await signing.createDeliverySecret(workspaceId, userId);
    const prod = await signing.signDeliveryForWorkspace(workspaceId, payload, production);
    const stage = await signing.signDeliveryForWorkspace(workspaceId, payload, staging);
    assertBound(prod!.signature, old.secretKey, production);
    assertBound(stage!.signature, old.secretKey, staging);
    const receiver = new Receiver({ signingSecret: old.secretKey, expectedEnvironmentId: production });
    expect(receiver.verify({ signature: prod!.signature, body: payload })).toBe(true);
    expect(receiver.verify({ signature: stage!.signature, body: payload })).toBe(false);
    expect(prod!.signature).not.toBe(stage!.signature);
    const current = await signing.regenerateDeliverySecret(workspaceId, userId);
    const rotated = await signing.signDeliveryForWorkspace(workspaceId, payload, production);
    assertBound(rotated!.signature, old.secretKey, production);
    assertBound(rotated!.signature, current.secretKey, production);
    expect(receiver.verify({ signature: rotated!.signature, body: payload })).toBe(true);
    expect(new Receiver({ signingSecret: current.secretKey, expectedEnvironmentId: production })
      .verify({ signature: rotated!.signature, body: payload })).toBe(true);
    const legacy = await signing.signDeliveryForWorkspace(workspaceId, payload);
    expect(legacy!.signature).not.toContain("env=");
    expect(legacy!.signature.split(",").filter(p => p.startsWith("v1="))).toHaveLength(2);
  });
});
