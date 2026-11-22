import type { Approval } from "@/lib/types";

export type Urgency = "overdue" | "critical" | "soon" | "later";

const CRITICAL_MS = 15 * 60_000;
const SOON_MS = 2 * 3_600_000;

export const SELF_APPROVED_LABEL =
	"Self-approved (only approver in this environment)";

export function msLeft(approval: Approval, now: number = Date.now()): number {
	return new Date(approval.expiresAt).getTime() - now;
}

export function urgencyOf(
	approval: Approval,
	now: number = Date.now(),
): Urgency {
	const ms = msLeft(approval, now);
	if (ms <= 0) return "overdue";
	if (ms <= CRITICAL_MS) return "critical";
	if (ms <= SOON_MS) return "soon";
	return "later";
}

export function formatTimeLeft(ms: number): string {
	if (ms <= 0) return "overdue";

	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rem = minutes % 60;
		return rem ? `${hours}h ${rem}m` : `${hours}h`;
	}

	const days = Math.floor(hours / 24);
	const rem = hours % 24;
	return rem ? `${days}d ${rem}h` : `${days}d`;
}

export function sortForInbox(approvals: Approval[]): Approval[] {
	return [...approvals].sort((a, b) => {
		if (a.status === "pending" && b.status === "pending") {
			const diff =
				new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime();
			return diff !== 0 ? diff : a.id.localeCompare(b.id);
		}
		const aDecided = new Date(a.decidedAt ?? a.createdAt).getTime();
		const bDecided = new Date(b.decidedAt ?? b.createdAt).getTime();
		const diff = bDecided - aDecided;
		return diff !== 0 ? diff : a.id.localeCompare(b.id);
	});
}

export interface PayloadSummary {
	method?: string;
	target?: string;
	amount?: number;
	destructive: boolean;
}

function readAmount(source: unknown): number | undefined {
	if (typeof source !== "object" || source === null) return undefined;
	const amount = (source as Record<string, unknown>).amount;
	return typeof amount === "number" ? amount : undefined;
}

export function summarizePayload(approval: Approval): PayloadSummary {
	const p = approval.payload ?? {};
	const method =
		typeof p.method === "string" ? p.method.toUpperCase() : undefined;
	const actionName =
		typeof p.actionName === "string" ? p.actionName : undefined;
	const urlTemplate =
		typeof p.urlTemplate === "string" ? p.urlTemplate : undefined;

	return {
		method,
		target: actionName ?? urlTemplate,
		amount: readAmount(p.input) ?? readAmount(p),
		destructive: method === "DELETE",
	};
}

export function isActionable(approval: Approval): boolean {
	return approval.status === "pending";
}

export function destinationHost(approval: Approval): string | undefined {
	const template = approval.payload?.urlTemplate;
	if (typeof template !== "string") return undefined;
	try {
		return new URL(template.replace(/\{\{[^}]+\}\}/g, "x")).host;
	} catch {
		return undefined;
	}
}

export interface PayloadField {
	key: string;
	value: string;
}

export function payloadFields(
	approval: Approval,
	{ maxDepth = 3, maxFields = 40 } = {},
): { fields: PayloadField[]; truncated: boolean } {
	const p = approval.payload ?? {};
	const source =
		approval.kind === "action" && "input" in p ? p.input : (p as unknown);
	const fields: PayloadField[] = [];
	let truncated = false;

	const walk = (value: unknown, path: string, depth: number) => {
		if (fields.length >= maxFields) {
			truncated = true;
			return;
		}
		if (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			depth < maxDepth
		) {
			const entries = Object.entries(value as Record<string, unknown>);
			if (entries.length === 0 && path) fields.push({ key: path, value: "{}" });
			for (const [k, v] of entries)
				walk(v, path ? `${path}.${k}` : k, depth + 1);
			return;
		}
		if (!path) {
			fields.push({ key: "value", value: JSON.stringify(value) ?? "null" });
			return;
		}
		fields.push({
			key: path,
			value:
				typeof value === "string" ? value : (JSON.stringify(value) ?? "null"),
		});
	};

	if (source !== undefined) walk(source, "", 0);
	return { fields, truncated };
}

export interface InboxGroup {
	id: string;
	label: string;
	rows: Approval[];
}

const URGENCY_GROUP_LABEL: Record<Urgency, string> = {
	overdue: "Past expiry",
	critical: "Expiring in 15 minutes",
	soon: "Within 2 hours",
	later: "Later",
};

export function groupForInbox(
	rows: Approval[],
	now: number = Date.now(),
): InboxGroup[] {
	const groups = new Map<string, InboxGroup>();
	const dayFormatter = new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
	});
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	for (const row of rows) {
		let id: string;
		let label: string;
		if (row.status === "pending") {
			const urgency = urgencyOf(row, now);
			id = urgency;
			label = URGENCY_GROUP_LABEL[urgency];
		} else {
			const at = new Date(row.decidedAt ?? row.createdAt);
			const day = new Date(at);
			day.setHours(0, 0, 0, 0);
			const daysAgo = Math.round(
				(today.getTime() - day.getTime()) / 86_400_000,
			);
			id = `day-${day.toISOString()}`;
			label =
				daysAgo === 0
					? "Today"
					: daysAgo === 1
						? "Yesterday"
						: dayFormatter.format(at);
		}
		const group = groups.get(id) ?? { id, label, rows: [] };
		group.rows.push(row);
		groups.set(id, group);
	}
	return [...groups.values()];
}

export function formatAgo(iso: string, now: number = Date.now()): string {
	const ms = now - new Date(iso).getTime();
	if (ms < 60_000) return "just now";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}
