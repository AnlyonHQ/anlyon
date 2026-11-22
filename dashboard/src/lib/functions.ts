import type {
	Approval,
	FunctionAiReview,
	FunctionBudgetName,
	FunctionBudgets,
	FunctionCallState,
	FunctionLanguage,
	FunctionRun,
	FunctionRunMode,
	FunctionRunStatus,
	FunctionSourceFindings,
	FunctionStraightThroughPolicy,
} from "@/lib/types";

export const FUNCTION_LANGUAGES: ReadonlyArray<{
	value: FunctionLanguage;
	label: string;
}> = [
	{ value: "javascript", label: "JavaScript" },
	{ value: "python", label: "Python" },
];

export const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export const BUDGETS: ReadonlyArray<{
	name: FunctionBudgetName;
	label: string;
	hint: string;
	min: number;
	max: number;
	defaultValue: number;
}> = [
	{
		name: "maxActionCalls",
		label: "Action calls",
		hint: "Action calls one run may dispatch.",
		min: 1,
		max: 500,
		defaultValue: 50,
	},
	{
		name: "maxCpuMs",
		label: "CPU time (ms)",
		hint: "CPU time one run may use.",
		min: 1,
		max: 30_000,
		defaultValue: 1_000,
	},
	{
		name: "maxSubrequests",
		label: "Binding calls",
		hint: "Calls through the anlyon binding in one run, refused ones included.",
		min: 1,
		max: 1_000,
		defaultValue: 100,
	},
	{
		name: "timeoutMs",
		label: "Wall time (ms)",
		hint: "How long one run may take.",
		min: 100,
		max: 300_000,
		defaultValue: 30_000,
	},
];

export const BUDGET_LABEL: Record<FunctionBudgetName, string> = {
	maxActionCalls: "Action calls",
	maxCpuMs: "CPU time",
	maxSubrequests: "Binding calls",
	timeoutMs: "Wall time",
};

export const RUN_STATUS_LABEL: Record<FunctionRunStatus, string> = {
	running: "Running",
	succeeded: "Succeeded",
	failed: "Failed",
	budget_exceeded: "Budget exceeded",
	planned: "Planned",
	awaiting_approval: "Awaiting approval",
	diverged: "Diverged",
};

export const RUN_STATUS_DOT: Record<FunctionRunStatus, string> = {
	running: "bg-info",
	succeeded: "bg-success",
	failed: "bg-destructive",
	budget_exceeded: "bg-destructive",
	planned: "bg-success",
	awaiting_approval: "bg-warning",
	diverged: "bg-destructive",
};

export const RUN_MODE_LABEL: Record<FunctionRunMode, string> = {
	plan: "Plan",
	apply: "Apply",
	straight_through: "Straight through",
};

export const CALL_STATE_LABEL: Record<FunctionCallState, string> = {
	intent: "Planned",
	dispatched: "Dispatched",
	refused: "Refused",
	failed: "Failed",
};

export function runStatusNote(run: FunctionRun): string {
	switch (run.status) {
		case "running":
			return "The run is still going.";
		case "succeeded":
			return run.mode === "apply"
				? "The approved plan was carried out, write by write."
				: "The run finished.";
		case "failed":
			return run.error
				? `The run failed: ${run.error.message}`
				: "The run failed.";
		case "budget_exceeded":
			return run.budget
				? `The run stopped when its ${BUDGET_LABEL[run.budget].toLowerCase()} budget ran out.`
				: "The run stopped when a budget ran out.";
		case "planned":
			return "The plan has no writes, so it needs no approval.";
		case "awaiting_approval":
			return "The plan's writes wait for approval. Once approved, apply it to carry them out.";
		case "diverged":
			return "The apply run did not make the writes its plan was approved for, so it stopped at the write that did not match.";
	}
}

export function parseNameList(text: string): string[] {
	const names = text
		.split(/[\s,]+/)
		.map((name) => name.trim())
		.filter(Boolean);
	return [...new Set(names)];
}

export interface PublishDraft {
	language: FunctionLanguage;
	source: string;
	allowedActions: string;
	budgets: Record<FunctionBudgetName, string>;
	straightThrough: {
		enabled: boolean;
		actions: string;
		maxWrites: string;
	};
}

export interface PublishBody {
	language: FunctionLanguage;
	source: string;
	allowedActions?: string[];
	budgets?: Partial<FunctionBudgets>;
	straightThrough?: FunctionStraightThroughPolicy | null;
}

export const EMPTY_BUDGETS: Record<FunctionBudgetName, string> = {
	maxActionCalls: "",
	maxCpuMs: "",
	maxSubrequests: "",
	timeoutMs: "",
};

const isWhole = (text: string) => /^\d+$/.test(text.trim());

export function publishBody(
	draft: PublishDraft,
):
	| { ok: true; body: PublishBody }
	| { ok: false; errors: Partial<Record<string, string>> } {
	const errors: Partial<Record<string, string>> = {};
	if (!draft.source.trim()) errors.source = "Write or paste the source.";

	const allowed = parseNameList(draft.allowedActions);
	const badName = allowed.find((name) => !NAME_PATTERN.test(name));
	if (badName) {
		errors.allowedActions = `"${badName}" is not an action name. Use letters, digits, - and _.`;
	}

	const budgets: Partial<FunctionBudgets> = {};
	for (const budget of BUDGETS) {
		const text = draft.budgets[budget.name].trim();
		if (!text) continue;
		const value = Number(text);
		if (!isWhole(text) || value < budget.min || value > budget.max) {
			errors[budget.name] =
				`Enter a whole number from ${budget.min} to ${budget.max}.`;
			continue;
		}
		budgets[budget.name] = value;
	}

	let straightThrough: FunctionStraightThroughPolicy | null = null;
	if (draft.straightThrough.enabled) {
		const actions = parseNameList(draft.straightThrough.actions);
		const maxText = draft.straightThrough.maxWrites.trim();
		const maxWrites = Number(maxText);
		if (actions.length === 0) {
			errors.straightThroughActions = "Name an action it may write to.";
		} else if (allowed.length > 0) {
			const outside = actions.find((name) => !allowed.includes(name));
			if (outside) {
				errors.straightThroughActions = `"${outside}" is not in the allow-list.`;
			}
		}
		if (!isWhole(maxText) || maxWrites < 1 || maxWrites > 500) {
			errors.straightThroughMaxWrites = "Enter a whole number from 1 to 500.";
		}
		straightThrough = { actions, maxWrites };
	}

	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return {
		ok: true,
		body: {
			language: draft.language,
			source: draft.source,
			...(allowed.length > 0 ? { allowedActions: allowed } : {}),
			...(Object.keys(budgets).length > 0 ? { budgets } : {}),
			straightThrough,
		},
	};
}

export function parseRunInput(
	text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
	if (!text.trim()) return { ok: true, value: {} };
	try {
		const value: unknown = JSON.parse(text);
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false, error: "The input must be a JSON object." };
		}
		return { ok: true, value: value as Record<string, unknown> };
	} catch {
		return { ok: false, error: "The input is not valid JSON." };
	}
}

export interface SourceWarning {
	kind: "parse" | "computed" | "risky" | "loop";
	line: number | null;
	message: string;
}

export function sourceWarnings(
	findings: FunctionSourceFindings,
): SourceWarning[] {
	const warnings: SourceWarning[] = [];
	if (!findings.parsed) {
		warnings.push({
			kind: "parse",
			line: null,
			message: `The source could not be read${findings.parseError ? ` (${findings.parseError})` : ""}. List the actions it calls by hand.`,
		});
	}
	for (const computed of findings.computedActionNames) {
		warnings.push({
			kind: "computed",
			line: computed.line,
			message: `Computes the name of the action it ${computed.kind === "read" ? "reads" : "calls"}, so the allow-list cannot be read from the source. List the actions by hand.`,
		});
	}
	for (const risky of findings.risky) {
		warnings.push({
			kind: "risky",
			line: risky.line,
			message: `Uses ${risky.api} (${risky.category}). It fails inside a function: the network, files and processes are off.`,
		});
	}
	for (const loop of findings.writesInLoop) {
		warnings.push({
			kind: "loop",
			line: loop.line,
			message: loop.action
				? `Writes to ${loop.action} inside a loop. Each write is in the plan an approver sees.`
				: "Writes inside a loop. Each write is in the plan an approver sees.",
		});
	}
	return warnings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

export function needsManualAllowList(
	findings: FunctionSourceFindings,
): boolean {
	return !findings.parsed || findings.computedActionNames.length > 0;
}

const AI_SKIP_REASON: Record<string, string> = {
	assistant_disabled:
		"Vigil is off for this workspace, so this version has no AI review.",
	not_configured: "AI review is not available here, so this version has none.",
	quota_exceeded:
		"The workspace has used its AI reviews for now, so this version has none.",
};

export function aiReviewNote(
	ai: FunctionAiReview | null | undefined,
): string | null {
	if (!ai) {
		return "No AI review for this version yet. It runs when Vigil is on for the workspace.";
	}
	if (ai.status === "skipped") {
		return (
			(ai.reason ? AI_SKIP_REASON[ai.reason] : undefined) ??
			"The AI review was skipped for this version."
		);
	}
	if (ai.status === "failed") {
		return "The AI review could not finish for this version. The source findings above still apply.";
	}
	return null;
}

export const RISK_TIER_LABEL: Record<string, string> = {
	routine: "Routine",
	low: "Low",
	moderate: "Moderate",
	high: "High",
	critical: "Critical",
};

export function applyState(
	run: FunctionRun,
): { canApply: true } | { canApply: false; reason: string | null } {
	if (run.mode !== "plan") return { canApply: false, reason: null };
	const plan = run.plan;
	if (!plan || plan.writes.length === 0 || !plan.approval) {
		return { canApply: false, reason: null };
	}
	if (plan.appliedByRunId) {
		return { canApply: false, reason: "This plan has been applied." };
	}
	switch (plan.approval.status) {
		case "approved":
			return { canApply: true };
		case "pending":
			return {
				canApply: false,
				reason: "Apply opens once the plan is approved.",
			};
		case "denied":
			return { canApply: false, reason: "The plan was denied." };
		case "expired":
			return {
				canApply: false,
				reason: "The approval expired. Start a new plan run.",
			};
	}
}

export function runIsSettling(run: FunctionRun | undefined): boolean {
	if (!run) return false;
	if (run.status === "running") return true;
	return (
		run.status === "awaiting_approval" &&
		run.plan?.approval?.status === "pending"
	);
}

export function functionPlanPayload(
	approval: Pick<Approval, "kind" | "payload">,
): {
	writes: Array<{ action: string; input: unknown }>;
	summary: string | null;
} | null {
	if (approval.kind !== "function_plan") return null;
	const payload = approval.payload ?? {};
	const writes = Array.isArray(payload.writes)
		? (payload.writes as unknown[]).flatMap((write) =>
				write && typeof write === "object" && !Array.isArray(write)
					? [
							{
								action: String((write as { action?: unknown }).action ?? ""),
								input: (write as { input?: unknown }).input ?? null,
							},
						]
					: [],
			)
		: [];
	const review = payload.review;
	const summary =
		review &&
		typeof review === "object" &&
		typeof (review as { summary?: unknown }).summary === "string"
			? (review as { summary: string }).summary
			: null;
	return { writes, summary };
}

export interface FunctionTemplate {
	id: string;
	label: string;
	description: string;
	source: Record<FunctionLanguage, string>;
}

export const FUNCTION_TEMPLATES: ReadonlyArray<FunctionTemplate> = [
	{
		id: "read-then-write",
		label: "Read, then write",
		description:
			"Check something first, then change it. The write waits for approval.",
		source: {
			javascript: `// Read first, then decide. Type anlyon.read(" or anlyon.invoke(" to pick one of your actions.
export default async function run(input, anlyon) {
  const record = await anlyon.read("get-record", { id: input.id });
  if (!record.ok) return { done: false, reason: record.error.code };

  // result.json is the app's reply, parsed.
  if (record.result.json?.status === "closed") return { done: false, reason: "already closed" };

  const update = await anlyon.invoke("update-record", { id: input.id, status: "closed" });
  anlyon.log(\`update \${update.ok ? "accepted" : "refused"}\`);
  return { done: update.ok };
}
`,
			python: `# Read first, then decide. Type anlyon.read(" or anlyon.invoke(" to pick one of your actions.
async def run(input, anlyon):
    record = await anlyon.read("get-record", {"id": input["id"]})
    if not record["ok"]:
        return {"done": False, "reason": record["error"]["code"]}

    # result["json"] is the app's reply, parsed.
    if (record["result"]["json"] or {}).get("status") == "closed":
        return {"done": False, "reason": "already closed"}

    update = await anlyon.invoke("update-record", {"id": input["id"], "status": "closed"})
    anlyon.log("update accepted" if update["ok"] else "update refused")
    return {"done": update["ok"]}
`,
		},
	},
	{
		id: "read-only",
		label: "Read only",
		description: "Look things up and return a summary. Nothing to approve.",
		source: {
			javascript: `// Reads only: a plan run of this needs no approval.
export default async function run(input, anlyon) {
  const found = await anlyon.read("search-records", { query: input.query });
  if (!found.ok) return { error: found.error.code };
  const items = found.result.json?.results ?? [];
  anlyon.log(\`\${items.length} found\`);
  return { count: items.length, first: items[0] ?? null };
}
`,
			python: `# Reads only: a plan run of this needs no approval.
async def run(input, anlyon):
    found = await anlyon.read("search-records", {"query": input["query"]})
    if not found["ok"]:
        return {"error": found["error"]["code"]}
    items = (found["result"]["json"] or {}).get("results", [])
    anlyon.log(f"{len(items)} found")
    return {"count": len(items), "first": items[0] if items else None}
`,
		},
	},
	{
		id: "batch-with-cap",
		label: "Several writes, capped",
		description:
			"One write per item, never more than a cap. The approver sees every one.",
		source: {
			javascript: `// One write per item, never more than MAX. Each write is in the plan the approver sees.
const MAX = 10;

export default async function run(input, anlyon) {
  const items = (input.items ?? []).slice(0, MAX);
  let sent = 0;
  for (const item of items) {
    const result = await anlyon.invoke("update-record", { id: item.id, status: item.status });
    if (result.ok) sent += 1;
  }
  return { sent, skipped: (input.items?.length ?? 0) - items.length };
}
`,
			python: `# One write per item, never more than MAX. Each write is in the plan the approver sees.
MAX = 10


async def run(input, anlyon):
    items = (input.get("items") or [])[:MAX]
    sent = 0
    for item in items:
        result = await anlyon.invoke("update-record", {"id": item["id"], "status": item["status"]})
        if result["ok"]:
            sent += 1
    return {"sent": sent, "skipped": len(input.get("items") or []) - len(items)}
`,
		},
	},
];

export const SOURCE_FILE: Record<FunctionLanguage, string> = {
	javascript: "function.js",
	python: "function.py",
};

export interface StoredDraft {
	language: FunctionLanguage;
	source: string;
	baseVersion: number | null;
}

const DRAFT_PREFIX = "anlyon.function-draft.";

const draftKey = (workspaceId: string, name: string) =>
	`${DRAFT_PREFIX}${workspaceId}.${name}`;

export function loadDraft(
	workspaceId: string,
	name: string,
): StoredDraft | null {
	try {
		const raw = localStorage.getItem(draftKey(workspaceId, name));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<StoredDraft>;
		if (
			typeof parsed.source !== "string" ||
			(parsed.language !== "javascript" && parsed.language !== "python")
		) {
			return null;
		}
		return {
			language: parsed.language,
			source: parsed.source,
			baseVersion:
				typeof parsed.baseVersion === "number" ? parsed.baseVersion : null,
		};
	} catch {
		return null;
	}
}

export function saveDraft(
	workspaceId: string,
	name: string,
	draft: StoredDraft,
): void {
	try {
		localStorage.setItem(draftKey(workspaceId, name), JSON.stringify(draft));
	} catch {
	}
}

export function clearDraft(workspaceId: string, name: string): void {
	try {
		localStorage.removeItem(draftKey(workspaceId, name));
	} catch {
	}
}
