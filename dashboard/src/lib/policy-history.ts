import { describePolicyMatch } from "@/lib/policy-targeting";
import type {
	ApprovalPolicy,
	ApprovalPolicyEffect,
	ApprovalPolicyVersion,
} from "@/lib/types";

export const OPERATION_LABEL: Record<
	ApprovalPolicyVersion["operation"],
	string
> = {
	created: "Created",
	updated: "Updated",
	deleted: "Deleted",
	baseline: "Baseline",
};

const text = (value: unknown) => (typeof value === "string" ? value : null);
const number = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

export interface VersionSummary {
	name: string | null;
	effect: ApprovalPolicyEffect | null;
	requiredApprovals: number | null;
	priority: number | null;
	enabled: boolean | null;
	appliesTo: string;
}

export function summarizeSnapshot(
	snapshot: Record<string, unknown>,
): VersionSummary {
	const kind = text(snapshot.match_kind);
	const match: ApprovalPolicy["match"] = {
		kind: kind === "any" || kind === "custom" ? kind : "action",
		actionName: text(snapshot.match_action_name),
		agentId: text(snapshot.match_agent_id),
		userId: text(snapshot.match_user_id),
		tags: Array.isArray(snapshot.match_tags)
			? snapshot.match_tags.filter(
					(tag): tag is string => typeof tag === "string",
				)
			: null,
		minAmount:
			number(snapshot.min_amount) ??
			(typeof snapshot.min_amount === "string" &&
			Number.isFinite(Number(snapshot.min_amount))
				? Number(snapshot.min_amount)
				: null),
		conditions:
			snapshot.conditions && typeof snapshot.conditions === "object"
				? (snapshot.conditions as Record<string, unknown>)
				: null,
		condition: text(snapshot.condition),
	};
	const effect = text(snapshot.effect);
	return {
		name: text(snapshot.name),
		effect:
			effect === "require_approval" ||
			effect === "auto_approve" ||
			effect === "auto_deny"
				? effect
				: null,
		requiredApprovals: number(snapshot.required_approvals),
		priority: number(snapshot.priority),
		enabled: typeof snapshot.enabled === "boolean" ? snapshot.enabled : null,
		appliesTo: describePolicyMatch({ match }),
	};
}

export function locateVersion(
	loaded: ApprovalPolicyVersion[],
	earliestVersion: number | undefined,
	version: number,
): "loaded" | "before_history" | "elsewhere" {
	if (loaded.some((entry) => entry.version === version)) return "loaded";
	if (earliestVersion !== undefined && version < earliestVersion)
		return "before_history";
	return "elsewhere";
}
