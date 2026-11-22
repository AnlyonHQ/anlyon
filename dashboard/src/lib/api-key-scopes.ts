import { type FeatureKey, isFeatureEnabled } from "@anlyon/feature-flags";

export const API_KEY_SCOPES = [
	"integrations:read",
	"integrations:write",
	"logs:read",
	"dlq:read",
	"dlq:write",
	"billing:read",
	"notifications:read",
	"notifications:write",
	"feedback:write",
	"analytics:read",
	"events:read",
	"events:write",
	"secrets:read",
	"secrets:write",
	"actions:read",
	"actions:write",
	"actions:invoke",
	"approvals:read",
	"approvals:write",
	"approvals:decide",
	"budgets:read",
	"budgets:write",
	"runs:read",
	"runs:write",
	"actions:govern",
	"actions:resolve",
	"environments:halt",
	"messages:ingest",
	"policies:read",
	"policies:write",
	"impact-limits:read",
	"impact-limits:write",
	"notifications:manage",
	"secret-stores:read",
	"secret-stores:write",
	"audit:read",
	"end-users:read",
	"end-users:write",
	"end-users:approvals",
	"functions:read",
	"functions:write",
	"functions:run",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

const SCOPE_FEATURES: Record<string, FeatureKey | undefined> = {
	actions: "actions",
	analytics: "analytics",
	approvals: "approvals",
	"end-users": "connected-accounts",
	dlq: "dlq",
	events: "events",
	functions: "functions",
	logs: "logs",
	policies: "approval-policies",
	"impact-limits": "actions",
	runs: "runs",
};

export const OFFERED_SCOPES: ApiKeyScope[] = API_KEY_SCOPES.filter((scope) => {
	const feature = SCOPE_FEATURES[scope.split(":")[0]];
	return !feature || isFeatureEnabled(feature);
});

const LEGACY_RESOURCES = new Set<string>(["messages", "dlq", "integrations"]);

export function isLegacyScope(scope: string): boolean {
	return LEGACY_RESOURCES.has(scope.split(":")[0]);
}

export interface ScopeGroup {
	resource: string;
	scopes: ApiKeyScope[];
}

function groupByResource(scopes: readonly ApiKeyScope[]): ScopeGroup[] {
	const byResource = new Map<string, ApiKeyScope[]>();
	for (const scope of scopes) {
		const resource = scope.split(":")[0];
		const list = byResource.get(resource) ?? [];
		list.push(scope);
		byResource.set(resource, list);
	}
	return [...byResource.entries()].map(([resource, scopes]) => ({
		resource,
		scopes,
	}));
}

export const SCOPE_GROUPS: ScopeGroup[] = groupByResource(
	OFFERED_SCOPES.filter((scope) => !isLegacyScope(scope)),
);

export const ALL_SCOPES: ApiKeyScope[] = OFFERED_SCOPES.filter(
	(scope) => !isLegacyScope(scope),
);

const PRIVILEGED_SCOPES = new Set<string>([
	"secrets:read",
	"secrets:write",
	"approvals:decide",
	"integrations:read",
	"integrations:write",
	"budgets:read",
	"budgets:write",
	"actions:govern",
	"actions:resolve",
	"environments:halt",
	"messages:ingest",
	"policies:read",
	"policies:write",
	"impact-limits:write",
	"notifications:manage",
	"secret-stores:read",
	"secret-stores:write",
	"audit:read",
	"end-users:read",
	"end-users:write",
	"end-users:approvals",
	"functions:read",
	"functions:write",
	"functions:run",
]);

export const STANDARD_SCOPES: ApiKeyScope[] = ALL_SCOPES.filter(
	(scope) => !PRIVILEGED_SCOPES.has(scope),
);

export const READ_ONLY_SCOPES: ApiKeyScope[] = ALL_SCOPES.filter((scope) =>
	scope.endsWith(":read"),
);

export function presetForSelection(
	selected: readonly string[],
): "full" | "standard" | "read-only" | "custom" {
	const set = new Set(selected);
	if (set.size === ALL_SCOPES.length && ALL_SCOPES.every((s) => set.has(s)))
		return "full";
	if (
		set.size === STANDARD_SCOPES.length &&
		STANDARD_SCOPES.every((s) => set.has(s))
	)
		return "standard";
	if (
		set.size === READ_ONLY_SCOPES.length &&
		READ_ONLY_SCOPES.every((s) => set.has(s))
	)
		return "read-only";
	return "custom";
}
