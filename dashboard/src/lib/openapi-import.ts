import type {
	Action,
	ActionImpactDeclaration,
	ActionMethod,
} from "@/lib/types";

export type ImportRisk = "read" | "write" | "irreversible" | "destructive";

export interface SuggestedImpact {
	dimension: string;
	unit: string | null;
	amount: string;
	bound: ActionImpactDeclaration["bound"];
}

export interface ImportSuggestion {
	risk: ImportRisk;
	reasons: string[];
	requiresApproval: boolean;
	impact: SuggestedImpact | null;
	impactNote: string | null;
}

export type ImpactInput = Omit<ActionImpactDeclaration, "unit"> & {
	unit?: string;
};

export interface ImportedOperation {
	name: string;
	method: ActionMethod;
	path: string;
	urlTemplate: string;
	warnings: string[];
	governed: boolean;
	impact: ImpactInput | null;
	requiresApproval: boolean;
	customized: boolean;
	suggestion: ImportSuggestion;
	proposedVerify: unknown;
	verifyNote: string | null;
	action?: Action;
}

export interface ImportResult {
	created: ImportedOperation[];
	skipped: Array<{ path: string; method: string; reason: string }>;
	dryRun: boolean;
	suggestedAllowedHosts: string[];
}

export interface OperationChoice {
	requiresApproval?: boolean;
	impact?: ImpactInput | null;
}

export interface ImportRequest {
	spec: Record<string, unknown>;
	baseUrl?: string;
	auth?: { headerName: string; secretName: string; valueTemplate?: string };
	dryRun?: boolean;
	only?: string[];
	operations?: Record<string, OperationChoice>;
}

export function operationKey(op: Pick<ImportedOperation, "method" | "path">) {
	return `${op.method} ${op.path}`;
}

export function parseSpec(
	text: string,
): { spec: Record<string, unknown> } | { error: string } {
	const trimmed = text.trim();
	if (!trimmed) return { error: "Paste an OpenAPI 3 document." };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return {
			error:
				"The console reads JSON. Convert a YAML spec to JSON first, or import it with the SDK or CLI.",
		};
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { error: "The spec must be a JSON object." };
	}
	const spec = parsed as Record<string, unknown>;
	if (typeof spec.openapi !== "string" || !spec.openapi.startsWith("3.")) {
		return {
			error:
				'Only OpenAPI 3.x is supported: the spec needs "openapi": "3.x.x".',
		};
	}
	return { spec };
}

export type ChoiceMode = "default" | "suggested" | "custom";
export type ImpactKind = "none" | "resource_mutations" | "money" | "declared";

export interface RowChoice {
	include: boolean;
	mode: ChoiceMode;
	requiresApproval: boolean;
	impactKind: ImpactKind;
	unit: string;
	amount: string;
	bound: ActionImpactDeclaration["bound"];
}

const DECLARED_UNIT = /^[a-z][a-z0-9_]{0,31}$/;

function kindOf(impact: { dimension: string } | null): ImpactKind {
	if (!impact) return "none";
	if (impact.dimension === "money" || impact.dimension === "resource_mutations")
		return impact.dimension;
	return "declared";
}

function valuesFrom(
	impact: SuggestedImpact | ImpactInput | null,
	requiresApproval: boolean,
): Omit<RowChoice, "include" | "mode"> {
	const impactKind = kindOf(impact);
	return {
		requiresApproval,
		impactKind,
		unit:
			impactKind === "money"
				? (impact?.unit ?? "").toUpperCase()
				: impactKind === "declared"
					? (impact?.dimension ?? "")
					: "",
		amount: impact?.amount ?? "1",
		bound: impact?.bound ?? "exact",
	};
}

export function defaultChoice(op: ImportedOperation): RowChoice {
	return {
		include: true,
		mode: "default",
		...valuesFrom(op.impact, op.requiresApproval),
	};
}

export function suggestedChoice(op: ImportedOperation): RowChoice {
	return {
		include: true,
		mode: "suggested",
		...valuesFrom(op.suggestion.impact, op.suggestion.requiresApproval),
	};
}

export function suggestionNeedsInput(op: ImportedOperation): boolean {
	return (
		op.suggestion.impact?.dimension === "money" &&
		op.suggestion.impact.unit === null
	);
}

export function rowImpact(
	row: RowChoice,
): { impact: ImpactInput | null } | { error: string } {
	if (row.impactKind === "none") return { impact: null };
	const amount = row.amount.trim();
	if (!amount)
		return {
			error: "Enter an amount, such as 1, input.amount or count(input.to).",
		};
	if (row.impactKind === "resource_mutations") {
		return {
			impact: {
				dimension: "resource_mutations",
				unit: "resource_mutations",
				amount,
				bound: row.bound,
			},
		};
	}
	const unit = row.unit.trim().toLowerCase();
	if (row.impactKind === "money") {
		if (!/^[a-z]{3}$/.test(unit))
			return { error: "Choose the currency this counts in, such as USD." };
		return { impact: { dimension: "money", unit, amount, bound: row.bound } };
	}
	if (!DECLARED_UNIT.test(unit))
		return {
			error:
				"Name the unit in lowercase letters, digits and underscores, such as emails.",
		};
	return { impact: { dimension: unit, unit, amount, bound: row.bound } };
}

export function importSelection(
	created: ImportedOperation[],
	rows: Record<string, RowChoice>,
):
	| { only: string[]; operations: Record<string, OperationChoice> }
	| { errors: Record<string, string> } {
	const only: string[] = [];
	const operations: Record<string, OperationChoice> = {};
	const errors: Record<string, string> = {};
	for (const op of created) {
		const key = operationKey(op);
		const row = rows[key] ?? defaultChoice(op);
		if (!row.include) continue;
		only.push(key);
		if (row.mode === "default") continue;
		const result = rowImpact(row);
		if ("error" in result) {
			errors[key] = result.error;
			continue;
		}
		operations[key] = {
			requiresApproval: row.requiresApproval,
			impact: result.impact,
		};
	}
	return Object.keys(errors).length > 0 ? { errors } : { only, operations };
}

export function describeImpact(row: RowChoice): string {
	if (row.impactKind === "none") return "Not governed";
	const upTo = row.bound === "upper_bound" ? "up to " : "";
	if (row.impactKind === "money") {
		return `${upTo}${row.amount} ${row.unit.trim() ? row.unit.toUpperCase() : "(choose a currency)"}`;
	}
	if (row.impactKind === "resource_mutations") {
		return row.amount === "1" && !upTo
			? "1 change"
			: `${upTo}${row.amount} changes`;
	}
	return `${upTo}${row.amount} ${row.unit}`;
}
