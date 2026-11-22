import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, max, or } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { actions } from "../../db/schema/actions.ts";
import {
  functions,
  functionVersions,
  type FunctionBudgets,
  type FunctionLanguage,
  type StraightThroughPolicy,
} from "../../db/schema/functions.ts";
import { generateFunctionId, generateFunctionVersionId } from "../../utils/crypto.ts";
import { ApiError, ConflictError, ValidationError } from "../../utils/errors.ts";
import { checkSchemaDefinition } from "../../utils/json-schema.ts";
import { analyzeSource } from "./analysis.ts";
import { resolveBudgets } from "./budgets.ts";
import { FunctionNotFoundError } from "./errors.ts";
import { reviewVersion, type FunctionVersionReview } from "./review.ts";

export interface Scope {
  workspaceId: string;
  environmentId: string;
}

export type FunctionRow = typeof functions.$inferSelect;
export type FunctionVersionRow = typeof functionVersions.$inferSelect;

export const MAIN_MODULE: Record<FunctionLanguage, string> = { javascript: "function.js", python: "function.py" };
export const MAX_SOURCE_BYTES = 256 * 1024;
export const MAX_ALLOWED_ACTIONS = 100;

export interface FunctionVersionView {
  id: string;
  version: number;
  language: FunctionLanguage;
  digest: string;
  allowedActions: string[];
  inputSchema: Record<string, unknown>;
  budgets: FunctionBudgets;
  straightThrough: StraightThroughPolicy | null;
  review: FunctionVersionReview | null;
  createdAt: Date;
}

export interface FunctionView {
  id: string;
  name: string;
  description: string | null;
  environmentId: string;
  currentVersion: FunctionVersionView | null;
  createdAt: Date;
  updatedAt: Date;
}

export function budgetsOf(row: FunctionVersionRow): FunctionBudgets {
  return { maxActionCalls: row.maxActionCalls, maxCpuMs: row.maxCpuMs, maxSubrequests: row.maxSubrequests, timeoutMs: row.timeoutMs };
}

export function toVersionView(row: FunctionVersionRow): FunctionVersionView {
  return {
    id: row.versionId,
    version: row.version,
    language: row.language,
    digest: row.digest,
    allowedActions: row.allowedActions,
    inputSchema: row.inputSchema ?? {},
    budgets: budgetsOf(row),
    straightThrough: row.straightThrough ?? null,
    review: (row.review as FunctionVersionReview | null) ?? null,
    createdAt: row.createdAt,
  };
}

function toView(row: FunctionRow, current: FunctionVersionRow | null): FunctionView {
  return {
    id: row.functionId,
    name: row.name,
    description: row.description,
    environmentId: row.environmentId,
    currentVersion: current ? toVersionView(current) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function sourceDigest(source: string): string {
  return `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const e = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  return (e?.code === "23505" && e.constraint === constraint) || (e?.cause?.code === "23505" && e.cause.constraint === constraint);
}

export async function resolveFunction(scope: Scope, ref: string): Promise<FunctionRow> {
  const [row] = await db
    .select()
    .from(functions)
    .where(and(
      eq(functions.workspaceId, scope.workspaceId),
      eq(functions.environmentId, scope.environmentId),
      isNull(functions.archivedAt),
      or(eq(functions.name, ref), eq(functions.functionId, ref)),
    ))
    .limit(1);
  if (!row) throw new FunctionNotFoundError(ref);
  return row;
}

export async function archiveFunction(scope: Scope, ref: string): Promise<FunctionView> {
  const row = await resolveFunction(scope, ref);
  const now = new Date();
  const [archived] = await db
    .update(functions)
    .set({ archivedAt: now, updatedAt: now })
    .where(and(eq(functions.id, row.id), isNull(functions.archivedAt)))
    .returning();
  if (!archived) throw new FunctionNotFoundError(ref);
  return toView(archived, null);
}

export async function versionByPublicId(scope: Scope, versionId: string): Promise<FunctionVersionRow | null> {
  const [row] = await db
    .select()
    .from(functionVersions)
    .where(and(
      eq(functionVersions.workspaceId, scope.workspaceId),
      eq(functionVersions.environmentId, scope.environmentId),
      eq(functionVersions.versionId, versionId),
    ))
    .limit(1);
  return row ?? null;
}

export async function createFunction(scope: Scope, input: { name: string; description?: string }): Promise<FunctionView> {
  try {
    const [row] = await db
      .insert(functions)
      .values({
        workspaceId: scope.workspaceId,
        environmentId: scope.environmentId,
        functionId: generateFunctionId(),
        name: input.name,
        description: input.description ?? null,
      })
      .returning();
    return toView(row!, null);
  } catch (error) {
    if (isUniqueViolation(error, "functions_env_name_unique")) {
      throw new ConflictError(`A function named "${input.name}" already exists in this environment.`);
    }
    throw error;
  }
}

export async function listFunctions(scope: Scope): Promise<FunctionView[]> {
  const rows = await db
    .select()
    .from(functions)
    .where(and(
      eq(functions.workspaceId, scope.workspaceId),
      eq(functions.environmentId, scope.environmentId),
      isNull(functions.archivedAt),
    ))
    .orderBy(asc(functions.name));
  const currentIds = rows.map((row) => row.currentVersionId).filter((id): id is string => id !== null);
  const versions = currentIds.length === 0
    ? []
    : await db.select().from(functionVersions).where(inArray(functionVersions.versionId, currentIds));
  const byId = new Map(versions.map((version) => [version.versionId, version]));
  return rows.map((row) => toView(row, row.currentVersionId ? byId.get(row.currentVersionId) ?? null : null));
}

export interface PublishInput {
  language: FunctionLanguage;
  source: string;
  allowedActions?: string[];
  inputSchema?: Record<string, unknown>;
  budgets?: Partial<FunctionBudgets>;
  straightThrough?: StraightThroughPolicy | null;
}

async function assertAllowedActionsUsable(scope: Scope, names: string[]): Promise<void> {
  if (names.length === 0) return;
  const rows = await db
    .select({ name: actions.name, enabled: actions.enabled })
    .from(actions)
    .where(and(
      eq(actions.workspaceId, scope.workspaceId),
      eq(actions.environmentId, scope.environmentId),
      isNull(actions.archivedAt),
      inArray(actions.name, names),
    ));
  const found = new Map(rows.map((row) => [row.name, row.enabled]));
  const missing = names.filter((name) => !found.has(name));
  const disabled = names.filter((name) => found.get(name) === false);
  if (missing.length || disabled.length) {
    const parts = [
      ...(missing.length ? [`not found in this environment: ${missing.join(", ")}`] : []),
      ...(disabled.length ? [`disabled: ${disabled.join(", ")}`] : []),
    ];
    throw new ApiError(400, "ALLOWED_ACTION_UNAVAILABLE", `Every allowed action must exist and be enabled. ${parts.join("; ")}.`, {
      missing,
      disabled,
    });
  }
}

export async function publishVersion(
  scope: Scope,
  ref: string,
  input: PublishInput,
  publisher: { keyId: string | null; userId: string | null },
  opts: { review?: "background" | "off" } = {},
): Promise<{ function: FunctionView; version: FunctionVersionView }> {
  const fn = await resolveFunction(scope, ref);
  if (Buffer.byteLength(input.source, "utf8") > MAX_SOURCE_BYTES) {
    throw new ValidationError(`The source is larger than ${MAX_SOURCE_BYTES} bytes.`);
  }
  const ast = await analyzeSource(input.language, input.source);
  if (input.allowedActions === undefined) {
    if (!ast.parsed) {
      throw new ApiError(400, "ALLOWED_ACTIONS_REQUIRED", `The source could not be read (${ast.parseError}), so no allow-list can be proposed. List allowedActions by hand.`);
    }
    if (ast.computedActionNames.length > 0) {
      const lines = ast.computedActionNames.map((call) => call.line).join(", ");
      throw new ApiError(400, "ALLOWED_ACTIONS_REQUIRED", `The source computes an action name (line ${lines}), so the actions it calls cannot be read from it. List allowedActions by hand.`, {
        computedActionNames: ast.computedActionNames,
      });
    }
  }
  const allowedActions = [...new Set(input.allowedActions ?? ast.proposedAllowedActions)];
  if (allowedActions.length > MAX_ALLOWED_ACTIONS) {
    throw new ValidationError(`A function may list at most ${MAX_ALLOWED_ACTIONS} allowed actions.`);
  }
  const inputSchema = input.inputSchema ?? {};
  if (Object.keys(inputSchema).length > 0) {
    const problems = checkSchemaDefinition(inputSchema, "inputSchema");
    if (problems.length) throw new ValidationError(`Invalid inputSchema: ${problems.join("; ")}`);
  }
  await assertAllowedActionsUsable(scope, allowedActions);
  const budgets = resolveBudgets(input.budgets);
  let straightThrough: StraightThroughPolicy | null = null;
  if (input.straightThrough) {
    const actions = [...new Set(input.straightThrough.actions)];
    const unlisted = actions.filter((name) => !allowedActions.includes(name));
    if (unlisted.length) {
      throw new ValidationError(`Every straightThrough action must be in allowedActions. Not there: ${unlisted.join(", ")}.`);
    }
    straightThrough = { actions, maxWrites: input.straightThrough.maxWrites };
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const published = await db.transaction(async (tx) => {
        const [{ latest }] = await tx
          .select({ latest: max(functionVersions.version) })
          .from(functionVersions)
          .where(eq(functionVersions.functionRowId, fn.id));
        const [version] = await tx
          .insert(functionVersions)
          .values({
            workspaceId: scope.workspaceId,
            environmentId: scope.environmentId,
            functionRowId: fn.id,
            versionId: generateFunctionVersionId(),
            version: (latest ?? 0) + 1,
            language: input.language,
            sourceModules: { [MAIN_MODULE[input.language]]: input.source },
            digest: sourceDigest(input.source),
            allowedActions,
            inputSchema,
            ...budgets,
            straightThrough,
            review: { ast, ai: null } satisfies FunctionVersionReview,
            publishedByKeyId: publisher.keyId,
            publishedByUserId: publisher.userId,
          })
          .returning();
        const [updated] = await tx
          .update(functions)
          .set({ currentVersionId: version!.versionId, updatedAt: new Date() })
          .where(eq(functions.id, fn.id))
          .returning();
        return { function: toView(updated!, version!), version: toVersionView(version!), rowId: version!.id };
      });
      if (opts.review !== "off") void reviewVersion(published.rowId);
      return { function: published.function, version: published.version };
    } catch (error) {
      if (attempt < 3 && isUniqueViolation(error, "function_versions_function_version_unique")) continue;
      throw error;
    }
  }
}

export interface FunctionVersionListItem extends FunctionVersionView {
  current: boolean;
}

export interface FunctionVersionDetail extends FunctionVersionListItem {
  source: string;
}

export const MAX_LISTED_VERSIONS = 100;

export async function listVersions(scope: Scope, ref: string): Promise<FunctionVersionListItem[]> {
  const fn = await resolveFunction(scope, ref);
  const rows = await db
    .select()
    .from(functionVersions)
    .where(eq(functionVersions.functionRowId, fn.id))
    .orderBy(desc(functionVersions.version))
    .limit(MAX_LISTED_VERSIONS);
  return rows.map((row) => ({ ...toVersionView(row), current: row.versionId === fn.currentVersionId }));
}

export async function getVersion(scope: Scope, ref: string, version: number | "current"): Promise<FunctionVersionDetail> {
  const fn = await resolveFunction(scope, ref);
  const [row] = await db
    .select()
    .from(functionVersions)
    .where(and(
      eq(functionVersions.functionRowId, fn.id),
      version === "current"
        ? eq(functionVersions.versionId, fn.currentVersionId ?? "")
        : eq(functionVersions.version, version),
    ))
    .limit(1);
  if (!row) {
    throw new ApiError(404, "FUNCTION_VERSION_NOT_FOUND", version === "current"
      ? `Function "${fn.name}" has no published version yet.`
      : `Function "${fn.name}" has no version ${version}.`);
  }
  return { ...toVersionView(row), current: row.versionId === fn.currentVersionId, source: sourceOf(row) };
}

export function sourceOf(version: FunctionVersionRow): string {
  return version.sourceModules[MAIN_MODULE[version.language]] ?? "";
}
