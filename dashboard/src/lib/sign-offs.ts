import type { ActorLabel, ActorRef } from "./actor-label";

export type SignOffStatus =
	| "pending"
	| "applied"
	| "rejected"
	| "expired"
	| "cancelled"
	| "failed";

export type SignOffDirection = "loosening" | "tightening" | "neutral";

export interface SignOffChange {
	field: string;
	from: unknown;
	to: unknown;
	direction: SignOffDirection;
	reason?: string | null;
}

export interface SignOffRequest {
	object: "sign_off_request";
	id: string;
	status: SignOffStatus;
	operation: string;
	environmentId: string | null;
	resource: { type: string; id: string; name?: string | null } | null;
	summary: string;
	changes: SignOffChange[];
	diff: string;
	signOffUrl?: string;
	requestedBy: {
		type: "api_key" | "oauth_client" | (string & {});
		id: string;
		onBehalfOf: string | null;
	};
	createdAt: string;
	expiresAt: string;
	decidedAt: string | null;
	decidedBy: {
		type: "user";
		id: string;
		via: "console" | "email_link" | (string & {});
	} | null;
	decisionNote: string | null;
	result: unknown;
	error: { code: string; message: string } | null;
}

export const SIGN_OFF_STATUS_LABEL: Record<SignOffStatus, string> = {
	pending: "Waiting",
	applied: "Applied",
	rejected: "Rejected",
	expired: "Expired",
	cancelled: "Withdrawn",
	failed: "Failed",
};

export const SIGN_OFF_FILTERS = [
	"pending",
	"applied",
	"rejected",
	"failed",
	"expired",
	"cancelled",
	"all",
] as const;
export type SignOffFilter = (typeof SIGN_OFF_FILTERS)[number];

export function parseSignOffFilter(value: unknown): SignOffFilter {
	return typeof value === "string" &&
		(SIGN_OFF_FILTERS as readonly string[]).includes(value)
		? (value as SignOffFilter)
		: "pending";
}

export function isSignOffStatus(value: unknown): value is SignOffStatus {
	return typeof value === "string" && value in SIGN_OFF_STATUS_LABEL;
}

export function isDecidable(
	signOff: Pick<SignOffRequest, "status" | "expiresAt">,
	now: number = Date.now(),
): boolean {
	if (signOff.status !== "pending") return false;
	const expires = new Date(signOff.expiresAt).getTime();
	return Number.isNaN(expires) || expires > now;
}

export function loosens(signOff: Pick<SignOffRequest, "changes">): boolean {
	return signOff.changes.some((change) => change.direction === "loosening");
}

export function formatChangeValue(value: unknown): string {
	if (value === null || value === undefined || value === "") return "none";
	if (typeof value === "number") return value.toLocaleString();
	if (typeof value === "boolean") return value ? "on" : "off";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function describeRequester(
	requestedBy: SignOffRequest["requestedBy"],
	nameOf: (actor: ActorRef) => ActorLabel,
): ActorLabel {
	const forUser = requestedBy.onBehalfOf
		? nameOf({ type: "user", id: requestedBy.onBehalfOf }).text
		: null;
	if (requestedBy.type === "api_key") {
		const key = nameOf({ type: "api_key", id: requestedBy.id });
		return {
			text: forUser ? `${key.text}, acting for ${forUser}` : key.text,
			title: key.title,
		};
	}
	if (requestedBy.type === "oauth_client") {
		return {
			text: forUser
				? `An app acting for ${forUser}`
				: "An app (a CLI login or an MCP session)",
			title: requestedBy.id,
		};
	}
	return { text: requestedBy.type, title: requestedBy.id };
}

export function diffLineKind(line: string): "removed" | "added" | "context" {
	if (line.startsWith("-")) return "removed";
	if (line.startsWith("+")) return "added";
	return "context";
}
