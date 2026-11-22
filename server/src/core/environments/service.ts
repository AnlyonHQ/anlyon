import { and, eq, count, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { environments, type Environment } from "../../db/schema/environments.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { getPlanLimits, type EnvironmentKind } from "../plans/limits.ts";
import { resourcePlan } from "../billing/plan-management.ts";
import { QuotaExceededError, FeatureNotAvailableError } from "../billing/usage-enforcement.ts";
import { limitAdvice } from "../billing/limit-advice.ts";
import { ConflictError, NotFoundError, ValidationError } from "../../utils/errors.ts";
import { createLogger } from "../../lib/logger.ts";
import { matchRedirect, normalizeAllowedRedirects } from "../end-users/redirects.ts";

const logger = createLogger({ module: "environments" });

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

export type PublicEnvironment = {
  id: string;
  name: string;
  slug: string;
  kind: EnvironmentKind;
  isDefault: boolean;
  isProtected: boolean;
  halted: boolean;
  haltedAt: string | null;
  haltedReason: string | null;
  allowedRedirectUrls: string[];
  defaultRedirectUrl: string | null;
  connectConfirmation: "required" | "off";
  createdAt: string;
  updatedAt: string;
};

export function toPublicEnvironment(env: Environment): PublicEnvironment {
  return {
    id: env.id,
    name: env.name,
    slug: env.slug,
    kind: env.kind,
    isDefault: env.isDefault,
    isProtected: env.isProtected,
    halted: env.haltedAt !== null,
    haltedAt: env.haltedAt ? env.haltedAt.toISOString() : null,
    haltedReason: env.haltedReason,
    allowedRedirectUrls: env.allowedRedirectUrls ?? [],
    defaultRedirectUrl: env.defaultRedirectUrl ?? null,
    connectConfirmation: env.connectConfirmation === "off" ? "off" : "required",
    createdAt: env.createdAt.toISOString(),
    updatedAt: env.updatedAt.toISOString(),
  };
}

export async function ensureDefaultEnvironment(workspaceId: string): Promise<Environment> {
  return db.transaction(async tx => {
  const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
  if (!workspace) throw new NotFoundError("Workspace");
  const existing = await tx
    .select()
    .from(environments)
    .where(and(eq(environments.workspaceId, workspaceId), eq(environments.isDefault, true)))
    .limit(1);
  if (existing[0]) return existing[0];

  const [created] = await tx
    .insert(environments)
    .values({ workspaceId, name: "Production", kind: "production", slug: "production",
      isDefault: true, isProtected: true })
    .onConflictDoNothing()
    .returning();
  if (created) {
    logger.info({ workspaceId, environmentId: created.id }, "Created default environment");
    return created;
  }
  const [winner] = await tx
    .select()
    .from(environments)
    .where(and(eq(environments.workspaceId, workspaceId), eq(environments.slug, "production")))
    .limit(1);
  if (!winner) throw new ConflictError("Could not create default environment");
  const [repaired] = await tx.update(environments).set({ isDefault: true, updatedAt: new Date() })
    .where(eq(environments.id, winner.id)).returning();
  return repaired;
  });
}

export async function listEnvironments(workspaceId: string): Promise<Environment[]> {
  return db.select().from(environments).where(eq(environments.workspaceId, workspaceId));
}

export async function getEnvironment(workspaceId: string, environmentId: string): Promise<Environment> {
  const [env] = await db
    .select()
    .from(environments)
    .where(and(eq(environments.workspaceId, workspaceId), eq(environments.id, environmentId)))
    .limit(1);
  if (!env) throw new NotFoundError("Environment not found");
  return env;
}

export async function getDefaultEnvironment(workspaceId: string): Promise<Environment> {
  const [env] = await db
    .select()
    .from(environments)
    .where(and(eq(environments.workspaceId, workspaceId), eq(environments.isDefault, true)))
    .limit(1);
  if (env) return env;
  return ensureDefaultEnvironment(workspaceId);
}

export async function createEnvironment(
  workspaceId: string,
  input: { name: string; slug: string; kind?: EnvironmentKind; isProtected?: boolean },
): Promise<Environment> {
  if (!SLUG_PATTERN.test(input.slug)) {
    throw new ValidationError(
      "Environment slug must be 2-40 lowercase alphanumeric or hyphen characters, not starting or ending with a hyphen.",
    );
  }
  try {
    const created = await db.transaction(async tx => {
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    if (!workspace) throw new NotFoundError("Workspace");
    const limits = getPlanLimits(resourcePlan(workspace), workspace);
    const kind = input.kind ?? "development";
    if (input.isProtected && !limits.features.protectedProduction) {
      throw new FeatureNotAvailableError("Protected production needs a Starter, Pro or Team plan.", "production");
    }
    const [{ used }] = await tx.select({ used: count() }).from(environments)
      .where(eq(environments.workspaceId, workspaceId));
    const cap = limits.maxEnvironments;
    if (cap !== "unlimited" && used >= cap) {
      throw new QuotaExceededError(`Your plan allows ${cap} ${cap === 1 ? "environment" : "environments"}. ${limitAdvice("resource", "environments")}`);
    }
    const [created] = await tx
      .insert(environments)
      .values({
        workspaceId,
        name: input.name,
        slug: input.slug,
        kind,
        isDefault: false,
        isProtected: input.isProtected ?? false,
      })
      .returning();
    return created;
    });
    logger.info({ workspaceId, environmentId: created.id, slug: created.slug }, "Environment created");
    return created;
  } catch (error) {
    if (error instanceof Error && error.message.includes("environments_workspace_slug_unique")) {
      throw new ConflictError(
        `An environment with slug "${input.slug}" already exists in this workspace.`,
      );
    }
    throw error;
  }
}

export async function updateEnvironment(
  workspaceId: string,
  environmentId: string,
  input: {
    name?: string; kind?: EnvironmentKind; isDefault?: true; isProtected?: boolean; confirmProtected?: boolean;
    allowedRedirectUrls?: string[]; defaultRedirectUrl?: string | null; connectConfirmation?: "required" | "off";
  },
): Promise<Environment> {
  return db.transaction(async tx => {
  const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
  if (!workspace) throw new NotFoundError("Workspace");
  const [env] = await tx.select().from(environments)
    .where(and(eq(environments.workspaceId, workspaceId), eq(environments.id, environmentId))).for("update");
  if (!env) throw new NotFoundError("Environment");
  if (input.kind && input.kind !== env.kind) {
    if (env.isProtected && !input.confirmProtected) throw new ConflictError("Pass confirmProtected: true to reclassify a protected environment.");
  }
  if (input.isDefault) {
    await tx.update(environments).set({ isDefault: false, updatedAt: new Date() })
      .where(and(eq(environments.workspaceId, workspaceId), eq(environments.isDefault, true)));
  }

  if (input.isProtected) {
    if (!getPlanLimits(resourcePlan(workspace), workspace).features.protectedProduction) {
      throw new FeatureNotAvailableError("Protected production needs a Starter, Pro or Team plan.", "production");
    }
  }

  if (input.isProtected === false && env.isProtected) {
    if (!input.confirmProtected) throw new ConflictError("Pass confirmProtected: true to turn environment protection off.");
  }

  const patch: Partial<typeof environments.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.isDefault) patch.isDefault = true;
  if (input.isProtected !== undefined) patch.isProtected = input.isProtected;

  const allowed = input.allowedRedirectUrls !== undefined ? normalizeAllowedRedirects(input.allowedRedirectUrls) : env.allowedRedirectUrls ?? [];
  if (input.allowedRedirectUrls !== undefined) patch.allowedRedirectUrls = allowed;
  const nextDefault = input.defaultRedirectUrl !== undefined ? input.defaultRedirectUrl : env.defaultRedirectUrl;
  if (nextDefault !== null && nextDefault !== undefined && !matchRedirect(nextDefault, allowed)) {
    throw new ValidationError("defaultRedirectUrl must fall under one of allowedRedirectUrls.");
  }
  if (input.defaultRedirectUrl !== undefined) patch.defaultRedirectUrl = input.defaultRedirectUrl;
  const nextConfirmation = input.connectConfirmation ?? env.connectConfirmation;
  const nextKind = input.kind ?? env.kind;
  const nextProtected = input.isProtected ?? env.isProtected;
  if (nextConfirmation === "off" && (nextKind !== "development" || nextProtected)) {
    throw new ValidationError("connectConfirmation can be off only on an unprotected development environment. Turn it back on first.");
  }
  if (input.connectConfirmation !== undefined) patch.connectConfirmation = input.connectConfirmation;
  const [updated] = await tx
    .update(environments)
    .set(patch)
    .where(and(eq(environments.workspaceId, workspaceId), eq(environments.id, env.id)))
    .returning();
  logger.info(
    { workspaceId, environmentId, isProtected: updated.isProtected },
    "Environment updated",
  );
  return updated;
  });
}

export async function deleteEmptyEnvironment(workspaceId: string, environmentId: string, confirmSlug: string) {
  await db.transaction(async tx => {
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    const [env] = await tx.select().from(environments)
      .where(and(eq(environments.workspaceId, workspaceId), eq(environments.id, environmentId))).for("update");
    if (!env) throw new NotFoundError("Environment");
    if (confirmSlug !== env.slug) throw new ValidationError("Type the environment slug to confirm deletion.");
    if (env.isDefault) throw new ConflictError("Choose another default environment first.");
    if (env.isProtected) throw new ConflictError("Remove environment protection first.");
    if (!env.haltedAt) throw new ConflictError("Halt the environment before deleting it.");
    const references = await tx.execute<{ schema_name: string; table_name: string; column_name: string }>(sql`
      SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name
      FROM pg_constraint f JOIN pg_class c ON c.oid = f.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(f.conkey)
      WHERE f.contype = 'f' AND f.confrelid = 'public.environments'::regclass
    `);
    for (const ref of references.rows) {
      const result = await tx.execute(sql`SELECT 1 FROM ${sql.identifier(ref.schema_name)}.${sql.identifier(ref.table_name)}
        WHERE ${sql.identifier(ref.column_name)} = ${environmentId} LIMIT 1`);
      if (result.rows.length) throw new ConflictError(`Environment is not empty: remove its ${ref.table_name} resources first. Retained history must expire before deletion.`);
    }
    await tx.delete(environments).where(eq(environments.id, environmentId));
  });
}

export async function assertNotProtected(
  workspaceId: string,
  environmentId: string,
  action: string,
  confirmProtected?: boolean,
): Promise<void> {
  if (confirmProtected) return;
  const env = await getEnvironment(workspaceId, environmentId);
  if (!env.isProtected) return;
  throw new ConflictError(
    `Environment "${env.slug}" is protected, so ${action} is blocked. ` +
      `Pass confirmProtected: true to proceed, or turn protection off for this environment.`,
  );
}

export async function resolveEnvironmentForKey(
  workspaceId: string,
  environmentId?: string,
): Promise<string> {
  if (!environmentId) return (await getDefaultEnvironment(workspaceId)).id;
  return (await getEnvironment(workspaceId, environmentId)).id;
}
