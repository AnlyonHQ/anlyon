import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { env } from "../../config/env.ts";
import { db } from "../../db/index.ts";
import { user } from "../../db/schema/user.ts";
import { createLogger } from "../../lib/logger.ts";
import { AuthorizationError, ConflictError, NotFoundError } from "../../utils/errors.ts";
import type { StoredAuditContext } from "../audit/event-schema.ts";
import { writeAuditEvents } from "../audit/outbox.ts";
import { isCloudEdition } from "../edition/edition.ts";
import { insertInstanceAdmin } from "./admins.ts";
import { instanceAuditRecords } from "./audit.ts";
import { claimInternal, deleteInternal, readInternal, writeInternal } from "./internal.ts";
import { INTERNAL_KEYS } from "./registry.ts";

const logger = createLogger({ module: "instance-setup" });

export const MIN_OWNER_PASSWORD = 12;
export const MAX_OWNER_PASSWORD = 100;

const hash = (token: string) => createHash("sha256").update(token, "utf8").digest();

function sameToken(candidate: string, expectedHash: Buffer): boolean {
  return timingSafeEqual(hash(candidate), expectedHash);
}

export function generateSetupToken(): string {
  return randomBytes(32).toString("base64url");
}

export function setupUrl(token: string): string {
  return `${env.CONSOLE_URL.replace(/\/+$/, "")}/setup#token=${token}`;
}

async function hasAnyAccount(): Promise<boolean> {
  return (await db.select({ id: user.id }).from(user).limit(1)).length > 0;
}

export async function isSetupPending(): Promise<boolean> {
  if (isCloudEdition()) return false;
  if (await readInternal(INTERNAL_KEYS.setupCompletedAt)) return false;
  return !(await hasAnyAccount());
}

export async function prepareSetup(): Promise<void> {
  if (isCloudEdition()) return;
  if (await readInternal(INTERNAL_KEYS.setupCompletedAt)) return;
  if (await hasAnyAccount()) {
    await claimInternal(INTERNAL_KEYS.setupCompletedAt, new Date().toISOString());
    return;
  }
  if (env.ANLYON_SETUP_TOKEN) {
    await deleteInternal(INTERNAL_KEYS.setupTokenHash);
    logger.warn(
      { setupPage: `${env.CONSOLE_URL.replace(/\/+$/, "")}/setup` },
      "This install has no owner yet. Open the setup page with the setup URL the installer printed (the token is ANLYON_SETUP_TOKEN in your .env).",
    );
    return;
  }
  const token = generateSetupToken();
  await writeInternal(INTERNAL_KEYS.setupTokenHash, hash(token).toString("base64url"));
  logger.warn({ setupUrl: setupUrl(token) }, "This install has no owner yet. Open this setup URL to create one. A restart makes a new token.");
}

export async function verifySetupToken(token: string): Promise<boolean> {
  if (!token) return false;
  if (env.ANLYON_SETUP_TOKEN) return sameToken(token, hash(env.ANLYON_SETUP_TOKEN));
  const stored = await readInternal(INTERNAL_KEYS.setupTokenHash);
  if (!stored?.value) return false;
  return sameToken(token, Buffer.from(stored.value, "base64url"));
}

export interface OwnerInput {
  token: string;
  name: string;
  email: string;
  password: string;
  workspaceName?: string;
}

export async function completeSetup(input: OwnerInput, context?: StoredAuditContext): Promise<{ userId: string; workspaceId: string }> {
  if (!(await isSetupPending())) throw new NotFoundError("Setup");
  if (!(await verifySetupToken(input.token))) throw new AuthorizationError("The setup token is not valid. Use the setup URL the installer or the server log printed.");

  if (!(await claimInternal(INTERNAL_KEYS.setupCompletedAt, new Date().toISOString()))) throw new NotFoundError("Setup");

  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  let userId: string | null = null;
  try {
    const { auth } = await import("../../utils/auth.ts");
    const { createWorkspace } = await import("../workspace/service.ts");
    const ctx = await auth.$context;
    if (await ctx.internalAdapter.findUserByEmail(email)) throw new ConflictError("An account with this email already exists");
    const created = await ctx.internalAdapter.createUser({ email, name, emailVerified: true }, { method: "admin" });
    if (!created) throw new Error("The account could not be created");
    userId = created.id;
    await ctx.internalAdapter.linkAccount({
      userId: created.id,
      providerId: "credential",
      accountId: created.id,
      password: await ctx.password.hash(input.password),
    });
    const workspace = await createWorkspace(created.id, { name: input.workspaceName?.trim() || `${name}'s workspace` });
    const ownerId = created.id;
    await db.transaction(async (tx) => {
      await insertInstanceAdmin(tx, ownerId, null);
      await writeInternal(INTERNAL_KEYS.setupCompletedAt, new Date().toISOString(), ownerId, tx);
      await writeAuditEvents(tx, await instanceAuditRecords(tx, "instance.setup_completed", ownerId, { ownerId }, context));
    });
    await deleteInternal(INTERNAL_KEYS.setupTokenHash);
    logger.info({ userId: ownerId, workspaceId: workspace.id }, "Setup complete: the first owner exists and the setup endpoints are closed");
    return { userId: ownerId, workspaceId: workspace.id };
  } catch (error) {
    if (userId) {
      await db.delete(user).where(eq(user.id, userId)).catch(() => {});
    }
    await deleteInternal(INTERNAL_KEYS.setupCompletedAt).catch(() => {});
    throw error;
  }
}
