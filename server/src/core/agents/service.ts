import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { agents, agentVersions, type Agent, type AgentVersion } from "../../db/schema/agents.ts";
import { actionVersions } from "../../db/schema/actions.ts";
import { generateAgentId, generateAgentVersionId } from "../../utils/crypto.ts";
import { getEnvironment } from "../environments/service.ts";
import { ConflictError, NotFoundError, ValidationError } from "../../utils/errors.ts";
import { createLogger } from "../../lib/logger.ts";

const logger = createLogger({ module: "agents" });

export type PublicAgentVersion = {
  id: string;
  version: number;
  config: Record<string, unknown>;
  createdAt: string;
};

export type PublicAgent = {
  id: string;
  environmentId: string;
  name: string;
  description: string | null;
  currentVersion: number | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export function toPublicVersion(v: AgentVersion): PublicAgentVersion {
  return {
    id: v.agentVersionId,
    version: v.version,
    config: v.config ?? {},
    createdAt: v.createdAt.toISOString(),
  };
}

async function currentVersionNumber(agent: Agent): Promise<number | null> {
  if (!agent.currentVersionId) return null;
  const [v] = await db
    .select({ version: agentVersions.version })
    .from(agentVersions)
    .where(eq(agentVersions.id, agent.currentVersionId))
    .limit(1);
  return v?.version ?? null;
}

export function pinnedActionsOf(config: Record<string, unknown>): Record<string, string> {
  const actions = config.actions;
  if (!actions || typeof actions !== "object" || Array.isArray(actions)) return {};

  const pins: Record<string, string> = {};
  for (const [name, value] of Object.entries(actions as Record<string, unknown>)) {
    if (typeof value === "string" && value.startsWith("acv_")) pins[name] = value;
  }
  return pins;
}

export async function getPinnedActionVersionId(
  workspaceId: string,
  environmentId: string,
  agentPublicId: string,
  actionName: string,
): Promise<string | null> {
  const [row] = await db
    .select({ config: agentVersions.config })
    .from(agents)
    .innerJoin(agentVersions, eq(agentVersions.id, agents.currentVersionId))
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.environmentId, environmentId),
        eq(agents.agentId, agentPublicId)
      )
    )
    .limit(1);

  if (!row) return null;
  return pinnedActionsOf(row.config ?? {})[actionName] ?? null;
}

export async function toPublicAgent(agent: Agent): Promise<PublicAgent> {
  return {
    id: agent.agentId,
    environmentId: agent.environmentId,
    name: agent.name,
    description: agent.description,
    currentVersion: await currentVersionNumber(agent),
    archived: agent.archivedAt !== null,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

async function requireAgent(workspaceId: string, agentPublicId: string): Promise<Agent> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.agentId, agentPublicId)))
    .limit(1);
  if (!agent) throw new NotFoundError("Agent not found");
  return agent;
}

export async function promoteAgent(
  workspaceId: string,
  agentPublicId: string,
  targetEnvironmentId: string,
  createdBy?: string,
  options: { confirmProtected?: boolean } = {},
): Promise<{ agent: PublicAgent; version: PublicAgentVersion }> {
  const { requireFeature } = await import("../billing/feature-gates.ts");
  await requireFeature(workspaceId, "controlledPromotion");
  const source = await requireAgent(workspaceId, agentPublicId);
  const targetEnv = await getEnvironment(workspaceId, targetEnvironmentId);
  if (targetEnv.id === source.environmentId) {
    throw new ConflictError("Cannot promote an agent into its own environment.");
  }
  if (targetEnv.isProtected && !options.confirmProtected) {
    throw new ConflictError(
      `Environment "${targetEnv.slug}" is protected. Pass confirmProtected: true to promote into it.`,
    );
  }
  if (!source.currentVersionId) {
    throw new ConflictError("Agent has no published version to promote.");
  }
  const [sourceVersion] = await db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.id, source.currentVersionId))
    .limit(1);
  if (!sourceVersion) throw new NotFoundError("Source agent version not found");

  const [existing] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.environmentId, targetEnv.id), eq(agents.name, source.name)))
    .limit(1);

  if (!existing) {
    const created = await createAgent(
      workspaceId,
      {
        name: source.name,
        description: source.description ?? undefined,
        environmentId: targetEnv.id,
        config: sourceVersion.config,
      },
      createdBy,
    );
    logger.info(
      { agentId: source.agentId, from: source.environmentId, to: targetEnv.id, target: created.agent.id },
      "Agent promoted (new)",
    );
    return created;
  }

  const version = await createAgentVersion(
    workspaceId,
    existing.agentId,
    { config: sourceVersion.config, publish: true },
    createdBy,
  );
  logger.info(
    { agentId: source.agentId, from: source.environmentId, to: targetEnv.id, target: existing.agentId },
    "Agent promoted (new version)",
  );
  return { agent: await getAgent(workspaceId, existing.agentId), version };
}

export async function createAgent(
  workspaceId: string,
  input: { name: string; description?: string; environmentId: string; config?: Record<string, unknown> },
  createdBy?: string,
): Promise<{ agent: PublicAgent; version: PublicAgentVersion }> {
  const env = await getEnvironment(workspaceId, input.environmentId);

  const duplicate = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.environmentId, env.id), eq(agents.name, input.name)))
    .limit(1);
  if (duplicate[0]) {
    throw new ConflictError(`An agent named "${input.name}" already exists in this environment.`);
  }

  const { updated, version } = await db.transaction(async (tx) => {
    const [agent] = await tx
      .insert(agents)
      .values({
        workspaceId,
        environmentId: env.id,
        agentId: generateAgentId(),
        name: input.name,
        description: input.description ?? null,
      })
      .returning();

    const [version] = await tx
      .insert(agentVersions)
      .values({
        workspaceId,
        environmentId: env.id,
        agentId: agent.id,
        agentVersionId: generateAgentVersionId(),
        version: 1,
        config: input.config ?? {},
        createdBy: createdBy ?? null,
      })
      .returning();

    const [updated] = await tx
      .update(agents)
      .set({ currentVersionId: version.id, updatedAt: new Date() })
      .where(eq(agents.id, agent.id))
      .returning();

    return { updated, version };
  });

  logger.info({ workspaceId, agentId: updated.agentId, environmentId: env.id }, "Agent created");
  return { agent: await toPublicAgent(updated), version: toPublicVersion(version) };
}

export async function listAgents(workspaceId: string, environmentId?: string): Promise<PublicAgent[]> {
  const rows = await db
    .select()
    .from(agents)
    .where(
      environmentId
        ? and(eq(agents.workspaceId, workspaceId), eq(agents.environmentId, environmentId))
        : eq(agents.workspaceId, workspaceId),
    );
  return Promise.all(rows.map(toPublicAgent));
}

export async function getAgent(workspaceId: string, agentPublicId: string): Promise<PublicAgent> {
  return toPublicAgent(await requireAgent(workspaceId, agentPublicId));
}

function isUniqueViolation(error: unknown): boolean {
  const code = (e: unknown) =>
    typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
  return code(error) === "23505" || code((error as { cause?: unknown })?.cause) === "23505";
}

async function assertPinsResolve(
  environmentId: string,
  config: Record<string, unknown>,
): Promise<void> {
  const pins = pinnedActionsOf(config);
  const ids = [...new Set(Object.values(pins))];
  if (ids.length === 0) return;

  const rows = await db
    .select({ actionVersionId: actionVersions.actionVersionId })
    .from(actionVersions)
    .where(
      and(
        eq(actionVersions.environmentId, environmentId),
        inArray(actionVersions.actionVersionId, ids)
      )
    );

  const found = new Set(rows.map((r) => r.actionVersionId));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ValidationError(
      `config.actions pins action version${missing.length > 1 ? "s" : ""} that do not exist in this environment: ${missing.join(", ")}`
    );
  }
}

export async function createAgentVersion(
  workspaceId: string,
  agentPublicId: string,
  input: { config: Record<string, unknown>; publish?: boolean },
  createdBy?: string,
): Promise<PublicAgentVersion> {
  const agent = await requireAgent(workspaceId, agentPublicId);
  await assertPinsResolve(agent.environmentId, input.config);

  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const [{ max }] = await tx
          .select({ max: sql<number>`coalesce(max(${agentVersions.version}), 0)` })
          .from(agentVersions)
          .where(eq(agentVersions.agentId, agent.id));

        const [version] = await tx
          .insert(agentVersions)
          .values({
            workspaceId,
            environmentId: agent.environmentId,
            agentId: agent.id,
            agentVersionId: generateAgentVersionId(),
            version: Number(max) + 1,
            config: input.config,
            createdBy: createdBy ?? null,
          })
          .returning();

        if (input.publish) {
          await tx
            .update(agents)
            .set({ currentVersionId: version.id, updatedAt: new Date() })
            .where(eq(agents.id, agent.id));
        }

        logger.info(
          { agentId: agent.agentId, version: version.version, published: !!input.publish },
          "Agent version created",
        );
        return toPublicVersion(version);
      });
    } catch (error) {
      if (isUniqueViolation(error) && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
  }
}

export async function listAgentVersions(workspaceId: string, agentPublicId: string): Promise<PublicAgentVersion[]> {
  const agent = await requireAgent(workspaceId, agentPublicId);
  const rows = await db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agent.id))
    .orderBy(asc(agentVersions.version));
  return rows.map(toPublicVersion);
}

export async function getAgentVersion(
  workspaceId: string,
  agentPublicId: string,
  version: number,
): Promise<PublicAgentVersion> {
  const agent = await requireAgent(workspaceId, agentPublicId);
  const [row] = await db
    .select()
    .from(agentVersions)
    .where(and(eq(agentVersions.agentId, agent.id), eq(agentVersions.version, version)))
    .limit(1);
  if (!row) throw new NotFoundError("Agent version not found");
  return toPublicVersion(row);
}

export async function updateAgent(
  workspaceId: string,
  agentPublicId: string,
  input: { name?: string; description?: string; currentVersion?: number; archived?: boolean },
): Promise<PublicAgent> {
  const agent = await requireAgent(workspaceId, agentPublicId);
  const patch: Partial<typeof agents.$inferInsert> = { updatedAt: new Date() };

  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.archived !== undefined) patch.archivedAt = input.archived ? new Date() : null;
  if (input.currentVersion !== undefined) {
    const [target] = await db
      .select({ id: agentVersions.id })
      .from(agentVersions)
      .where(and(eq(agentVersions.agentId, agent.id), eq(agentVersions.version, input.currentVersion)))
      .limit(1);
    if (!target) throw new NotFoundError(`Agent has no version ${input.currentVersion}`);
    patch.currentVersionId = target.id;
  }

  const [updated] = await db.update(agents).set(patch).where(eq(agents.id, agent.id)).returning();
  return toPublicAgent(updated);
}
