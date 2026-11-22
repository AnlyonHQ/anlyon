import crypto from "node:crypto";
import { Pool } from "pg";
import { createApiKey } from "../core/auth/api-keys.ts";

async function main() {
  const plan = process.env.SMOKE_PLAN ?? "paygo";
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const suffix = crypto.randomUUID().slice(0, 8);

  const userId = `smoke-user-${suffix}`;
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'Smoke Test', $2, true, now(), now())
     ON CONFLICT (id) DO NOTHING;`,
    [userId, `smoke-${suffix}@example.invalid`]
  );

  const workspaceId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO workspaces (id, name, slug, plan, created_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now());`,
    [workspaceId, `smoke-${suffix}`, `smoke-${suffix}`, plan]
  );

  const { key, apiKey } = await createApiKey(workspaceId, userId, `smoke-${suffix}`);
  const { key: deciderKey } = await createApiKey(workspaceId, userId, `smoke-${suffix}-decider`);

  console.log("Smoke workspace ready:");
  console.log(`  workspaceId : ${workspaceId}`);
  console.log(`  plan        : ${plan}`);
  console.log(`  ANLYON_API_KEY=${key}`);
  console.log(`  SMOKE_API_KEY_ID=${apiKey.id}`);
  console.log(`  ANLYON_DECIDER_API_KEY=${deciderKey}`);

  await pool.end();
  process.exit(0);
}

main().catch((error) => {
  console.error("smoke-bootstrap failed:", error);
  process.exit(1);
});
