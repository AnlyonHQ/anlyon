import type { Context, Next } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { workspaceMembers } from "../../db/schema/workspaces.ts";
import { user } from "../../db/schema/user.ts";
import { env } from "../../config/env.ts";
import { redis } from "../../lib/redis.ts";
import { getWorkspaceCached } from "../../lib/workspace-cache.ts";
import { ApiError } from "../../utils/errors.ts";
import { createLogger } from "../../lib/logger.ts";

const logger = createLogger({ module: "verified-sender" });

const CACHE_TTL = 300;

function enforcementEnabled(): boolean {
  if (env.REQUIRE_EMAIL_VERIFICATION === "true") return true;
  if (env.REQUIRE_EMAIL_VERIFICATION === "false") return false;
  return env.NODE_ENV === "production";
}

async function adminEmailVerified(workspaceId: string): Promise<boolean> {
  const cacheKey = `ws:admin-verified:${workspaceId}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) return cached === "1";
  } catch {
  }

  const [admin] = await db
    .select({ verified: user.emailVerified })
    .from(workspaceMembers)
    .innerJoin(user, eq(workspaceMembers.userId, user.id))
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.emergencyAccess, true),
      eq(user.emailVerified, true),
    ))
    .limit(1);
  const verified = admin?.verified === true;

  try {
    await redis.set(cacheKey, verified ? "1" : "0", "EX", verified ? CACHE_TTL : 30);
  } catch {
  }
  return verified;
}

export async function requireVerifiedSender(c: Context, next: Next): Promise<Response | void> {
  if (!enforcementEnabled()) return next();

  const workspaceId = c.get("workspaceId");
  if (!workspaceId) return next();

  const workspace = await getWorkspaceCached(workspaceId);
  if (workspace && workspace.plan !== "free") return next();

  if (!(await adminEmailVerified(workspaceId))) {
    logger.info({ workspaceId }, "Publish blocked: admin email unverified");
    throw new ApiError(
      403,
      "email_verification_required",
      "Verify the email address of a workspace admin with emergency access to send deliveries on the free plan.",
    );
  }
  return next();
}
