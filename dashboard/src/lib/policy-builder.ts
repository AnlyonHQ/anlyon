import { moneyField } from "@/lib/action-summary";
import type { Action } from "@/lib/types";

export type FieldKind =
	| "number"
	| "money"
	| "text"
	| "choice"
	| "list"
	| "flag";

export interface BuilderField {
	name: string;
	kind: FieldKind;
	integer: boolean;
	options: string[];
}

export interface BuilderOperator {
	op: ">" | ">=" | "<" | "<=" | "==" | "!=";
	label: string;
}

const NUMERIC: BuilderOperator[] = [
	{ op: ">", label: "is more than" },
	{ op: ">=", label: "is at least" },
	{ op: "<", label: "is less than" },
	{ op: "<=", label: "is at most" },
	{ op: "==", label: "is exactly" },
];
const EQUALITY: BuilderOperator[] = [
	{ op: "==", label: "is" },
	{ op: "!=", label: "is not" },
];
const COUNT: BuilderOperator[] = [
	{ op: ">", label: "has more than" },
	{ op: ">=", label: "has at least" },
	{ op: "<", label: "has fewer than" },
	{ op: "==", label: "has exactly" },
];

export const OPERATORS: Record<FieldKind, BuilderOperator[]> = {
	number: NUMERIC,
	money: NUMERIC,
	text: EQUALITY,
	choice: EQUALITY,
	list: COUNT,
	flag: [{ op: "==", label: "is" }],
};

export function builderFields(
	action: Pick<Action, "inputSchema" | "impact"> | undefined,
): BuilderField[] {
	if (!action) return [];
	const properties = (
		action.inputSchema as {
			properties?: Record<string, Record<string, unknown>>;
		}
	)?.properties;
	if (!properties) return [];
	const money = moneyField(action);
	const fields: BuilderField[] = [];
	for (const [name, schema] of Object.entries(properties)) {
		const type = schema.type;
		const options = Array.isArray(schema.enum) ? schema.enum.map(String) : [];
		if (name === money && (type === "integer" || type === "number")) {
			fields.push({ name, kind: "money", integer: true, options: [] });
		} else if (type === "integer" || type === "number") {
			fields.push({
				name,
				kind: "number",
				integer: type === "integer",
				options: [],
			});
		} else if (type === "string") {
			fields.push({
				name,
				kind: options.length > 0 ? "choice" : "text",
				integer: false,
				options,
			});
		} else if (type === "array") {
			fields.push({ name, kind: "list", integer: true, options: [] });
		} else if (type === "boolean") {
			fields.push({
				name,
				kind: "flag",
				integer: false,
				options: ["true", "false"],
			});
		}
	}
	return fields;
}

export interface BuilderState {
	field: string;
	op: BuilderOperator["op"];
	value: string;
}

export function buildCondition(
	field: BuilderField,
	op: BuilderOperator["op"],
	value: string,
): string | null {
	const raw = value.trim();
	if (!raw) return null;
	if (!OPERATORS[field.kind].some((o) => o.op === op)) return null;
	switch (field.kind) {
		case "money": {
			if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) return null;
			const minor = Math.round(Number(raw) * 100);
			return `input.${field.name} ${op} ${minor}`;
		}
		case "number": {
			const pattern = field.integer ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/;
			if (!pattern.test(raw)) return null;
			return `input.${field.name} ${op} ${raw}`;
		}
		case "list":
			if (!/^\d+$/.test(raw)) return null;
			return `size(input.${field.name}) ${op} ${raw}`;
		case "flag":
			if (raw !== "true" && raw !== "false") return null;
			return `input.${field.name} == ${raw}`;
		case "text":
		case "choice":
			if (raw.includes('"') || raw.includes("\\")) return null;
			return `input.${field.name} ${op} "${raw}"`;
	}
}

export function parseCondition(
	condition: string | null | undefined,
	fields: BuilderField[],
): BuilderState | null {
	const text = condition?.trim();
	if (!text) return null;
	const byName = new Map(fields.map((f) => [f.name, f]));

	const count = /^size\(input\.(\w+)\)\s*(>=|<=|==|>|<)\s*(\d+)$/.exec(text);
	if (count) {
		const [, name, op, value] = count;
		const field = byName.get(name ?? "");
		if (!field || field.kind !== "list" || !value) return null;
		return { field: field.name, op: op as BuilderOperator["op"], value };
	}

	const number = /^input\.(\w+)\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(
		text,
	);
	if (number) {
		const [, name, op, value] = number;
		const field = byName.get(name ?? "");
		if (!field || !value || !OPERATORS[field.kind].some((o) => o.op === op))
			return null;
		if (field.kind === "money") {
			if (!/^-?\d+$/.test(value)) return null;
			return {
				field: field.name,
				op: op as BuilderOperator["op"],
				value: (Number(value) / 100).toFixed(2),
			};
		}
		if (field.kind !== "number") return null;
		return { field: field.name, op: op as BuilderOperator["op"], value };
	}

	const flag = /^input\.(\w+)\s*==\s*(true|false)$/.exec(text);
	if (flag) {
		const [, name, value] = flag;
		const field = byName.get(name ?? "");
		if (!field || field.kind !== "flag" || !value) return null;
		return { field: field.name, op: "==", value };
	}

	const quoted = /^input\.(\w+)\s*(==|!=)\s*(?:"([^"\\]*)"|'([^'\\]*)')$/.exec(
		text,
	);
	if (quoted) {
		const [, name, op, double, single] = quoted;
		const field = byName.get(name ?? "");
		if (!field || (field.kind !== "text" && field.kind !== "choice"))
			return null;
		return {
			field: field.name,
			op: op as BuilderOperator["op"],
			value: double ?? single ?? "",
		};
	}
	return null;
}
