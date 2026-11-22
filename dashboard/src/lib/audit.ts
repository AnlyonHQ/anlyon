export type AuditSinkType = "webhook" | "s3" | "datadog" | "splunk";

export interface AuditSink {
	sinkId: string;
	name: string;
	type: AuditSinkType;
	config: Record<string, unknown>;
	credentialsHint: string | null;
	enabled: boolean;
	eventTypes: string[];
	environmentIds: string[] | null;
	includeHistory: boolean;
	status: "active" | "retrying" | "disabled";
	attempts: number;
	nextAttemptAt: string;
	lastError: string | null;
	lastAttemptAt: string | null;
	lastSuccessAt: string | null;
	deliveredCount: number;
	openDeadLetters: number;
	createdAt: string;
	updatedAt: string;
	signingSecret?: string;
}

export interface AuditDeadLetter {
	id: string;
	eventCount: number;
	firstEventId: string;
	lastEventId: string;
	attempts: number;
	lastError: string | null;
	createdAt: string;
	lastRetryAt: string | null;
	redeliveredAt: string | null;
}

export interface AuditSendResult {
	ok: boolean;
	status: number | null;
	error: string | null;
	durationMs: number;
	location?: string;
}

export interface AuditSettings {
	retentionDays: number | null;
	planRetentionMonths?: number | null;
	retentionGraceUntil?: string | null;
	hotDays?: number;
	archiveAvailable?: boolean;
	allowPrivateDestinations: boolean;
	privateDestinationsAvailable: boolean;
	minRetentionDays: number;
	maxRetentionDays: number;
	schema: string;
	updatedAt: string | null;
}

export interface AuditEvent {
	schema: string;
	id: string;
	sequence: number;
	type: string;
	category: string;
	occurredAt: string;
	workspaceId: string;
	environmentId: string | null;
	actor: { type: string; id: string | null; onBehalfOf?: string | null };
	resource: { type: string; id: string } | null;
	outcome: string | null;
	data: Record<string, unknown>;
}

export const SINK_TYPE_LABEL: Record<AuditSinkType, string> = {
	webhook: "HTTPS webhook",
	s3: "S3-compatible bucket",
	datadog: "Datadog Logs",
	splunk: "Splunk HEC",
};

export const DATADOG_SITES = [
	"datadoghq.com",
	"us3.datadoghq.com",
	"us5.datadoghq.com",
	"datadoghq.eu",
	"ap1.datadoghq.com",
	"ap2.datadoghq.com",
	"ddog-gov.com",
] as const;

export const RETENTION_CHOICES: Array<{ value: number | null; label: string }> =
	[
		{ value: null, label: "As long as the plan allows" },
		{ value: 90, label: "90 days" },
		{ value: 180, label: "180 days" },
		{ value: 365, label: "1 year" },
		{ value: 730, label: "2 years" },
		{ value: 2555, label: "7 years" },
	];

export interface SinkForm {
	name: string;
	type: AuditSinkType;
	records: RecordsSelection;
	url: string;
	bucket: string;
	region: string;
	endpoint: string;
	prefix: string;
	accessKeyId: string;
	secretAccessKey: string;
	site: string;
	service: string;
	apiKey: string;
	index: string;
	sourcetype: string;
	token: string;
	startFrom: "now" | "beginning";
	includeHistory: boolean;
}

export const EMPTY_SINK_FORM: SinkForm = {
	name: "",
	type: "webhook",
	records: { mode: "all" },
	url: "",
	bucket: "",
	region: "",
	endpoint: "",
	prefix: "",
	accessKeyId: "",
	secretAccessKey: "",
	site: "datadoghq.com",
	service: "",
	apiKey: "",
	index: "",
	sourcetype: "",
	token: "",
	startFrom: "now",
	includeHistory: false,
};

export const SINK_DEFAULTS: Record<AuditSinkType, Partial<SinkForm>> = {
	webhook: {},
	s3: { prefix: "anlyon-audit" },
	datadog: { site: "datadoghq.com", service: "anlyon" },
	splunk: { sourcetype: "anlyon:audit" },
};

export function withSinkType(form: SinkForm, type: AuditSinkType): SinkForm {
	return {
		...EMPTY_SINK_FORM,
		name: form.name,
		records: form.records,
		startFrom: form.startFrom,
		includeHistory: form.includeHistory,
		...SINK_DEFAULTS[type],
		type,
	};
}

export const RECORD_CATEGORIES = [
	{ id: "approvals", label: "Approvals", patterns: ["approval.*"] },
	{
		id: "actions",
		label: "Actions",
		description: "Invocations and changes to action definitions",
		patterns: ["action.*"],
	},
	{ id: "policies", label: "Policies", patterns: ["policy.*"] },
	{
		id: "members",
		label: "Members",
		description: "Members, invitations, groups and emergency access",
		patterns: ["member.*", "invitation.*", "group.*", "workspace.*"],
	},
	{ id: "keys", label: "API keys", patterns: ["api_key.*"] },
	{
		id: "sso",
		label: "Single sign-on and directory",
		patterns: ["sso.*", "scim.*"],
	},
	{
		id: "environments",
		label: "Environment halts",
		patterns: ["environment.*"],
	},
	{ id: "connections", label: "Connections", patterns: ["secret.*"] },
	{
		id: "limits",
		label: "Limits and budgets",
		patterns: ["impact_limit.*", "budget.*"],
	},
	{ id: "audit", label: "Audit settings", patterns: ["audit.*"] },
	{ id: "instance", label: "Instance settings", patterns: ["instance.*"] },
] as const;

export type RecordCategoryId = (typeof RECORD_CATEGORIES)[number]["id"];

export type RecordsSelection =
	| { mode: "all" }
	| { mode: "categories"; categories: RecordCategoryId[] }
	| { mode: "custom"; text: string };

export function recordsToEventTypes(records: RecordsSelection): string[] {
	if (records.mode === "all") return ["*"];
	if (records.mode === "custom") return parseEventTypes(records.text);
	const patterns = RECORD_CATEGORIES.filter((category) =>
		records.categories.includes(category.id),
	).flatMap((category) => [...category.patterns]);
	return patterns.length > 0 ? patterns : ["*"];
}

export function eventTypesToRecords(eventTypes: string[]): RecordsSelection {
	if (eventTypes.length === 0 || eventTypes.includes("*"))
		return { mode: "all" };
	const remaining = new Set(eventTypes);
	const categories: RecordCategoryId[] = [];
	for (const category of RECORD_CATEGORIES) {
		if (category.patterns.every((pattern) => remaining.has(pattern))) {
			categories.push(category.id);
			for (const pattern of category.patterns) remaining.delete(pattern);
		}
	}
	if (remaining.size === 0) return { mode: "categories", categories };
	return { mode: "custom", text: eventTypes.join(", ") };
}

export function describeRecords(eventTypes: string[]): string {
	const records = eventTypesToRecords(eventTypes);
	if (records.mode === "all") return "All records";
	const labels =
		records.mode === "categories"
			? RECORD_CATEGORIES.filter((category) =>
					records.categories.includes(category.id),
				).map((category) => category.label)
			: [
					...new Set(
						eventTypes.map(
							(pattern) =>
								RECORD_CATEGORIES.find((category) =>
									(category.patterns as readonly string[]).includes(pattern),
								)?.label ?? eventLabel(pattern.replace(/\.\*$/, "")),
						),
					),
				];
	return labels.length <= 2
		? labels.join(" and ")
		: `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

export function describeEnvironments(
	environmentIds: string[] | null,
	environments: Array<{ id: string; name: string }> = [],
): string {
	if (!environmentIds) return "All environments";
	const names = environmentIds.map(
		(id) => environments.find((environment) => environment.id === id)?.name,
	);
	if (names.every(Boolean)) return names.join(", ");
	return `${environmentIds.length} ${environmentIds.length === 1 ? "environment" : "environments"}`;
}

export type SinkHealth = "delivering" | "paused" | "failing";

export function sinkHealth(
	sink: Pick<AuditSink, "status" | "enabled" | "openDeadLetters">,
): SinkHealth {
	if (!sink.enabled || sink.status === "disabled") return "paused";
	if (sink.status === "retrying" || sink.openDeadLetters > 0) return "failing";
	return "delivering";
}

export const SINK_HEALTH_LABEL: Record<SinkHealth, string> = {
	delivering: "Delivering",
	paused: "Paused",
	failing: "Failing",
};

export function sinkHost(sink: Pick<AuditSink, "type" | "config">): string {
	const config = sink.config as Record<string, string | undefined>;
	const host = (value?: string) => {
		if (!value) return "";
		try {
			return new URL(value).host;
		} catch {
			return value;
		}
	};
	switch (sink.type) {
		case "webhook":
		case "splunk":
			return host(config.url);
		case "s3":
			return config.endpoint
				? `${config.bucket ?? ""} on ${host(config.endpoint)}`
				: `${config.bucket ?? ""} (${config.region ?? "S3"})`;
		case "datadog":
			return config.site ?? "";
	}
}

function compact(values: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(values)
			.map(([key, value]) => [key, value.trim()] as const)
			.filter(([, value]) => value !== ""),
	);
}

export function parseEventTypes(text: string): string[] {
	const parts = text
		.split(/[\s,]+/)
		.map((part) => part.trim())
		.filter(Boolean);
	return parts.length > 0 ? parts : ["*"];
}

export function sinkRequest(form: SinkForm) {
	const base = {
		name: form.name.trim(),
		type: form.type,
		eventTypes: recordsToEventTypes(form.records),
		startFrom: form.startFrom,
		includeHistory: form.includeHistory,
	};
	switch (form.type) {
		case "webhook":
			return { ...base, config: compact({ url: form.url }) };
		case "s3":
			return {
				...base,
				config: compact({
					bucket: form.bucket,
					region: form.region,
					endpoint: form.endpoint,
					prefix: form.prefix,
				}),
				credentials: compact({
					accessKeyId: form.accessKeyId,
					secretAccessKey: form.secretAccessKey,
				}),
			};
		case "datadog":
			return {
				...base,
				config: compact({ site: form.site, service: form.service }),
				credentials: compact({ apiKey: form.apiKey }),
			};
		case "splunk":
			return {
				...base,
				config: compact({
					url: form.url,
					index: form.index,
					sourcetype: form.sourcetype,
				}),
				credentials: compact({ token: form.token }),
			};
	}
}

export function sinkDestination(
	sink: Pick<AuditSink, "type" | "config">,
): string {
	const config = sink.config as Record<string, string | undefined>;
	switch (sink.type) {
		case "webhook":
			return config.url ?? "";
		case "s3":
			return `${config.endpoint ? `${config.endpoint} ` : ""}s3://${config.bucket ?? ""}/${config.prefix ?? "anlyon-audit"}`;
		case "datadog":
			return config.site ?? "";
		case "splunk":
			return config.url ?? "";
	}
}

export interface ExportFilter {
	from: string;
	to: string;
	format: "json" | "csv";
	environmentId?: string;
	type?: string;
	action?: string;
}

export function exportPath(workspaceId: string, filter: ExportFilter): string {
	const toExclusive = new Date(`${filter.to}T00:00:00.000Z`);
	toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
	const params = new URLSearchParams({
		from: new Date(`${filter.from}T00:00:00.000Z`).toISOString(),
		to: toExclusive.toISOString(),
		format: filter.format,
	});
	if (filter.environmentId) params.set("environmentId", filter.environmentId);
	if (filter.type?.trim()) params.set("type", filter.type.trim());
	if (filter.action?.trim()) params.set("action", filter.action.trim());
	return `/workspaces/${workspaceId}/audit/export?${params.toString()}`;
}

export function actorLabel(
	actor: AuditEvent["actor"],
	names: Record<string, string> = {},
): string {
	switch (actor.type) {
		case "user":
			return actor.id ? (names[actor.id] ?? "A member") : "A member";
		case "api_key":
			return actor.id ? `API key ${actor.id.slice(0, 8)}` : "API key";
		case "oauth_client":
			return actor.id ? `App ${actor.id}` : "App";
		case "assistant":
			return "Vigil";
		case "policy":
			return actor.id ? `Policy ${actor.id}` : "Policy";
		default:
			return "Anlyon";
	}
}

const EVENT_WORDS: Record<string, string> = {
	api_key: "API key",
	sso: "SSO",
	scim: "Directory sync",
	impact_limit: "Impact limit",
	dead_letter: "dead letter",
};

export function eventLabel(type: string): string {
	const words = type
		.split(".")
		.map((part) => EVENT_WORDS[part] ?? part.replace(/_/g, " "))
		.join(" ")
		.trim();
	return words ? words.charAt(0).toUpperCase() + words.slice(1) : type;
}
