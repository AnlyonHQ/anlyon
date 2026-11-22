import type {
	Approval,
	AssistantAdvice,
	AssistantAutoApprove,
	AssistantRiskLevel,
} from "@/lib/types";

export const RISK_LEVELS: AssistantRiskLevel[] = [
	"routine",
	"low",
	"moderate",
	"high",
	"critical",
];

export const RISK_LABEL: Record<AssistantRiskLevel, string> = {
	routine: "Routine",
	low: "Low",
	moderate: "Moderate",
	high: "High",
	critical: "Critical",
};

export const MIN_CONFIDENCE_FLOOR = 0.8;
export const INJECTION_CEILING = 0.2;
export const CONSISTENCY_FLOOR = 0.5;

export type SignalState = "pass" | "warn" | "fail";

export interface Signal {
	id: "risk" | "history" | "amount" | "injection";
	label: string;
	state: SignalState;
	value: string;
	detail: string;
	explain: string;
}

export function riskLevelOf(risk: number): AssistantRiskLevel {
	return RISK_LEVELS[Math.min(4, Math.max(0, Math.round(risk)))];
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const num = (n: number) => n.toLocaleString();

export function adviceSignals(
	advice: AssistantAdvice,
	amount: number | undefined,
): Signal[] {
	const signals: Signal[] = [];
	if (advice.risk !== null) {
		const level = advice.riskLevel ?? riskLevelOf(advice.risk);
		signals.push({
			id: "risk",
			label: "Risk if approved",
			state: advice.risk <= 1 ? "pass" : advice.risk <= 2 ? "warn" : "fail",
			value: RISK_LABEL[level],
			detail: `${advice.risk.toFixed(1)} on a 0–4 scale`,
			explain:
				"How much harm approving could do if it turned out to be wrong: reversibility, money and how many customers it touches.",
		});
	}

	const history = advice.history;
	const consistency = advice.flags?.consistentWithHistory ?? null;
	if (history) {
		const total = history.approved + history.denied;
		signals.push({
			id: "history",
			label: "Matches this agent's history",
			state:
				history.denied > 0
					? "warn"
					: total === 0
						? "warn"
						: consistency === null || consistency >= CONSISTENCY_FLOOR
							? "pass"
							: consistency >= 0.3
								? "warn"
								: "fail",
			value:
				total === 0
					? "No history"
					: consistency === null
						? "—"
						: pct(consistency),
			detail:
				total === 0
					? "First request like this in 30 days"
					: `${num(history.approved)} approved · ${num(history.denied)} denied in 30 days`,
			explain:
				"Compared with requests for the same action by the same agent that approvers decided in the last 30 days. A single denial keeps auto-approve off.",
		});
	}

	if (amount !== undefined) {
		const unusual = advice.flags?.amountUnusual ?? null;
		const max = history?.maxAmount ?? null;
		signals.push({
			id: "amount",
			label: "Amount",
			state:
				unusual !== null && unusual >= 0.5
					? "warn"
					: max !== null && amount > max
						? "warn"
						: "pass",
			value: num(amount),
			detail:
				max === null
					? "No approved amounts to compare with"
					: `Median ${num(history?.medianAmount ?? 0)} · largest approved ${num(max)}`,
			explain:
				"Where this amount sits among the amounts approvers approved for this agent and action.",
		});
	}

	const injection = advice.flags?.injectionSuspected ?? null;
	if (injection !== null) {
		signals.push({
			id: "injection",
			label: "Injected instructions",
			state:
				injection < INJECTION_CEILING
					? "pass"
					: injection < 0.5
						? "warn"
						: "fail",
			value: injection < INJECTION_CEILING ? "None found" : "Possible",
			detail: `${pct(injection)} likely`,
			explain:
				"Whether the request carries text or values that look planted to steer the agent rather than a normal business request. No check catches everything.",
		});
	}
	return signals;
}

export function autoApproveNote(advice: AssistantAdvice): string | null {
	const note = advice.reasons.find((r) => r.startsWith("Left for a person: "));
	return note ? note.slice("Left for a person: ".length) : null;
}

export function adviceReasons(advice: AssistantAdvice): string[] {
	return advice.reasons.filter((r) => !r.startsWith("Left for a person: "));
}

export type EnvelopeMiss =
	| "not an action"
	| "action not on the list"
	| "needs more than one approver"
	| "not suggested for approval"
	| "confidence too low"
	| "risk too high"
	| "possible injected text"
	| "unlike its history"
	| "not enough history"
	| "a similar request was denied"
	| "no amount to check"
	| "amount above the cap";

export function envelopeMisses(
	approval: Approval,
	advice: AssistantAdvice,
	limits: AssistantAutoApprove,
): EnvelopeMiss[] {
	const misses: EnvelopeMiss[] = [];
	const actionName =
		typeof approval.payload?.actionName === "string"
			? approval.payload.actionName
			: null;
	if (approval.kind !== "action" || !actionName) misses.push("not an action");
	else if (!limits.actions.includes(actionName))
		misses.push("action not on the list");
	if (approval.requiredApprovals !== 1)
		misses.push("needs more than one approver");
	if (advice.recommendation !== "approve")
		misses.push("not suggested for approval");
	if (
		(advice.confidence ?? 0) <
		Math.max(MIN_CONFIDENCE_FLOOR, limits.minConfidence)
	) {
		misses.push("confidence too low");
	}
	if (advice.risk === null || advice.risk > limits.maxRisk)
		misses.push("risk too high");
	const injection = advice.flags?.injectionSuspected ?? null;
	if (injection === null || injection >= INJECTION_CEILING)
		misses.push("possible injected text");
	const consistency = advice.flags?.consistentWithHistory ?? null;
	if (consistency === null || consistency < CONSISTENCY_FLOOR)
		misses.push("unlike its history");
	if ((advice.history?.approved ?? 0) < limits.minHistory)
		misses.push("not enough history");
	if ((advice.history?.denied ?? 0) > 0)
		misses.push("a similar request was denied");
	if (limits.maxAmount !== undefined && limits.maxAmount !== null) {
		const input = approval.payload?.input as
			| Record<string, unknown>
			| undefined;
		const amount = typeof input?.amount === "number" ? input.amount : undefined;
		if (amount === undefined) misses.push("no amount to check");
		else if (amount > limits.maxAmount) misses.push("amount above the cap");
	}
	return misses;
}

export interface ReplayResult {
	considered: number;
	wouldApprove: Approval[];
	wouldApproveDenied: Approval[];
	leftForPeople: number;
	topMiss: { reason: EnvelopeMiss; count: number } | null;
}

export function replayLimits(
	approvals: Approval[],
	limits: AssistantAutoApprove,
): ReplayResult {
	const decided = approvals.filter(
		(a) => a.status !== "pending" && a.advice?.status === "ready",
	);
	const wouldApprove: Approval[] = [];
	const missCounts = new Map<EnvelopeMiss, number>();
	for (const approval of decided) {
		const misses = envelopeMisses(
			approval,
			approval.advice as AssistantAdvice,
			limits,
		);
		if (misses.length === 0) wouldApprove.push(approval);
		else missCounts.set(misses[0], (missCounts.get(misses[0]) ?? 0) + 1);
	}
	const top = [...missCounts.entries()].sort((a, b) => b[1] - a[1])[0];
	return {
		considered: decided.length,
		wouldApprove,
		wouldApproveDenied: wouldApprove.filter((a) => a.status === "denied"),
		leftForPeople: decided.length - wouldApprove.length,
		topMiss: top ? { reason: top[0], count: top[1] } : null,
	};
}

export function projectMonthly(
	used: number,
	now: Date = new Date(),
): { perDay: number; projected: number; daysInMonth: number } {
	const daysInMonth = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
	).getUTCDate();
	const elapsedDays = Math.max(
		1,
		now.getUTCDate() - 1 + now.getUTCHours() / 24 + now.getUTCMinutes() / 1440,
	);
	const perDay = used / elapsedDays;
	return { perDay, projected: Math.round(perDay * daysInMonth), daysInMonth };
}
