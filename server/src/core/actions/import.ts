import { limitAdvice } from "../billing/limit-advice.ts";
import { db } from "../../db/index.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { eq } from "drizzle-orm";
import { createLogger } from "../../lib/logger.ts";
import { ValidationError, QuotaExceededError } from "../../utils/errors.ts";
import { getPlanLimits, type PlanType } from "../plans/limits.ts";
import { getSecretMetadata } from "./secrets.ts";
import { parseImpactDeclaration, type ImpactDeclarationInput } from "../effects/declarations.ts";
import { suggestAllowedHosts, type ImportSuggestion } from "./import-suggestions.ts";
import {
  buildOperation,
  isObject,
  METHODS,
  UnsupportedOperation,
  type BuiltOperation,
  type ImportAuthOption,
  type Json,
  type OperationChoice,
  type ProposedVerify,
} from "./import-translate.ts";

import {
  countActions,
  createAction,
  UNSCOPED_AUTHORITY,
  type ActionMethod,
  type ActionView,
  type CallerAuthority,
} from "./service.ts";

export type { ImportAuthOption, OperationChoice, ProposedVerify } from "./import-translate.ts";

const logger = createLogger({ module: "actions-import" });

const MAX_OPERATIONS = 200;

export interface ImportOptions {
  baseUrl?: string;
  auth?: ImportAuthOption;
  requiresApproval?: boolean;
  dryRun?: boolean;
  only?: string[];
  governed?: boolean;
  environmentId?: string;
  operations?: Record<string, OperationChoice>;
  authority?: CallerAuthority;
}

export interface SkippedOperation {
  path: string;
  method: string;
  reason: string;
}

export interface ImportedAction {
  name: string;
  method: ActionMethod;
  path: string;
  urlTemplate: string;
  warnings: string[];
  governed: boolean;
  impact: ImpactDeclarationInput | null;
  requiresApproval: boolean;
  customized: boolean;
  suggestion: ImportSuggestion;
  proposedVerify: ProposedVerify | null;
  verifyNote: string | null;
  action?: ActionView;
}

export interface ImportResult {
  created: ImportedAction[];
  skipped: SkippedOperation[];
  dryRun: boolean;
  suggestedAllowedHosts: string[];
}

async function remainingActionSlots(workspaceId: string): Promise<number | "unlimited"> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) return 0;

  const limits = getPlanLimits(workspace.plan as PlanType, workspace);
  if (limits.maxActions === "unlimited") return "unlimited";

  return Math.max(limits.maxActions - (await countActions(workspaceId)), 0);
}

export async function importActionsFromOpenApi(
  workspaceId: string,
  spec: Json,
  options: ImportOptions = {}
): Promise<ImportResult> {
  const authority = options.authority ?? UNSCOPED_AUTHORITY;
  if (typeof spec.openapi !== "string" || !spec.openapi.startsWith("3.")) {
    throw new ValidationError(
      "Only OpenAPI 3.x is supported (the spec must have an \"openapi\": \"3.x.x\" field)"
    );
  }

  const servers = Array.isArray(spec.servers) ? spec.servers : [];
  const specBaseUrl = isObject(servers[0]) && typeof servers[0].url === "string" ? servers[0].url : null;
  const baseUrl = options.baseUrl ?? specBaseUrl;

  if (!baseUrl) {
    throw new ValidationError(
      "The spec has no servers[0].url  pass baseUrl to say where these calls should go"
    );
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new ValidationError(`baseUrl must be an absolute http(s) URL (got "${baseUrl}")`);
  }

  if (options.auth) {
    if (options.environmentId) {
      await getSecretMetadata(workspaceId, options.auth.secretName, options.environmentId);
    } else {
      await getSecretMetadata(workspaceId, options.auth.secretName);
    }
  }

  const paths = isObject(spec.paths) ? spec.paths : {};
  const only = options.only ? new Set(options.only) : null;
  const choices = checkOperationChoices(paths, options);

  const created: ImportedAction[] = [];
  const skipped: SkippedOperation[] = [];
  let planned = 0;

  const slots = await remainingActionSlots(workspaceId);

  for (const [path, pathItemRaw] of Object.entries(paths)) {
    if (!isObject(pathItemRaw)) continue;
    const pathItem = pathItemRaw;
    const pathLevelParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const method of METHODS) {
      const operation = pathItem[method.toLowerCase()];
      if (!isObject(operation)) continue;

      if (planned + skipped.length >= MAX_OPERATIONS) {
        skipped.push({ path, method, reason: `import is capped at ${MAX_OPERATIONS} operations` });
        continue;
      }

      if (only && !only.has(String(operation.operationId)) && !only.has(`${method} ${path}`)) {
        continue;
      }

      const choiceKey = [operationKey(operation), `${method} ${path}`].find((key) => key !== null && choices.has(key));
      const choice = choiceKey ? choices.get(choiceKey) : undefined;

      let built: BuiltOperation;
      try {
        built = buildOperation(spec, baseUrl, path, method, operation, pathLevelParams, options, choice);
      } catch (error) {
        if (error instanceof UnsupportedOperation) {
          skipped.push({ path, method, reason: error.message });
          continue;
        }
        throw error;
      }

      if (slots !== "unlimited" && planned >= slots) {
        skipped.push({
          path,
          method,
          reason: `plan limit reached  this workspace can hold ${slots} more action(s). ${limitAdvice("resource", "actions")}`,
        });
        continue;
      }

      planned += 1;

      const governance = {
        governed: built.governed,
        impact: built.impact,
        requiresApproval: built.input.requiresApproval ?? false,
        customized: choice !== undefined,
        suggestion: built.suggestion,
        proposedVerify: built.proposedVerify,
        verifyNote: built.verifyNote,
      };

      if (options.dryRun) {
        created.push({
          name: built.input.name,
          method,
          path,
          urlTemplate: built.input.urlTemplate,
          warnings: built.warnings,
          ...governance,
        });
        continue;
      }

      try {
        const action = await createAction(workspaceId, built.input, authority, options.environmentId);
        created.push({
          name: action.name,
          method,
          path,
          urlTemplate: action.urlTemplate,
          warnings: built.warnings,
          ...governance,
          action,
        });
      } catch (error) {
        if (error instanceof QuotaExceededError) throw error;

        planned -= 1;
        skipped.push({
          path,
          method,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  logger.info(
    { workspaceId, created: created.length, skipped: skipped.length, dryRun: !!options.dryRun },
    "OpenAPI import finished"
  );

  return {
    created,
    skipped,
    dryRun: !!options.dryRun,
    suggestedAllowedHosts: suggestAllowedHosts(baseUrl, servers),
  };
}

function operationKey(operation: Json): string | null {
  return typeof operation.operationId === "string" && operation.operationId ? operation.operationId : null;
}

function checkOperationChoices(paths: Json, options: ImportOptions): Map<string, OperationChoice> {
  const choices = new Map<string, OperationChoice>(Object.entries(options.operations ?? {}));
  if (choices.size === 0) return choices;

  const named = new Set<string>();
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) continue;
    for (const method of METHODS) {
      const operation = pathItem[method.toLowerCase()];
      if (!isObject(operation)) continue;
      const id = `${method} ${path}`;
      const keys = [operationKey(operation), id].filter((key): key is string => key !== null && choices.has(key));
      if (keys.length > 1) {
        throw new ValidationError(`operations names ${id} twice (as "${keys[0]}" and "${keys[1]}"). Name it once.`);
      }
      if (keys[0]) named.add(keys[0]);
    }
  }

  for (const [key, choice] of choices) {
    if (!named.has(key)) {
      throw new ValidationError(`operations names "${key}", which is not an operation in this spec. Use its operationId or "METHOD /path".`);
    }
    if (choice.impact != null) {
      try {
        parseImpactDeclaration(choice.impact);
      } catch (error) {
        throw new ValidationError(`operations["${key}"]: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return choices;
}
