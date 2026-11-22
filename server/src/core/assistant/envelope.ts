import type { AssistantAutoApprove } from "../../db/schema/assistant.ts";

export const MIN_CONFIDENCE_FLOOR = 0.8;
export const INJECTION_CEILING = 0.2;
export const CONSISTENCY_FLOOR = 0.5;

export interface EnvelopeInput {
  platformKillSwitch: boolean;
  environmentHalted: boolean;
  settings: { enabled: boolean; autoApprove: AssistantAutoApprove };
  approval: {
    kind: "action" | "custom" | "function_plan";
    status: string;
    expiresAt: Date;
    requiredApprovals: number;
    environmentId: string;
  };
  actionName: string | null;
  amount: number | null;
  carriesMoney?: boolean;
  advice: {
    recommendation: "approve" | "deny" | "review";
    risk: number;
    confidence: number;
    injectionSuspected: number | null;
    consistentWithHistory: number | null;
  };
  history: { approved: number; denied: number };
  now: Date;
}

export type EnvelopeRule =
  | "platform_disabled"
  | "environment_halted"
  | "assistant_disabled"
  | "auto_approve_disabled"
  | "not_an_action"
  | "action_not_allowlisted"
  | "environment_not_allowed"
  | "needs_multiple_approvers"
  | "not_pending"
  | "expired"
  | "not_recommended"
  | "confidence_below_threshold"
  | "risk_above_threshold"
  | "injection_suspected"
  | "inconsistent_with_history"
  | "insufficient_history"
  | "prior_denials"
  | "amount_missing"
  | "amount_above_cap"
  | "amount_without_cap";

const MONEY_FIELD = /amount|price|total|cost|fee|charge/i;
const NOT_MONEY_FIELD = /count|page|limit|offset|index|id$/i;
const NUMBER_TEXT = /^\s*-?\d+(?:\.\d+)?\s*$/;

const numeric = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && NUMBER_TEXT.test(value)) return Number(value);
  return null;
};

function namesMoney(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== "object") return false;
  if (depth > 8) return true;
  if (Array.isArray(value)) return value.some((item) => namesMoney(item, depth + 1));
  return Object.entries(value).some(([key, item]) =>
    (MONEY_FIELD.test(key) && !NOT_MONEY_FIELD.test(key) && numeric(item) !== null) || namesMoney(item, depth + 1));
}

export function readAmount(input: unknown, payloadAmount: unknown, governedMoney = false): { amount: number | null; carriesMoney: boolean } {
  const own = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).amount : undefined;
  const source = own ?? payloadAmount;
  const amount = numeric(source);
  const unreadable = source !== undefined && source !== null && amount === null;
  return { amount, carriesMoney: amount !== null || unreadable || governedMoney || namesMoney(input) };
}

export function mayAutoApprove(input: EnvelopeInput): { ok: boolean; failed: EnvelopeRule[] } {
  const { settings, approval, advice, history } = input;
  const cfg = settings.autoApprove;
  const failed: EnvelopeRule[] = [];

  if (input.platformKillSwitch) failed.push("platform_disabled");
  if (input.environmentHalted) failed.push("environment_halted");
  if (!settings.enabled) failed.push("assistant_disabled");
  if (!cfg.enabled) failed.push("auto_approve_disabled");
  if (approval.kind !== "action" || !input.actionName) failed.push("not_an_action");
  if (!input.actionName || !cfg.actions.includes(input.actionName)) failed.push("action_not_allowlisted");
  if (cfg.environments && cfg.environments.length > 0 && !cfg.environments.includes(approval.environmentId)) {
    failed.push("environment_not_allowed");
  }
  if (approval.requiredApprovals !== 1) failed.push("needs_multiple_approvers");
  if (approval.status !== "pending") failed.push("not_pending");
  if (approval.expiresAt.getTime() <= input.now.getTime()) failed.push("expired");

  if (advice.recommendation !== "approve") failed.push("not_recommended");
  const minConfidence = Math.max(MIN_CONFIDENCE_FLOOR, cfg.minConfidence);
  if (!(advice.confidence >= minConfidence)) failed.push("confidence_below_threshold");
  if (!(advice.risk <= cfg.maxRisk)) failed.push("risk_above_threshold");
  if (advice.injectionSuspected === null || advice.injectionSuspected >= INJECTION_CEILING) failed.push("injection_suspected");
  if (advice.consistentWithHistory === null || advice.consistentWithHistory < CONSISTENCY_FLOOR) {
    failed.push("inconsistent_with_history");
  }
  if (history.approved < cfg.minHistory) failed.push("insufficient_history");
  if (history.denied > 0) failed.push("prior_denials");

  if (cfg.maxAmount !== undefined && cfg.maxAmount !== null) {
    if (input.amount === null) failed.push("amount_missing");
    else if (Math.abs(input.amount) > cfg.maxAmount) failed.push("amount_above_cap");
  } else if (input.amount !== null || input.carriesMoney) {
    failed.push("amount_without_cap");
  }

  return { ok: failed.length === 0, failed };
}

export const ENVELOPE_RULE_TEXT: Record<EnvelopeRule, string> = {
  platform_disabled: "Vigil approvals are paused for all workspaces",
  environment_halted: "The environment is halted",
  assistant_disabled: "Vigil is turned off for this workspace",
  auto_approve_disabled: "Auto-approve is off",
  not_an_action: "Only action requests can be auto-approved",
  action_not_allowlisted: "This action is not on the auto-approve list",
  environment_not_allowed: "Auto-approve is not enabled for this environment",
  needs_multiple_approvers: "A policy requires more than one approver",
  not_pending: "Already decided",
  expired: "Expired",
  not_recommended: "Vigil did not suggest approving",
  confidence_below_threshold: "Confidence is below the auto-approve threshold",
  risk_above_threshold: "Risk is above the auto-approve limit",
  injection_suspected: "Possible injected instructions",
  inconsistent_with_history: "Not consistent with this agent's history",
  insufficient_history: "Not enough approved history for this agent and action",
  prior_denials: "A similar request was denied in the last 30 days",
  amount_missing: "No amount to check against the cap",
  amount_above_cap: "Amount is above the auto-approve cap",
  amount_without_cap: "This request carries an amount and auto-approve has no cap set",
};
