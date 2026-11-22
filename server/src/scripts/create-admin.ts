import { parseArgs } from "node:util";
import { auth } from "../utils/auth.ts";
import { createWorkspace } from "../core/workspace/service.ts";
import { insertInstanceAdmin } from "../core/instance/admins.ts";
import { claimInternal } from "../core/instance/internal.ts";
import { INTERNAL_KEYS } from "../core/instance/registry.ts";
import { isCloudEdition } from "../core/edition/edition.ts";
import { db } from "../db/index.ts";
import { pool } from "../db/index.ts";
import { redis, redisBlocking } from "../lib/redis.ts";

const MIN_PASSWORD = 12;
const MAX_PASSWORD = 100;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
      workspace: { type: "string" },
    },
  });
  const email = values.email?.trim().toLowerCase();
  const name = values.name?.trim();
  const password = process.env.ANLYON_ADMIN_PASSWORD ?? "";

  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email) || !name) {
    console.error('Usage: create-admin --email you@example.com --name "Your Name" [--workspace "Workspace name"]');
    console.error("with the password in ANLYON_ADMIN_PASSWORD.");
    return 2;
  }
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    console.error(`Set ANLYON_ADMIN_PASSWORD to a password of ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`);
    return 2;
  }

  const ctx = await auth.$context;
  if (await ctx.internalAdapter.findUserByEmail(email)) {
    console.error(`An account for ${email} already exists. Nothing was changed.`);
    return 1;
  }

  const user = await ctx.internalAdapter.createUser({ email, name, emailVerified: true }, { method: "admin" });
  if (!user) throw new Error("The account could not be created");
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: await ctx.password.hash(password),
  });

  const workspace = await createWorkspace(user.id, { name: values.workspace?.trim() || `${name}'s workspace` });
  if (!isCloudEdition()) {
    await insertInstanceAdmin(db, user.id, null);
    await claimInternal(INTERNAL_KEYS.setupCompletedAt, new Date().toISOString(), user.id);
  }

  console.log(`Created ${email}, owner of workspace "${workspace.name}" (${workspace.slug})${isCloudEdition() ? "" : " and an instance admin"}.`);
  console.log("Sign in to the console with this email and password.");
  const apiKey = workspace.credentials.apiKey;
  if (apiKey) {
    console.log(`\nAPI key (shown once; the console can make more): ${apiKey.key}`);
  }
  return 0;
}

async function close(): Promise<void> {
  await pool.end().catch(() => {});
  redis.disconnect();
  redisBlocking.disconnect();
}

main()
  .then(async (code) => {
    await close();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await close();
    process.exit(1);
  });
