import { policiesForAction } from "@/lib/policy-targeting";
import type {
	Action,
	ApprovalPolicy,
	ImpactLimit,
	InvocationStatus,
} from "@/lib/types";

export function formatMinor(amount: number, currency: string): string {
	try {
		return new Intl.NumberFormat("en-US", {
			style: "currency",
			currency: currency.toUpperCase(),
		}).format(amount / 100);
	} catch {
		return `${amount} ${currency.toUpperCase()} minor units`;
	}
}

export function moneyField(action: Pick<Action, "impact">): string | null {
	const impact = action.impact;
	if (!impact || impact.dimension !== "money") return null;
	const match = /^input\.([A-Za-z0-9_.]+)$/.exec(impact.amount.trim());
	return match ? (match[1] ?? null) : null;
}

const COMPARISON: Record<string, string> = {
	">": "is more than",
	">=": "is at least",
	"<": "is less than",
	"<=": "is at most",
	"==": "is",
	"!=": "is not",
};

const COUNT_COMPARISON: Record<string, string> = {
	">": "has more than",
	">=": "has at least",
	"<": "has fewer than",
	"<=": "has at most",
	"==": "has exactly",
};

export function conditionInWords(
	condition: string | null | undefined,
	action: Pick<Action, "impact">,
): string | null {
	const text = condition?.trim();
	if (!text) return null;
	const money = moneyField(action);
	const currency = action.impact?.unit ?? "usd";

	const numeric =
		/^input\.([A-Za-z0-9_.]+)\s*(>=|<=|==|!=|>|<)\s*(-?\d+)$/.exec(text);
	if (numeric) {
		const [, field, op, raw] = numeric;
		if (!field || !op || raw === undefined) return null;
		const value = field === money ? formatMinor(Number(raw), currency) : raw;
		return `${field} ${COMPARISON[op]} ${value}`;
	}

	const count =
		/^size\(input\.([A-Za-z0-9_.]+)\)\s*(>=|<=|==|>|<)\s*(\d+)$/.exec(text);
	if (count) {
		const [, field, op, raw] = count;
		if (!field || !op || raw === undefined) return null;
		return `${field} ${COUNT_COMPARISON[op]} ${raw} ${raw === "1" ? "entry" : "entries"}`;
	}

	const equals = /^input\.([A-Za-z0-9_.]+)\s*(==|!=)\s*['"]([^'"]*)['"]$/.exec(
		text,
	);
	if (equals) {
		const [, field, op, value] = equals;
		if (!field || !op) return null;
		return `${field} ${COMPARISON[op]} “${value}”`;
	}
	return null;
}

export interface ApprovalLine {
	text: string;
	source: string;
	code: string | null;
	policyId: string | null;
}

const EFFECT_SUBJECT: Record<ApprovalPolicy["effect"], string> = {
	require_approval: "A person approves",
	auto_deny: "Anlyon refuses",
	auto_approve: "Anlyon approves without asking",
};

export function approvalLines(
	policies: ApprovalPolicy[],
	action: Pick<Action, "name" | "impact" | "requiresApproval">,
): ApprovalLine[] {
	const lines: ApprovalLine[] = [];
	if (action.requiresApproval) {
		lines.push({
			text: "A person approves every call",
			source: "Set on this action",
			code: null,
			policyId: null,
		});
	}
	for (const policy of policiesForAction(policies, action.name)) {
		if (!policy.enabled || policy.match.kind === "custom") continue;
		const condition = policy.match.condition ?? null;
		const words = conditionInWords(condition, action);
		const minAmount = policy.match.minAmount;
		const money = moneyField(action);
		const parts: string[] = [];
		if (words) parts.push(words);
		if (minAmount !== null && minAmount !== undefined) {
			parts.push(
				money
					? `${money} is at least ${formatMinor(minAmount, action.impact?.unit ?? "usd")}`
					: `the amount is at least ${minAmount}`,
			);
		}
		const subject = EFFECT_SUBJECT[policy.effect];
		const text =
			!condition && parts.length === 0
				? `${subject} every call`
				: condition && !words
					? `${subject} some calls`
					: `${subject} calls where ${parts.join(" and ")}`;
		const broad =
			policy.match.kind === "any" || policy.match.actionName === null;
		lines.push({
			text,
			source: `From the policy “${policy.name}”${broad ? ", which covers every action" : ""}`,
			code: condition && !words ? condition : null,
			policyId: policy.id,
		});
	}
	return lines;
}

export type GateSummary = "always" | "sometimes" | "never";

export function gateSummary(
	policies: ApprovalPolicy[],
	action: Pick<Action, "name" | "impact" | "requiresApproval">,
): GateSummary {
	if (action.requiresApproval) return "always";
	let sometimes = false;
	for (const policy of policiesForAction(policies, action.name)) {
		if (
			!policy.enabled ||
			policy.match.kind === "custom" ||
			policy.effect !== "require_approval"
		)
			continue;
		const conditional =
			Boolean(policy.match.condition?.trim()) || policy.match.minAmount != null;
		if (!conditional) return "always";
		sometimes = true;
	}
	return sometimes ? "sometimes" : "never";
}

export const GATE_LABEL: Record<GateSummary, string> = {
	always: "Always needs approval",
	sometimes: "Sometimes needs approval",
	never: "Runs without approval",
};

const PERIOD_WORDS: Record<ImpactLimit["period"], string> = {
	day: "today",
	month: "this month",
	total: "in total",
};

export function formatAmount(
	amount: number,
	limit: Pick<ImpactLimit, "dimension" | "currency" | "unit">,
): string {
	if (limit.dimension === "money" && limit.currency) {
		return formatMinor(amount, limit.currency);
	}
	if (limit.dimension === "resource_mutations") {
		return `${amount} ${amount === 1 ? "change" : "changes"}`;
	}
	const unit = limit.unit || limit.dimension;
	const singular = unit.endsWith("s") ? unit.slice(0, -1) : unit;
	return `${amount} ${amount === 1 ? singular : unit}`;
}

export interface LimitLine {
	id: string;
	name: string;
	usage: string;
}

export function limitLines(
	limits: ImpactLimit[],
	action: Pick<Action, "name" | "impact">,
): LimitLine[] {
	const impact = action.impact;
	if (!impact) return [];
	return limits
		.filter(
			(limit) =>
				!limit.archived &&
				(limit.scope.actionName === null ||
					limit.scope.actionName === action.name) &&
				limit.dimension === impact.dimension &&
				(impact.dimension !== "money" ||
					(limit.currency ?? "").toLowerCase() === impact.unit.toLowerCase()),
		)
		.map((limit) => ({
			id: limit.id,
			name: limit.name,
			usage: `${formatAmount(limit.consumed + limit.reserved, limit)} of ${formatAmount(limit.limit, limit)} used ${PERIOD_WORDS[limit.period]}`,
		}));
}

export interface InputRow {
	name: string;
	hint: string;
	required: boolean;
}

export function inputRows(
	action: Pick<Action, "inputSchema" | "impact">,
): InputRow[] {
	const schema = action.inputSchema as {
		properties?: Record<string, Record<string, unknown>>;
		required?: string[];
	};
	const properties = schema?.properties ?? {};
	const required = new Set(schema?.required ?? []);
	const money = moneyField(action);
	return Object.entries(properties).map(([name, field]) => ({
		name,
		required: required.has(name),
		hint: describeField(name, field, money, action.impact?.unit ?? "usd"),
	}));
}

function describeField(
	name: string,
	field: Record<string, unknown>,
	money: string | null,
	currency: string,
): string {
	if (typeof field.description === "string" && field.description.trim()) {
		return field.description.trim();
	}
	if (Array.isArray(field.enum) && field.enum.length > 0) {
		return `One of: ${field.enum.map(String).join(", ")}`;
	}
	if (name === money) {
		return `An amount in the smallest unit of the currency: 2500 is ${formatMinor(2500, currency)}`;
	}
	switch (field.type) {
		case "integer":
			return "A whole number";
		case "number":
			return "A number";
		case "boolean":
			return "Yes or no";
		case "array":
			return "A list";
		case "object":
			return "A group of fields";
		default:
			return "Text";
	}
}

export function actionHost(urlTemplate: string): string | null {
	const match = /^https?:\/\/([^/?#{}]+)/i.exec(urlTemplate);
	return match ? (match[1] ?? null) : null;
}

export const CALL_STATUS: Record<
	InvocationStatus,
	{ label: string; tone: "good" | "wait" | "bad" | "neutral" }
> = {
	succeeded: { label: "Done", tone: "good" },
	pending_approval: { label: "Waiting for approval", tone: "wait" },
	running: { label: "Running", tone: "wait" },
	failed: { label: "Failed", tone: "bad" },
	unknown: { label: "Outcome unknown", tone: "bad" },
	denied: { label: "Refused", tone: "neutral" },
	expired: { label: "Approval expired", tone: "neutral" },
};
