import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { functionVersions } from "../../db/schema/functions.ts";
import { createLogger } from "../../lib/logger.ts";
import { RISK_LEVELS } from "../assistant/advice.ts";
import { publicModelVersion } from "../assistant/brand.ts";
import { getAssistantSettings } from "../assistant/service.ts";
import { askSystemOne, isTypeSafeConfigured, type TypeSafeQuestion, type TypeSafeResponse } from "../assistant/typesafe-client.ts";
import {
  admitAssistantUsage,
  admitPlatformReview,
  assistantCaps,
  releaseAssistantUsage,
  releasePlatformReview,
} from "../assistant/usage.ts";
import type { SourceFindings } from "./analysis.ts";

const logger = createLogger({ module: "function-review" });

export const MAX_REVIEWED_SOURCE_CHARS = 32 * 1024;
const PATTERN_THRESHOLD = 0.5;

const PURPOSES = {
  refunds: "Refunds or credits money to customers",
  payments: "Charges, pays out or transfers money",
  messages: "Sends emails, messages or notifications",
  records: "Creates or updates records in another system",
  accounts: "Changes accounts, access or permissions",
  lookups: "Reads and reports, changing nothing",
  other: null,
} as const;
type Purpose = keyof typeof PURPOSES;

const PATTERNS = {
  writes_in_loop: "It calls anlyon.invoke once per item of a list or in a loop, so one run can make many writes",
  money_per_item: "It moves money (refunds, payments, credits, transfers) once per item of a list",
  amount_from_input: "An amount of money it sends comes straight from the run's input without being checked",
  unchecked_write: "It writes without first reading or checking the state it changes",
} as const;
type Pattern = keyof typeof PATTERNS;

export interface FunctionAiReview {
  status: "reviewed" | "skipped" | "failed";
  reason: string | null;
  model: string | null;
  summary: string | null;
  purpose: Purpose | null;
  riskyPatterns: Array<{ pattern: Pattern; description: string; probability: number }>;
  suggestedRiskTier: (typeof RISK_LEVELS)[number] | null;
  confidence: number | null;
  truncated: boolean;
  reviewedAt: string;
}

export interface FunctionVersionReview {
  ast: SourceFindings;
  ai: FunctionAiReview | null;
}

export function buildReviewQuestions(): Record<string, TypeSafeQuestion> {
  return {
    purpose: { type: "choice", instructions: "What is this function mostly for?", criteria: { ...PURPOSES } },
    risk: {
      type: "score",
      instructions: "How much harm could one run of this function cause if its input or the world were not what the author expected?",
      criteria: [
        "Routine: reads, or easily reversed writes with no customer or financial impact",
        "Low: small, reversible impact on one customer or record",
        "Moderate: noticeable financial or customer impact, reversible with effort",
        "High: significant money, many customers, or hard to reverse",
        "Critical: irreversible, large financial loss, security or legal exposure",
      ],
    },
    ...Object.fromEntries(Object.entries(PATTERNS).map(([key, instructions]) => [key, { type: "noul" as const, instructions }])),
  };
}

export function buildReviewState(input: { language: string; source: string; allowedActions: string[]; ast: SourceFindings }) {
  return {
    task: "Review the code of a function before people approve what it does. It can affect the world only through anlyon.invoke (writes) and anlyon.read (reads) on the listed actions.",
    language: input.language,
    allowed_actions: input.allowedActions,
    calls_found_in_the_source: input.ast.calls.map((call) => `${call.kind} ${call.action} (line ${call.line})`),
    computed_action_names: input.ast.computedActionNames.length,
    source: input.source.slice(0, MAX_REVIEWED_SOURCE_CHARS),
  };
}

export function toReview(response: TypeSafeResponse, ast: SourceFindings, truncated: boolean, now: Date = new Date()): FunctionAiReview | null {
  const purposeAnswer = response.answers.purpose;
  const riskAnswer = response.answers.risk;
  if (purposeAnswer?.type !== "choice" || riskAnswer?.type !== "score") return null;
  if (!(purposeAnswer.choice in PURPOSES) || riskAnswer.score > RISK_LEVELS.length - 1) return null;
  const purpose = purposeAnswer.choice as Purpose;
  const tier = RISK_LEVELS[Math.round(riskAnswer.score)]!;

  const riskyPatterns: FunctionAiReview["riskyPatterns"] = [];
  for (const pattern of Object.keys(PATTERNS) as Pattern[]) {
    const answer = response.answers[pattern];
    if (answer?.type !== "noul") return null;
    if (answer.noul >= PATTERN_THRESHOLD) riskyPatterns.push({ pattern, description: PATTERNS[pattern], probability: answer.noul });
  }

  const reads = [...new Set(ast.calls.filter((call) => call.kind === "read").map((call) => call.action))];
  const writes = [...new Set(ast.calls.filter((call) => call.kind === "invoke").map((call) => call.action))];
  const summary = [
    PURPOSES[purpose] ? `${PURPOSES[purpose]}.` : "Its purpose is not one of the usual kinds.",
    reads.length ? `Reads ${reads.join(", ")}.` : null,
    writes.length ? `Writes ${writes.join(", ")}.` : "Makes no write that names its action literally.",
    ast.computedActionNames.length ? `${ast.computedActionNames.length} call(s) compute the action name.` : null,
    riskyPatterns.length ? `Watch for: ${riskyPatterns.map((p) => p.description.charAt(0).toLowerCase() + p.description.slice(1)).join("; ")}.` : null,
    `Suggested risk: ${tier}.`,
  ].filter(Boolean).join(" ");

  return {
    status: "reviewed",
    reason: null,
    model: publicModelVersion(response.model),
    summary,
    purpose,
    riskyPatterns,
    suggestedRiskTier: tier,
    confidence: Math.min(purposeAnswer.confidence, riskAnswer.confidence),
    truncated,
    reviewedAt: now.toISOString(),
  };
}

function notReviewed(status: "skipped" | "failed", reason: string): FunctionAiReview {
  return {
    status, reason, model: null, summary: null, purpose: null, riskyPatterns: [], suggestedRiskTier: null, confidence: null, truncated: false,
    reviewedAt: new Date().toISOString(),
  };
}

export async function aiReviewEligible(workspaceId: string): Promise<{ eligible: true } | { eligible: false; reason: string }> {
  if (!isTypeSafeConfigured()) return { eligible: false, reason: "not_configured" };
  const settings = await getAssistantSettings(workspaceId);
  if (!settings.enabled) return { eligible: false, reason: "assistant_disabled" };
  return { eligible: true };
}

export async function reviewVersion(versionRowId: string, opts: { ask?: typeof askSystemOne } = {}): Promise<FunctionAiReview> {
  const [version] = await db.select().from(functionVersions).where(eq(functionVersions.id, versionRowId));
  if (!version) return notReviewed("failed", "version_not_found");
  const stored = version.review as FunctionVersionReview | null;
  const ast = stored?.ast;
  const save = async (ai: FunctionAiReview) => {
    if (ast) await db.update(functionVersions).set({ review: { ast, ai } }).where(eq(functionVersions.id, versionRowId));
    return ai;
  };
  if (!ast) return notReviewed("failed", "no_source_findings");

  try {
    const eligible = await aiReviewEligible(version.workspaceId);
    if (!eligible.eligible) return save(notReviewed("skipped", eligible.reason));

    const platform = await admitPlatformReview();
    if (!platform) return save(notReviewed("skipped", "platform_limit"));
    const caps = await assistantCaps(version.workspaceId);
    const usage = await admitAssistantUsage(version.workspaceId, "reviews", caps.reviews);
    if (!usage) {
      await releasePlatformReview(platform);
      return save(notReviewed("skipped", "quota_exceeded"));
    }

    const source = Object.values(version.sourceModules)[0] ?? "";
    const result = await (opts.ask ?? askSystemOne)(
      buildReviewState({ language: version.language, source, allowedActions: version.allowedActions, ast }),
      buildReviewQuestions(),
    );
    if (!result.ok) {
      if (result.reason === "not_configured" || result.reason === "circuit_open") {
        await releaseAssistantUsage(usage);
        await releasePlatformReview(platform);
      }
      return save(notReviewed("failed", result.reason));
    }
    const review = toReview(result.response, ast, source.length > MAX_REVIEWED_SOURCE_CHARS);
    return save(review ?? notReviewed("failed", "invalid_answers"));
  } catch (error) {
    logger.warn({ versionRowId, error: error instanceof Error ? error.message : String(error) }, "Function review failed");
    return save(notReviewed("failed", "internal_error")).catch(() => notReviewed("failed", "internal_error"));
  }
}
