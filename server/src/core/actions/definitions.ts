import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { actions, actionVersions, type ActionAdapterConfig, type ActionDeclarations, type ActionMcpBinding } from "../../db/schema/actions.ts";
import { environments } from "../../db/schema/environments.ts";
import { createLogger } from "../../lib/logger.ts";
import { ActionNotFoundError, ActionVersionPinUnresolvedError, ValidationError } from "../../utils/errors.ts";
import { getPinnedActionVersionId } from "../agents/service.ts";

const logger = createLogger({ module: "actions" });

type ActionRow = typeof actions.$inferSelect;

export async function getDefaultEnvironmentId(workspaceId: string): Promise<string> {
  const [row] = await db.select({ id: environments.id }).from(environments)
    .where(and(eq(environments.workspaceId, workspaceId), eq(environments.isDefault, true)));
  if (!row) throw new ValidationError("Workspace environment not found");
  return row.id;
}

export async function resolveActionRow(
  workspaceId: string,
  ref: string,
  environmentId?: string,
): Promise<ActionRow> {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const [row] = await db
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.workspaceId, workspaceId),
        eq(actions.environmentId, scopedEnvironmentId),
        isNull(actions.archivedAt),
        or(eq(actions.name, ref), eq(actions.actionId, ref))
      )
    );

  if (!row) throw new ActionNotFoundError(`Action not found: ${ref}`);
  return row;
}

export type ActionRowLike = {
  id: string;
  workspaceId: string;
  environmentId: string;
  method: string;
  urlTemplate: string;
  headers: unknown;
  bodyTemplate: unknown;
  inputSchema: unknown;
  requiresApproval: boolean;
  adapter?: ActionAdapterConfig | null;
  declarations?: ActionDeclarations | null;
  mcp?: ActionMcpBinding | null;
};

export function definitionOf(row: ActionRowLike) {
  return {
    method: row.method,
    urlTemplate: row.urlTemplate,
    headers: (row.headers as Record<string, unknown>) ?? {},
    bodyTemplate: (row.bodyTemplate as Record<string, unknown> | null) ?? null,
    inputSchema: (row.inputSchema as Record<string, unknown>) ?? {},
    requiresApproval: row.requiresApproval,
    adapter: row.adapter ?? null,
    declarations: row.declarations ?? null,
    mcp: row.mcp ?? null,
  };
}

export async function resolvePinnedDefinition(
  action: ActionRow,
  agentPublicId: string | null,
): Promise<{ definition: ReturnType<typeof definitionOf>; actionVersionId: string | null }> {
  const live = { definition: definitionOf(action), actionVersionId: action.currentVersionId };
  if (!agentPublicId) return live;

  const pinnedId = await getPinnedActionVersionId(
    action.workspaceId,
    action.environmentId,
    agentPublicId,
    action.name,
  );
  if (!pinnedId || pinnedId === action.currentVersionId) return live;

  const [version] = await db
    .select()
    .from(actionVersions)
    .where(
      and(
        eq(actionVersions.actionId, action.id),
        eq(actionVersions.actionVersionId, pinnedId)
      )
    )
    .limit(1);

  if (!version) {
    logger.error(
      { workspaceId: action.workspaceId, actionName: action.name, agentPublicId, pinnedId },
      "Agent version pins an action version that does not exist; refusing to run a different definition"
    );
    throw new ActionVersionPinUnresolvedError(
      `Agent "${agentPublicId}" pins version ${pinnedId} of action "${action.name}", which no longer exists. ` +
        "Publish a new agent version that pins a current action version, or restore the pinned version. " +
        "Anlyon will not substitute the action's current definition for a pinned one."
    );
  }

  return { definition: definitionOf(version), actionVersionId: version.actionVersionId };
}
