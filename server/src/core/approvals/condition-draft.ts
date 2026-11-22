import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { workspaceUsagePeriods } from "../../db/schema/billing.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { createLogger } from "../../lib/logger.ts";
import { getMonthKey } from "../../lib/workspace-cache.ts";
import { ApiError, NotFoundError } from "../../utils/errors.ts";
import { getPlanLimits } from "../plans/limits.ts";
import { resourcePlan } from "../billing/plan-management.ts";
import { QuotaExceededError } from "../billing/usage-enforcement.ts";
import { getEnvironment } from "../environments/service.ts";
import { OpenRouterLLMProvider, type ChatMessage, type LLMProvider } from "../lib/llm.ts";
import { CONDITION_FACTS, checkCondition, type ConditionCheck } from "./condition.ts";
import { conditionInputFields, targetInputSchema, type PolicyMatchKind } from "./policy.ts";

const logger = createLogger({ module: "condition-draft" });

export const DRAFT_REQUEST_MAX_LENGTH = 500;
const UNAVAILABLE = "Policy drafting is not available right now. You can still write the condition yourself.";

export interface DraftConditionInput {
  environmentId: string;
  matchKind: PolicyMatchKind;
  matchActionName?: string | null;
  request: string;
}

export interface DraftConditionResult {
  condition: string | null;
  check: ConditionCheck | null;
  usage: { used: number; limit: number };
}

async function takeDraft(workspaceId: string): Promise<{ used: number; limit: number; month: string }> {
  return db.transaction(async (tx) => {
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    if (!workspace) throw new NotFoundError("Workspace");
    const limit = getPlanLimits(resourcePlan(workspace), workspace).maxMonthlyConditionDrafts;
    const month = getMonthKey();
    await tx.insert(workspaceUsagePeriods).values({ workspaceId, month }).onConflictDoNothing();
    const [row] = await tx.update(workspaceUsagePeriods)
      .set({ conditionDrafts: sql`${workspaceUsagePeriods.conditionDrafts} + 1` })
      .where(and(
        eq(workspaceUsagePeriods.workspaceId, workspaceId),
        eq(workspaceUsagePeriods.month, month),
        lt(workspaceUsagePeriods.conditionDrafts, limit),
      ))
      .returning({ used: workspaceUsagePeriods.conditionDrafts });
    if (!row) {
      throw new QuotaExceededError(
        `This plan includes ${limit} policy drafts a month, and they are used up. You can still write conditions yourself.`,
        0,
      );
    }
    return { used: row.used, limit, month };
  });
}

async function returnDraft(workspaceId: string, month: string): Promise<void> {
  await db.update(workspaceUsagePeriods)
    .set({ conditionDrafts: sql`greatest(${workspaceUsagePeriods.conditionDrafts} - 1, 0)` })
    .where(and(eq(workspaceUsagePeriods.workspaceId, workspaceId), eq(workspaceUsagePeriods.month, month)));
}

export function draftPrompt(input: DraftConditionInput, inputSchema: unknown): ChatMessage[] {
  const fields = conditionInputFields(inputSchema);
  const fieldList = fields.length
    ? fields
      .map((f) => `- ${f.path}: ${f.type}${f.optional ? " (optional: guard with has())" : ""}${f.description ? ` - ${f.description}` : ""}`)
      .join("\n")
    : "- input: map (fields unknown; use the field names the user gives)";
  const facts = CONDITION_FACTS.filter((f) => f.name !== "input")
    .map((f) => `- ${f.name}: ${f.type} - ${f.description}`)
    .join("\n");
  const target = input.matchKind === "action" && input.matchActionName
    ? `calls to the action "${input.matchActionName}"`
    : input.matchKind === "custom" ? "custom approval requests" : "every call in scope";
  return [
    {
      role: "system",
      content: [
        "You write one CEL (Common Expression Language) boolean expression for an approval policy condition.",
        `The policy applies to ${target}. The condition decides whether the policy applies to a given call.`,
        "Available input fields:",
        fieldList,
        "Other facts:",
        facts,
        "Rules: output a single expression that evaluates to true or false. Use only the fields and facts above.",
        "Guard optional fields with has(), for example has(input.amount) && input.amount >= 500.",
        "Numbers are doubles. Strings use double quotes. Use `in [...]` for one-of checks and .exists(x, ...) for lists.",
        "Do not describe the effect (approve, deny, how many approvers); only when the policy applies.",
        "Reply with JSON only: {\"condition\": \"<expression>\"}. If the request cannot be expressed with these facts, reply {\"condition\": null}.",
      ].join("\n"),
    },
    { role: "user", content: input.request },
  ];
}

export function parseDraft(content: string): string | null | undefined {
  const text = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    const value = JSON.parse(text) as { condition?: unknown };
    if (value.condition === null) return null;
    return typeof value.condition === "string" && value.condition.trim() ? value.condition.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function draftCondition(
  workspaceId: string,
  input: DraftConditionInput,
  llm: () => LLMProvider = () => new OpenRouterLLMProvider(),
): Promise<DraftConditionResult> {
  await getEnvironment(workspaceId, input.environmentId);
  const inputSchema = await targetInputSchema(workspaceId, input.environmentId, {
    kind: input.matchKind, actionName: input.matchActionName ?? null,
  });
  let provider: LLMProvider;
  try {
    provider = llm();
  } catch {
    throw new ApiError(503, "DRAFTING_UNAVAILABLE", UNAVAILABLE);
  }
  const messages = draftPrompt(input, inputSchema);
  const taken = await takeDraft(workspaceId);

  let condition: string | null | undefined;
  let check: ConditionCheck | null = null;
  try {
    const first = await provider.chat(messages, { maxTokens: 300, temperature: 0 });
    condition = parseDraft(first.content);
    check = condition ? checkCondition(condition, { inputSchema }) : null;
    if (condition === undefined || (check && !check.valid)) {
      const problem = condition === undefined
        ? "The reply was not the requested JSON."
        : (check as { valid: false; message: string }).message;
      const second = await provider.chat([
        ...messages,
        { role: "assistant", content: first.content },
        { role: "user", content: `That does not work: ${problem}\nReply with corrected JSON only.` },
      ], { maxTokens: 300, temperature: 0 });
      condition = parseDraft(second.content);
      check = condition ? checkCondition(condition, { inputSchema }) : null;
    }
  } catch (error) {
    await returnDraft(workspaceId, taken.month).catch(() => {});
    logger.warn({ workspaceId }, "Condition draft failed");
    if (error instanceof ApiError && error.code === "EXPENSIVE_WORK_PAUSED") throw error;
    throw new ApiError(503, "DRAFTING_UNAVAILABLE", UNAVAILABLE);
  }

  logger.info({ workspaceId, drafted: condition != null, valid: check?.valid ?? null }, "Condition drafted");
  return { condition: condition ?? null, check, usage: { used: taken.used, limit: taken.limit } };
}
