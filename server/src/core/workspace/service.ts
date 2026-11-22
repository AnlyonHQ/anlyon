import { db } from "../../db/index.ts";
import { workspaces, workspaceMembers } from "../../db/schema/workspaces.ts";
import { eq, and } from "drizzle-orm";
import { generateUniqueSlug, generateSlug } from "../../utils/slug.ts";
import { NotFoundError, AuthorizationError, ConflictError } from "../../utils/errors.ts";
import { createLogger } from "../../lib/logger.ts";
import type { CreateWorkspaceInput, UpdateWorkspaceInput } from "../../types/workspace.ts";
import { nanoid } from "nanoid";
import { ensureDefaultEnvironment } from "../environments/service.ts";
import { initializeNotificationPreferences } from "../notifications/notification-service.ts";
import { capture } from "../../lib/product-events.ts";
import { user } from "../../db/schema/user.ts";
import { createApiKey } from "../auth/api-keys.ts";
import { withLock } from "../../lib/distributed-lock.ts";
import { createDeliverySecret } from "../auth/delivery-secrets.ts";
import { hasPermission } from "./permissions.ts";

const logger = createLogger({ module: "workspace-service" });

const MAX_WORKSPACES_PER_USER = 1;

async function isSlugTaken(slug: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);
  return !!existing;
}

async function validateWorkspaceCreation(userId: string): Promise<void> {
  const userWorkspaces = await db
    .select({
      workspace: workspaces,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId));

  if (userWorkspaces.length >= MAX_WORKSPACES_PER_USER) {
    throw new ConflictError(
      `Maximum workspace limit reached. You can have up to ${MAX_WORKSPACES_PER_USER} workspaces. Please delete an existing workspace to create a new one.`
    );
  }

  logger.debug({ userId, existingWorkspaces: userWorkspaces.length }, "Workspace creation validation passed");
}

async function generateAvailableSlug(baseName: string, providedSlug?: string): Promise<string> {
  if (providedSlug) {
    const isTaken = await isSlugTaken(providedSlug);
    if (!isTaken) {
      return providedSlug;
    }
    for (let i = 0; i < 5; i++) {
      const suffixedSlug = `${providedSlug}-${nanoid(4)}`;
      const suffixTaken = await isSlugTaken(suffixedSlug);
      if (!suffixTaken) {
        logger.info({ providedSlug, generatedSlug: suffixedSlug }, "Slug was taken, generated unique alternative");
        return suffixedSlug;
      }
    }
    throw new ConflictError(`The slug "${providedSlug}" is already taken. Please choose a different slug.`);
  }

  const baseSlug = generateSlug(baseName);

  const baseTaken = await isSlugTaken(baseSlug);
  if (!baseTaken) {
    return baseSlug;
  }

  for (let i = 0; i < 5; i++) {
    const uniqueSlug = `${baseSlug}-${nanoid(4)}`;
    const isTaken = await isSlugTaken(uniqueSlug);
    if (!isTaken) {
      return uniqueSlug;
    }
  }

  return `${baseSlug}-${nanoid(8)}`;
}

export async function createWorkspace(
  userId: string,
  input: CreateWorkspaceInput
) {
  const created = await withLock(`workspace-create:${userId}`, () => createWorkspaceUnlocked(userId, input), {
    ttlMs: 30_000,
    waitMs: 10_000,
  });
  if (created === null) {
    throw new ConflictError("A workspace is already being created for this account. Try again in a moment.");
  }
  return created;
}

export async function ensureFirstWorkspace(userId: string, name: string): Promise<boolean> {
  if ((await getUserWorkspaces(userId)).length > 0) return false;
  const created = await withLock(
    `workspace-create:${userId}`,
    async () => {
      if ((await getUserWorkspaces(userId)).length > 0) return false;
      await createWorkspaceUnlocked(userId, { name });
      return true;
    },
    { ttlMs: 30_000, waitMs: 10_000 },
  );
  if (created === null) {
    throw new ConflictError("A workspace is already being created for this account. Try again in a moment.");
  }
  return created;
}

async function createWorkspaceUnlocked(
  userId: string,
  input: CreateWorkspaceInput
) {
  const { name, slug: providedSlug } = input;

  await validateWorkspaceCreation(userId);

  const slug = await generateAvailableSlug(name, providedSlug);

  const plan = "free";
  const subscriptionStatus = "active";
  logger.info({ userId, name, slug, providedSlug, plan }, "Creating workspace");

  const trialEndsAt = null;

  try {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        name,
        slug,
        plan,
        trialEndsAt,
        subscriptionStatus,
        monthlyMessageQuota: "10000",
      })
      .returning();

    await db.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId,
      role: "admin",
      emergencyAccess: true,
    });

    await ensureDefaultEnvironment(workspace.id);

    try {
      const [owner] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
      await initializeNotificationPreferences(workspace.id, owner?.email ? [owner.email] : []);
    } catch (error) {
      logger.warn({ workspaceId: workspace.id, error }, "Failed to seed notification preferences");
    }

    logger.info({ workspaceId: workspace.id, userId, slug }, "Workspace created");
    capture("workspace_created", workspace.id, { plan, userId }, { workspaceId: workspace.id });

    let apiKeyResult = null;
    let signingSecretResult = null;

    try {
      apiKeyResult = await createApiKey(workspace.id, userId, "Default API Key");
      logger.info({ workspaceId: workspace.id }, "Auto-generated API key for new workspace");
    } catch (error) {
      logger.error({ workspaceId: workspace.id, error }, "Failed to auto-generate API key");
    }

    try {
      signingSecretResult = await createDeliverySecret(workspace.id, userId);
      logger.info({ workspaceId: workspace.id }, "Auto-generated signing secret for new workspace");
    } catch (error) {
      logger.error({ workspaceId: workspace.id, error }, "Failed to auto-generate signing secret");
    }

    return {
      ...workspace,
      credentials: {
        apiKey: apiKeyResult ? {
          id: apiKeyResult.apiKey.id,
          name: apiKeyResult.apiKey.name,
          key: apiKeyResult.key,
          keyPrefix: apiKeyResult.apiKey.keyPrefix,
        } : null,
        signingSecret: signingSecretResult ? {
          id: signingSecretResult.secret.id,
          secretKey: signingSecretResult.secretKey,
          secretPrefix: signingSecretResult.secret.secretPrefix,
          version: signingSecretResult.secret.version,
        } : null,
      },
    };
  } catch (error: any) {
    if (error?.code === "23505" && error?.constraint === "workspaces_slug_unique") {
      logger.warn({ slug, error: error.message }, "Slug collision during insert, retrying");
      const retrySlug = `${generateSlug(name)}-${nanoid(6)}`;
      const [workspace] = await db
        .insert(workspaces)
        .values({
          name,
          slug: retrySlug,
          plan,
          trialEndsAt,
          subscriptionStatus,
          monthlyMessageQuota: "10000",
        })
        .returning();

      await db.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId,
        role: "admin",
        emergencyAccess: true,
      });

      await ensureDefaultEnvironment(workspace.id);

      logger.info({ workspaceId: workspace.id, userId, slug: retrySlug }, "Workspace created after retry");

      let apiKeyResult = null;
      let signingSecretResult = null;

      try {
        apiKeyResult = await createApiKey(workspace.id, userId, "Default API Key");
        logger.info({ workspaceId: workspace.id }, "Auto-generated API key for new workspace (retry)");
      } catch (err) {
        logger.error({ workspaceId: workspace.id, error: err }, "Failed to auto-generate API key (retry)");
      }

      try {
        signingSecretResult = await createDeliverySecret(workspace.id, userId);
        logger.info({ workspaceId: workspace.id }, "Auto-generated signing secret for new workspace (retry)");
      } catch (err) {
        logger.error({ workspaceId: workspace.id, error: err }, "Failed to auto-generate signing secret (retry)");
      }

      return {
        ...workspace,
        credentials: {
          apiKey: apiKeyResult ? {
            id: apiKeyResult.apiKey.id,
            name: apiKeyResult.apiKey.name,
            key: apiKeyResult.key,
            keyPrefix: apiKeyResult.apiKey.keyPrefix,
          } : null,
          signingSecret: signingSecretResult ? {
            id: signingSecretResult.secret.id,
            secretKey: signingSecretResult.secretKey,
            secretPrefix: signingSecretResult.secret.secretPrefix,
            version: signingSecretResult.secret.version,
          } : null,
        },
      };
    }
    throw error;
  }
}

export async function getWorkspace(workspaceId: string, userId: string) {
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));

  if (!workspace) {
    throw new NotFoundError("Workspace");
  }

  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    );

  if (!member) {
    throw new AuthorizationError("You are not a member of this workspace");
  }

  return { workspace, role: member.role };
}

export async function getUserWorkspaces(userId: string) {
  const memberships = await db
    .select({
      workspace: workspaces,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId));

  return memberships;
}

export async function updateWorkspace(
  workspaceId: string,
  userId: string,
  input: UpdateWorkspaceInput
) {
  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    );

  if (!member || !hasPermission(member.role, "workspace.update")) {
    throw new AuthorizationError("You don't have permission to update this workspace");
  }

  const [updated] = await db
    .update(workspaces)
    .set({
      ...input,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId))
    .returning();

  logger.info({ workspaceId, userId }, "Workspace updated");

  return updated;
}

export async function deleteWorkspace(workspaceId: string, userId: string) {
  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    );

  if (!member || !hasPermission(member.role, "workspace.delete")) {
    throw new AuthorizationError("Only workspace admins can delete workspaces");
  }

  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));

  logger.info({ workspaceId, userId }, "Workspace deleted");
}

export async function getWorkspaceMembers(workspaceId: string, userId: string) {
  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    );

  if (!member) {
    throw new AuthorizationError("You are not a member of this workspace");
  }

  const members = await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));

  return members;
}

export async function hasWorkspaceAccess(
  workspaceId: string,
  userId: string
): Promise<boolean> {
  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    );

  return !!member;
}
