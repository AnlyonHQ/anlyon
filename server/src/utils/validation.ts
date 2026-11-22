import { z } from "zod";
import { legacyDatetime } from "./zod-compat.ts";
import { ALL_API_KEY_SCOPES } from "../core/auth/api-key-scopes.ts";
import { ROLES } from "../core/workspace/permissions.ts";
import {
	ACTING_FOR as DEFAULTS_ACTING_FOR,
	DECIDERS,
	DEFAULTS_SOURCES,
	MAX_APPROVAL_WINDOW_HOURS,
	MIN_APPROVAL_WINDOW_HOURS,
	SETUP_STATUSES,
} from "../core/workspace/defaults-shape.ts";
import { actionInvocationStatusEnum } from "../db/schema/actions.ts";
import { ACTING_FOR } from "../core/end-users/acting-for.ts";
import { validateUrl } from "./url-validation.ts";

export const httpMethodSchema = z.enum([
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
]);

const ssrfSafeUrl = (message = "Invalid or disallowed URL") =>
	z
		.string()
		.url("Invalid URL format")
		.refine((val) => validateUrl(val).valid, {
			error: (issue) => validateUrl(String(issue.input)).error || message,
		});

const SECRET_REF_PATTERN = /\{\{\s*secret:[A-Z0-9_]+\s*\}\}/;

const reservedDeliveryHeaders = new Set([
	"content-type",
	"anlyon-message-id",
	"x-idempotency-key",
	"x-delivery-attempt",
	"anlyon-signature",
	"anlyon-timestamp",
	"x-anlyon-workspace-id",
	"x-anlyon-environment-id",
]);

const credentialHeaders = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"x-api-key",
	"api-key",
	"x-auth-token",
	"x-access-token",
]);

const framingHeaders = new Set([
	"host",
	"content-length",
	"transfer-encoding",
	"connection",
	"upgrade",
	"expect",
	"te",
	"keep-alive",
	"proxy-connection",
]);
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;

const customHeadersSchema = z
	.record(z.string(), z.string().max(8192))
	.refine(
		(headers) =>
			Object.entries(headers).every(
				([name, value]) => headerNamePattern.test(name) && !/[\r\n\0]/.test(value),
			),
		"A header name is a token and a header value has no line breaks",
	)
	.refine(
		(headers) => Object.keys(headers).every((name) => !framingHeaders.has(name.toLowerCase())),
		"Host, Content-Length, Transfer-Encoding and connection headers are set by the sender and cannot be given",
	)
	.refine(
		(headers) =>
			Object.keys(headers).every(
				(name) => !reservedDeliveryHeaders.has(name.toLowerCase()),
			),
		"Headers reserved by Anlyon delivery signing cannot be overridden",
	)
	.refine(
		(headers) =>
			Object.entries(headers).every(
				([name, value]) =>
					!credentialHeaders.has(name.toLowerCase()) || SECRET_REF_PATTERN.test(value),
			),
		"A credential header must reference a vaulted secret, as {{secret:NAME}}, rather than carrying the value directly. " +
			"Store it with PUT /secrets/{name} and reference it here.",
	);

export const createWorkspaceSchema = z.object({
	name: z.string().min(1).max(100),
	slug: z
		.string()
		.min(3)
		.max(50)
		.regex(/^[a-z0-9-]+$/)
		.optional(),
});

export const updateWorkspaceSchema = z.object({
	name: z.string().min(1).max(100).optional(),
});

export const updateWorkspaceDefaultsSchema = z
	.object({
		actingFor: z.enum(DEFAULTS_ACTING_FOR).nullable().optional(),
		endUserDecider: z.enum(DECIDERS).nullable().optional(),
		approvalWindowHours: z
			.number()
			.int()
			.min(MIN_APPROVAL_WINDOW_HOURS)
			.max(MAX_APPROVAL_WINDOW_HOURS)
			.nullable()
			.optional(),
		setupStatus: z.enum(SETUP_STATUSES).optional(),
		source: z.enum(DEFAULTS_SOURCES).optional(),
	})
	.strict()
	.refine((body) => Object.keys(body).some((key) => key !== "source"), {
		message: "Send at least one field.",
	});

export const inviteMemberSchema = z.object({
	email: z.string().email(),
	role: z.enum(ROLES),
});

export const apiKeyScopeSchema = z.enum(ALL_API_KEY_SCOPES);

export const createApiKeySchema = z.object({
	name: z.string().min(1).max(100),
	expiresAt: legacyDatetime()
		.refine(
			(value) => new Date(value).getTime() > Date.now(),
			"API key expiry must be in the future",
		)
		.optional(),
	scopes: z.array(apiKeyScopeSchema).min(1).optional(),
	environmentId: z.string().guid().optional(),
	endUserRequired: z.boolean().optional(),
});

const policyKind = z.enum(["any", "action", "custom"]);
const policyEffect = z.enum(["require_approval", "auto_approve", "auto_deny"]);

const policyCommonFields = {
	changeNote: z.string().max(1000).optional(),
	effect: policyEffect.optional(),
	requiredApprovals: z.number().int().min(1).max(20).optional(),
	decidedBy: z.enum(["team", "end_user"]).optional(),
	priority: z.number().int().min(0).max(10000).optional(),
	enabled: z.boolean().optional(),
	acknowledgeBroadScope: z.boolean().optional(),
};

const createPolicyFields = {
	...policyCommonFields,
	matchKind: policyKind,
	matchActionName: z.string().min(1).max(200).optional(),
	matchAgentId: z.string().max(60).optional(),
	matchUserId: z.string().max(200).optional(),
	matchTags: z.array(z.string().max(60)).max(50).optional(),
	minAmount: z.number().nonnegative().optional(),
	conditions: z.record(z.string(), z.unknown()).optional(),
	condition: z.string().trim().min(1).max(2000).optional(),
};

const updatePolicyFields = {
	...policyCommonFields,
	name: z.string().min(1).max(80).optional(),
	matchKind: policyKind.optional(),
	matchActionName: z.string().min(1).max(200).nullable().optional(),
	matchAgentId: z.string().max(60).nullable().optional(),
	matchUserId: z.string().max(200).nullable().optional(),
	matchTags: z.array(z.string().max(60)).max(50).nullable().optional(),
	minAmount: z.number().nonnegative().nullable().optional(),
	conditions: z.record(z.string(), z.unknown()).nullable().optional(),
	condition: z.string().trim().min(1).max(2000).nullable().optional(),
};

const atLeastOneField = [(v: Record<string, unknown>) => Object.keys(v).length > 0, "At least one field must be provided"] as const;

export const createApprovalPolicySchema = z.object({
	environmentId: z.string().guid(),
	name: z.string().min(1).max(80),
	...createPolicyFields,
});

export const updateApprovalPolicySchema = z.object(updatePolicyFields).refine(...atLeastOneField);

export const createEnvironmentApprovalPolicySchema = z
	.object({ name: z.string().min(1).max(80), ...createPolicyFields })
	.strict();

export const updateEnvironmentApprovalPolicySchema = z.object(updatePolicyFields).strict().refine(...atLeastOneField);

const policyFileSource = z.string().min(1).max(256 * 1024);
export const policyFilePlanSchema = z.object({ source: policyFileSource }).strict();
export const policyFileApplySchema = z.object({
	source: policyFileSource,
	digest: z.string().regex(/^[0-9a-f]{64}$/, "digest is the plan's 64-character hex digest."),
	changeNote: z.string().max(1000).optional(),
}).strict();
export const policyFileTestSchema = z.object({
	source: policyFileSource,
	cases: z.union([policyFileSource, z.array(z.unknown()).max(200)]),
}).strict();

export const policyVersionsQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).optional(),
	before: z.coerce.number().int().min(1).optional(),
});

export const sessionPolicyVersionsQuerySchema = policyVersionsQuerySchema.extend({
	environmentId: z.string().guid().optional(),
});

export const conditionDraftSchema = z.object({
	environmentId: z.string().guid(),
	matchKind: policyKind,
	matchActionName: z.string().min(1).max(200).nullable().optional(),
	request: z.string().trim().min(5, "Describe the rule in a few words.").max(500),
}).strict();

export const conditionAssistSchema = z.object({
	environmentId: z.string().guid(),
	matchKind: policyKind,
	matchActionName: z.string().min(1).max(200).nullable().optional(),
	condition: z.string().max(2000).nullable().optional(),
	sampleInput: z.record(z.string(), z.unknown()).optional(),
	agentId: z.string().max(60).nullable().optional(),
	userId: z.string().max(200).nullable().optional(),
	tags: z.array(z.string().max(60)).max(50).optional(),
	policyId: z.string().min(1).max(100).optional(),
}).strict();

export const evaluateApprovalPoliciesSchema = z.object({
	kind: z.enum(["action", "custom"]),
	actionName: z.string().min(1).max(200).optional(),
	agentId: z.string().max(60).nullable().optional(),
	userId: z.string().max(200).nullable().optional(),
	payload: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((value, ctx) => {
	if (value.kind === "action" && !value.actionName) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actionName"], message: "Action context requires actionName." });
	}
	if (value.kind === "custom" && value.actionName) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actionName"], message: "Custom context must not name an action." });
	}
	if (value.kind === "custom" && value.payload?.tags !== undefined &&
		(!Array.isArray(value.payload.tags) || !value.payload.tags.every((tag) => typeof tag === "string"))) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payload", "tags"], message: "Custom request tags must be an array of strings." });
	}
});

export const startRunSchema = z.object({
	name: z.string().max(200).optional(),
	agentId: z.string().max(60).optional(),
	agentVersion: z.string().max(60).optional(),
	userId: z.string().max(200).optional(),
	application: z.string().max(200).optional(),
	input: z.unknown().optional(),
	tags: z.array(z.string().max(60)).max(50).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

export const endRunSchema = z
	.object({
		status: z.enum(["running", "succeeded", "failed", "cancelled"]).optional(),
		output: z.unknown().optional(),
		error: z.record(z.string(), z.unknown()).optional(),
		tokens: z.number().int().nonnegative().optional(),
		cost: z.number().nonnegative().optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.refine(
		(v) => Object.keys(v).length > 0,
		"At least one field must be provided",
	);

const spanTypeEnum = z.enum([
	"model_call",
	"context_assembly",
	"session_read",
	"session_write",
	"memory_recall",
	"memory_write",
	"tool_call",
	"action_call",
	"approval_wait",
	"approval_decision",
	"workflow_step",
	"queue_delivery",
	"event_delivery",
	"custom",
]);

export const ingestSpansSchema = z.object({
	spans: z
		.array(
			z.object({
				id: z.string().max(80).optional(),
				parentId: z.string().max(80).optional(),
				name: z.string().min(1).max(200),
				type: spanTypeEnum.optional(),
				status: z.enum(["running", "succeeded", "failed"]).optional(),
				startedAt: legacyDatetime(),
				endedAt: legacyDatetime().optional(),
				model: z.string().max(120).optional(),
				provider: z.string().max(120).optional(),
				tokens: z.record(z.string(), z.number()).optional(),
				cost: z.number().nonnegative().optional(),
				input: z.unknown().optional(),
				output: z.unknown().optional(),
				error: z.record(z.string(), z.unknown()).optional(),
				attributes: z.record(z.string(), z.unknown()).optional(),
			}),
		)
		.min(1)
		.max(500),
});

const otlpAttributeSchema = z.object({
	key: z.string().min(1).max(256),
	value: z
		.object({
			stringValue: z.string().max(32_768).optional(),
			boolValue: z.boolean().optional(),
			intValue: z.union([z.string().max(30), z.number().safe()]).optional(),
			doubleValue: z.number().finite().optional(),
			bytesValue: z.string().max(32_768).optional(),
			arrayValue: z.array(z.unknown()).max(100).optional(),
			kvlistValue: z
				.object({ values: z.array(z.unknown()).max(100) })
				.optional(),
		})
		.optional(),
});

const otlpSpanSchema = z.object({
	traceId: z.string().max(128).optional(),
	spanId: z.string().min(1).max(128),
	parentSpanId: z.string().min(1).max(128).optional(),
	name: z.string().min(1).max(200),
	startTimeUnixNano: z.string().regex(/^\d+$/).max(30),
	endTimeUnixNano: z.string().regex(/^\d+$/).max(30).optional(),
	status: z
		.object({ code: z.number().int().min(0).max(2).optional() })
		.optional(),
	attributes: z.array(otlpAttributeSchema).max(100).optional(),
});

export const importOtlpTraceSchema = z
	.object({
		resourceSpans: z
			.array(
				z.object({
					resource: z
						.object({
							attributes: z.array(otlpAttributeSchema).max(100).optional(),
						})
						.optional(),
					scopeSpans: z
						.array(z.object({ spans: z.array(otlpSpanSchema).max(500) }))
						.min(1)
						.max(20),
				}),
			)
			.length(1),
	})
	.superRefine((value, ctx) => {
		const total =
			value.resourceSpans[0]?.scopeSpans.reduce(
				(count, scope) => count + scope.spans.length,
				0,
			) ?? 0;
		if (total === 0)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "An OTLP trace must contain at least one span.",
			});
		if (total > 500)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "An OTLP trace may contain at most 500 spans.",
			});
	});

export const addFeedbackSchema = z.object({
	spanId: z.string().max(80).optional(),
	source: z.enum(["user", "model", "code"]).optional(),
	label: z.string().max(80).optional(),
	rating: z.number().optional(),
	comment: z.string().max(4000).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

export const listRunsQuerySchema = z.object({
	search: z.string().trim().min(1).max(200).optional(),
	status: z.enum(["running", "succeeded", "failed", "cancelled"]).optional(),
	agentId: z.string().optional(),
	userId: z.string().optional(),
	environmentId: z.string().guid().optional(),
	startedAfter: legacyDatetime().optional(),
	startedBefore: legacyDatetime().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	offset: z.coerce.number().int().min(0).default(0),
});

export const createAgentSchema = z.object({
	name: z.string().min(1).max(80),
	description: z.string().max(500).optional(),
	environmentId: z.string().guid(),
	config: z.record(z.string(), z.unknown()).optional(),
});

export const promoteAgentSchema = z.object({
	targetEnvironmentId: z.string().guid(),
	confirmProtected: z.boolean().optional(),
});

export const createAgentVersionSchema = z.object({
	config: z.record(z.string(), z.unknown()),
	publish: z.boolean().optional(),
});

export const updateAgentSchema = z
	.object({
		name: z.string().min(1).max(80).optional(),
		description: z.string().max(500).optional(),
		currentVersion: z.number().int().positive().optional(),
		archived: z.boolean().optional(),
	})
	.refine(
		(v) => Object.keys(v).length > 0,
		"At least one field must be provided",
	);

export const createEnvironmentSchema = z.object({
	kind: z.enum(["development", "staging", "production"]).default("development"),
	name: z.string().min(1).max(60),
	slug: z
		.string()
		.min(2)
		.max(40)
		.regex(
			/^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
			"Slug must be lowercase alphanumeric or hyphen, not starting or ending with a hyphen",
		),
	isProtected: z.boolean().optional(),
});

export const updateEnvironmentSchema = z
	.object({
		name: z.string().min(1).max(60).optional(),
    kind: z.enum(["development", "staging", "production"]).optional(),
    isDefault: z.literal(true).optional(),
		isProtected: z.boolean().optional(),
		confirmProtected: z.boolean().optional(),
		allowedRedirectUrls: z.array(z.string().min(1).max(2048)).max(20).optional(),
		defaultRedirectUrl: z.string().min(1).max(2048).nullable().optional(),
		connectConfirmation: z.enum(["required", "off"]).optional(),
	})
	.refine(
		(v) => Object.keys(v).length > 0,
		"At least one field must be provided",
	);

export const haltEnvironmentSchema = z.object({
	reason: z.string().max(500).optional(),
});

export const deleteEnvironmentSchema = z.object({ confirmSlug: z.string().min(2).max(40) });

export const paginationSchema = z.object({
	page: z.coerce.number().int().min(1).optional().default(1),
	limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

const analyticsQueryBaseSchema = z.object({
	startDate: legacyDatetime().optional(),
	endDate: legacyDatetime().optional(),
	granularity: z
		.enum(["hour", "day", "week", "month"])
		.optional()
		.default("day"),
	environmentId: z.string().guid().optional(),
});

const validAnalyticsRange = (query: { startDate?: string; endDate?: string }) =>
	!query.startDate ||
	!query.endDate ||
	new Date(query.startDate) <= new Date(query.endDate);

export const analyticsQuerySchema = analyticsQueryBaseSchema.refine(
	validAnalyticsRange,
	{
		message: "startDate must be less than or equal to endDate",
	},
);

export const analyticsLimitQuerySchema = analyticsQueryBaseSchema
	.extend({
		limit: z.coerce.number().int().min(1).max(100).optional().default(10),
	})
	.refine(validAnalyticsRange, {
		message: "startDate must be less than or equal to endDate",
	});

const logTypeSchema = z.enum(["message", "all"]);
const logDateSchema = legacyDatetime();
const logDurationFields = {
	minDuration: z.coerce.number().int().min(0).optional(),
	maxDuration: z.coerce.number().int().min(0).optional(),
};

export const logsQuerySchema = z
	.object({
		type: logTypeSchema.optional().default("all"),
		status: z.string().max(500).optional(),
		startDate: logDateSchema.optional(),
		endDate: logDateSchema.optional(),
		httpStatus: z
			.string()
			.regex(/^\d{3}(,\s*\d{3})*$/)
			.optional(),
		...logDurationFields,
		url: z.string().max(2048).optional(),
		messageId: z.string().max(200).optional(),
		errorCode: z.string().max(200).optional(),
		search: z.string().max(1000).optional(),
		sortBy: z
			.enum(["timestamp", "duration", "status", "httpStatus"])
			.optional()
			.default("timestamp"),
		sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),
		page: z.coerce.number().int().min(1).optional().default(1),
		limit: z.coerce.number().int().min(1).max(100).optional().default(50),
	})
	.refine(
		(q) =>
			q.minDuration == null ||
			q.maxDuration == null ||
			q.minDuration <= q.maxDuration,
		{
			message: "minDuration must be less than or equal to maxDuration",
		},
	);

export const logStatsQuerySchema = z.object({
	type: logTypeSchema.optional().default("all"),
	startDate: logDateSchema.optional(),
	endDate: logDateSchema.optional(),
});

export const logExportQuerySchema = z
	.object({
		format: z.enum(["csv", "json"]).optional().default("csv"),
		type: logTypeSchema.optional().default("all"),
		status: z.string().max(500).optional(),
		startDate: logDateSchema.optional(),
		endDate: logDateSchema.optional(),
		httpStatus: z
			.string()
			.regex(/^\d{3}(,\s*\d{3})*$/)
			.optional(),
		...logDurationFields,
		url: z.string().max(2048).optional(),
		messageId: z.string().max(200).optional(),
	})
	.refine(
		(q) =>
			q.minDuration == null ||
			q.maxDuration == null ||
			q.minDuration <= q.maxDuration,
		{
			message: "minDuration must be less than or equal to maxDuration",
		},
	);

export const signupSchema = z.object({
	email: z.string().email(),
	password: z.string().min(8).max(100),
	name: z.string().min(1).max(100),
	workspaceName: z.string().min(1).max(100).optional(),
});

export const loginSchema = z.object({
	email: z.string().email(),
	password: z.string().min(1),
});

const topicNameSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(
		/^[a-zA-Z0-9_-]+$/,
		"Topic name must be alphanumeric with hyphens and underscores only",
	);

const eventTypePatternSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(
		/^(\*|[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*(\.\*)?)$/,
		'Event type pattern must be "*", dot-segmented, or end in ".*"',
	);

export const publishEventSchema = z.object({
	topic: z.string().min(1).max(100),
	type: z
		.string()
		.min(1)
		.max(200)
		.regex(
			/^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/,
			"Event type must be dot-segmented alphanumeric",
		),
	data: z.record(z.string(), z.unknown()).optional(),
	idempotencyKey: z.string().min(1).max(255).optional(),
	runId: z.string().max(80).optional(),
	parentSpanId: z.string().max(80).optional(),
});

export const listEventsQuerySchema = z.object({
	topic: z.string().min(1).max(100).optional(),
	type: z.string().min(1).max(200).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
	offset: z.coerce.number().int().min(0).optional(),
});

export const createTopicSchema = z.object({
	name: topicNameSchema,
	description: z.string().max(500).optional(),
});

export const updateTopicSchema = z
	.object({
		name: topicNameSchema.optional(),
		description: z.string().max(500).optional(),
	})
	.refine(
		(data) => Object.keys(data).length > 0,
		"At least one field must be provided",
	);

export const createSubscriptionSchema = z.object({
	url: z.string().url().max(2048),
	eventTypes: z.array(eventTypePatternSchema).min(1).max(50).optional(),
	enabled: z.boolean().optional(),
	generateSecret: z.boolean().optional(),
	headers: customHeadersSchema.optional(),
});

export const updateSubscriptionSchema = z
	.object({
		url: z.string().url().max(2048).optional(),
		eventTypes: z.array(eventTypePatternSchema).min(1).max(50).optional(),
		enabled: z.boolean().optional(),
		headers: customHeadersSchema.nullable().optional(),
	})
	.refine(
		(data) => Object.keys(data).length > 0,
		"At least one field must be provided",
	);

export const secretNameSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(
		/^[A-Z0-9_]+$/,
		"Secret name must be uppercase letters, digits and underscores only",
	);

const allowedHostSchema = z
	.string()
	.min(1)
	.max(253)
	.regex(
		/^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i,
		"Must be a hostname, optionally prefixed with '.' to match subdomains",
	)
	.refine(
		(host) => !host.startsWith(".") || host.slice(1).split(".").length >= 2,
		"A subdomain suffix names a domain, such as '.example.com', not a whole top-level domain",
	);

export const secretStoreNameSchema = z
	.string()
	.regex(
		/^[a-z0-9][a-z0-9-]{0,62}$/,
		"Store name must be lowercase letters, digits and dashes, starting with a letter or digit",
	);

export const externalSecretRefSchema = z
	.object({
		store: secretStoreNameSchema,
		path: z.string().min(1).max(512).regex(/^[^\x00-\x1f]+$/, "path must not contain control characters"),
		key: z.string().min(1).max(256).nullable().optional(),
		version: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z0-9_.:-]+$/, "version is a version id, a staging label or a version number")
			.nullable()
			.optional(),
	})
	.strict();

export const putSecretSchema = z
	.object({
		value: z.string().min(1).max(8192).optional(),
		external: externalSecretRefSchema.optional(),
		description: z.string().max(500).optional(),
		allowedHosts: z.array(allowedHostSchema).max(20).nullable().optional(),
		allowedPlacements: z.array(z.enum(["url", "header", "body"])).max(3).nullable().optional(),
	})
	.superRefine((body, ctx) => {
		if ((body.value === undefined) === (body.external === undefined)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["value"],
				message: "Give either value (a value to store) or external (where to read it), and not both",
			});
		}
	});

const allowedStorePathsSchema = z.array(z.string().min(1).max(512)).min(1).max(20).nullable();
const cacheTtlSecondsSchema = z.number().int().min(0).max(300);

export const awsStoreConfigSchema = z
	.object({
		region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/, "region is an AWS region such as eu-west-1"),
		auth: z.enum(["access_key", "assume_role"]),
		roleArn: z
			.string()
			.regex(/^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/, "roleArn is an IAM role ARN")
			.nullable()
			.optional(),
		externalId: z
			.string()
			.min(2)
			.max(1224)
			.regex(/^[\w+=,.@:/-]+$/, "externalId has characters AWS does not accept")
			.nullable()
			.optional(),
	})
	.strict()
	.superRefine((config, ctx) => {
		if (config.auth === "assume_role" && !config.roleArn) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roleArn"], message: "assume_role needs a roleArn" });
		}
	});

export const awsStoreCredentialSchema = z
	.object({
		accessKeyId: z.string().regex(/^[A-Z0-9]{16,128}$/, "accessKeyId is an AWS access key id"),
		secretAccessKey: z.string().min(16).max(256).regex(/^[!-~]+$/, "secretAccessKey must be the key alone"),
	})
	.strict();

function vaultMountSchema(field: string, example: string) {
	return z
		.string()
		.min(1)
		.max(128)
		.regex(/^[\w.-]+(\/[\w.-]+)*$/, `${field} is a Vault mount path such as ${example}`)
		.refine(
			(value) => value.split("/").every((segment) => segment !== "." && segment !== ".."),
			`${field} must not contain . or .. segments`,
		);
}

export const vaultStoreConfigSchema = z
	.object({
		address: z.string().url().max(512),
		namespace: z.string().min(1).max(256).regex(/^[\w./-]+$/, "namespace has characters Vault does not accept").nullable().optional(),
		mount: vaultMountSchema("mount", "secret").default("secret"),
		auth: z.enum(["token", "approle"]),
		authMount: vaultMountSchema("authMount", "approle").nullable().optional(),
	})
	.strict();

export const vaultStoreCredentialSchema = z.union([
	z.object({ token: z.string().min(8).max(4096).regex(/^[!-~]+$/, "token must be the token alone") }).strict(),
	z
		.object({
			roleId: z.string().min(1).max(256).regex(/^[!-~]+$/, "roleId must be the id alone"),
			secretId: z.string().min(1).max(4096).regex(/^[!-~]+$/, "secretId must be the id alone"),
		})
		.strict(),
]);

const storeCommon = {
	name: secretStoreNameSchema,
	description: z.string().max(500).optional(),
	allowedPaths: allowedStorePathsSchema.optional(),
	cacheTtlSeconds: cacheTtlSecondsSchema.optional(),
};

export const createSecretStoreSchema = z.discriminatedUnion("type", [
	z.object({ ...storeCommon, type: z.literal("aws_secrets_manager"), config: awsStoreConfigSchema, credential: awsStoreCredentialSchema }).strict(),
	z.object({ ...storeCommon, type: z.literal("hashicorp_vault"), config: vaultStoreConfigSchema, credential: vaultStoreCredentialSchema }).strict(),
]);

export const updateSecretStoreSchema = z
	.object({
		description: z.string().max(500).nullable().optional(),
		config: z.record(z.string(), z.unknown()).optional(),
		credential: z.record(z.string(), z.unknown()).optional(),
		allowedPaths: allowedStorePathsSchema.optional(),
		cacheTtlSeconds: cacheTtlSecondsSchema.optional(),
	})
	.strict();

export const updateSecretStoreSettingsSchema = z
	.object({ allowPrivateNetwork: z.boolean() })
	.strict();

export const createConnectSessionSchema = z.object({
	integrationId: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "integrationId is a catalogue id such as hubspot"),
	secretName: secretNameSchema,
	description: z.string().max(500).optional(),
}).strict();

export const connectionFieldsSchema = z.record(
	z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/, "a field name is a catalogue field such as email"),
	z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/, "a field value has no spaces or line breaks"),
).refine((fields) => Object.keys(fields).length >= 1 && Object.keys(fields).length <= 8, { message: "fields takes one to eight values" });

export const findIntegrationRouteQuerySchema = z.object({
  name: z.string().trim().min(1, "Give the name of the app.").max(200),
});

export const connectWithKeySchema = z.object({
	integrationId: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "integrationId is a catalogue id such as github"),
	secretName: secretNameSchema,
	apiKey: z.string().min(8).max(4096).regex(/^[\x21-\x7e]+$/, "apiKey must be the key alone, with no spaces or line breaks").optional(),
	fields: connectionFieldsSchema.optional(),
	description: z.string().max(500).optional(),
}).strict().refine((body) => (body.apiKey === undefined) !== (body.fields === undefined), {
	message: "Send apiKey or fields, not both",
});

export const reconnectConnectionSchema = z.object({
	apiKey: z.string().min(8).max(4096).regex(/^[\x21-\x7e]+$/, "apiKey must be the key alone, with no spaces or line breaks").optional(),
	fields: connectionFieldsSchema.optional(),
}).strict();

export const completeConnectSessionSchema = z.object({
	reference: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/, "reference is the value the consent window reported").optional(),
}).strict();

const actionNameSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(
		/^[a-zA-Z0-9_-]+$/,
		"Action name must be alphanumeric with hyphens and underscores only",
	);

const actionMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const effectIdSchema = z.string().regex(/^eff_[A-Za-z0-9_-]{1,64}$/, "must be an effect id (eff_...)");
const previewIdSchema = z.string().regex(/^prv_[A-Za-z0-9_-]{1,64}$/, "must be a preview id (prv_...)");
const operationKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/, "operationKey may contain letters, digits, '.', '_', ':' and '-' (max 200)");

export const actionAdapterSchema = z
	.object({
		type: z.string().min(1).max(100),
		config: z.record(z.string(), z.unknown()),
		credentialSecret: secretNameSchema,
	})
	.strict();

const impactDimensionSchema = z.string().regex(
	/^[a-z][a-z0-9_]{0,31}$/,
	"dimension must be money, resource_mutations, or a unit of lowercase letters, digits and underscores (max 32)",
);

export const actionImpactSchema = z
	.object({
		dimension: impactDimensionSchema,
		unit: z.string().min(1).max(32).optional(),
		amount: z.string().min(1).max(200),
		bound: z.enum(["exact", "upper_bound"]),
	})
	.strict();

export const actionVerifySchema = z
	.object({
		url: z.string().min(1).max(2048),
		status: z.number().int().min(100).max(599),
		match: z
			.array(
				z.object({
					path: z.string().min(1).max(200),
					equals: z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]),
					absent: z.boolean().optional(),
				}).strict(),
			)
			.max(10)
			.optional(),
		graphql: z
			.object({
				query: z.string().min(1).max(10000),
				variables: z
					.record(z.string(), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]))
					.refine((v) => Object.keys(v).length <= 20, "verify.graphql.variables takes at most 20 values")
					.optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export const createActionSchema = z.object({
	name: actionNameSchema,
	description: z.string().max(1000).optional(),
	method: actionMethodSchema.optional(),
	urlTemplate: z.string().min(1).max(2048).optional(),
	headers: z.record(z.string(), z.string().max(4096)).optional(),
	bodyTemplate: z.record(z.string(), z.unknown()).optional(),
	inputSchema: z.record(z.string(), z.unknown()).optional(),
	requiresApproval: z.boolean().optional(),
	enabled: z.boolean().optional(),
	adapter: actionAdapterSchema.optional(),
	impact: actionImpactSchema.optional(),
	verify: actionVerifySchema.optional(),
	governed: z.boolean().optional(),
}).refine((data) => data.adapter !== undefined || data.urlTemplate !== undefined, {
	message: "urlTemplate is required unless the action has an adapter",
	path: ["urlTemplate"],
});

export const updateActionSchema = z
	.object({
		name: actionNameSchema.optional(),
		description: z.string().max(1000).optional(),
		method: actionMethodSchema.optional(),
		urlTemplate: z.string().min(1).max(2048).optional(),
		headers: z.record(z.string(), z.string().max(4096)).optional(),
		bodyTemplate: z.record(z.string(), z.unknown()).optional(),
		inputSchema: z.record(z.string(), z.unknown()).optional(),
		requiresApproval: z.boolean().optional(),
		enabled: z.boolean().optional(),
		adapter: actionAdapterSchema.optional(),
		impact: actionImpactSchema.nullable().optional(),
		verify: actionVerifySchema.nullable().optional(),
		governed: z.boolean().optional(),
	})
	.refine(
		(data) => Object.keys(data).length > 0,
		"At least one field must be provided",
	);

export const invokeActionSchema = z.object({
	input: z.record(z.string(), z.unknown()).optional(),
	runId: z.string().max(80).optional(),
	parentSpanId: z.string().max(80).optional(),
	retryOf: z.string().regex(/^inv_[A-Za-z0-9_-]+$/, "retryOf must be an invocation id (inv_...)").max(100).optional(),
	operationKey: operationKeySchema.optional(),
	previewId: previewIdSchema.optional(),
	dependsOn: z.array(z.object({ effect: effectIdSchema, outcome: z.enum(["succeeded", "failed"]) }).strict()).max(10).optional(),
	compensates: effectIdSchema.optional(),
});

export const createFunctionSchema = z.object({
	name: actionNameSchema,
	description: z.string().max(1000).optional(),
});

export const functionBudgetsSchema = z
	.object({
		maxActionCalls: z.number().int().min(1).max(500).optional(),
		maxCpuMs: z.number().int().min(1).max(30_000).optional(),
		maxSubrequests: z.number().int().min(1).max(1_000).optional(),
		timeoutMs: z.number().int().min(100).max(300_000).optional(),
	})
	.strict();

export const straightThroughPolicySchema = z
	.object({
		actions: z.array(actionNameSchema).min(1).max(100),
		maxWrites: z.number().int().min(1).max(500),
	})
	.strict();

export const publishFunctionVersionSchema = z
	.object({
		language: z.enum(["javascript", "python"]),
		source: z.string().min(1).max(256 * 1024),
		allowedActions: z.array(actionNameSchema).max(100).optional(),
		inputSchema: z.record(z.string(), z.unknown()).optional(),
		budgets: functionBudgetsSchema.optional(),
		straightThrough: straightThroughPolicySchema.nullable().optional(),
	})
	.strict();

export const analyzeFunctionSourceSchema = z
	.object({
		language: z.enum(["javascript", "python"]),
		source: z.string().min(1).max(256 * 1024),
	})
	.strict();

export const runFunctionSchema = z
	.object({
		input: z.record(z.string(), z.unknown()).optional(),
		mode: z.enum(["plan", "apply", "straight_through"]).optional(),
		planRunId: z.string().min(1).max(100).optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.mode === "apply" && !value.planRunId) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["planRunId"], message: "An apply run names the plan run it carries out." });
		}
		if (value.mode !== "apply" && value.planRunId !== undefined) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["planRunId"], message: "planRunId is for an apply run." });
		}
	});

const effectOutcomeValues = ["not_dispatched", "pending", "succeeded", "failed", "unknown"] as const;
const effectStageValues = ["awaiting_approval", "ready", "dispatching", "reconciling", "settled", "rejected"] as const;
const effectGradeValues = ["confirmed", "acknowledged", "unknown", "failed", "refused", "denied", "pending"] as const;

export const listEffectsQuerySchema = z.object({
	action: z.string().min(1).max(100).optional(),
	outcome: z.enum(effectOutcomeValues).optional(),
	stage: z.enum(effectStageValues).optional(),
	grade: z.enum(effectGradeValues).optional(),
	unresolved: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
	endUserId: z.string().regex(/^[A-Za-z0-9._:@-]{1,128}$/).optional(),
	actingFor: z.enum(ACTING_FOR).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
	offset: z.coerce.number().int().min(0).optional(),
});

export const effectNoteSchema = z.object({ note: z.string().trim().min(3).max(2000) }).strict();

const impactQuantitySchema = z.union([
	z.object({ dimension: z.literal("money"), currency: z.string().regex(/^[a-z]{3}$/), amount: z.number().int().min(0), bound: z.enum(["exact", "upper_bound"]).default("exact") }).strict(),
	z.object({
		dimension: impactDimensionSchema.refine((value) => value !== "money", "money needs a currency"),
		amount: z.number().int().min(0),
		bound: z.enum(["exact", "upper_bound"]).default("exact"),
	}).strict(),
]);

export const resolveEffectSchema = z.object({
	outcome: z.enum(["succeeded", "failed"]),
	partialEffect: z.enum(["none", "possible", "confirmed"]).optional(),
	actualImpact: z.array(impactQuantitySchema).max(10).optional(),
	reason: z.string().trim().min(10, "Explain what you checked and why (at least 10 characters).").max(2000),
	externalReference: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();

export const createPreviewSchema = z.object({
	input: z.record(z.string(), z.unknown()).optional(),
	ttlSeconds: z.number().int().min(60).max(7 * 24 * 3600).optional(),
	runId: z.string().max(80).optional(),
}).strict();

export const refreshPreviewSchema = z.object({
	ttlSeconds: z.number().int().min(60).max(7 * 24 * 3600).optional(),
}).strict();

export const createImpactLimitSchema = z.object({
	name: z.string().trim().min(1).max(120),
	dimension: impactDimensionSchema,
	currency: z.string().regex(/^[a-z]{3}$/, "currency must be a lowercase ISO code, e.g. usd").optional(),
	unit: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).optional(),
	actionName: z.string().min(1).max(100).nullable().optional(),
	resourcePrefix: z.string().min(1).max(500).nullable().optional(),
	scope: z.enum(["environment", "end_user"]).optional(),
	period: z.enum(["day", "month", "total"]),
	amount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

const integrationKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, "integration must be a catalogue id, e.g. gmail");

export const createConnectLinkSchema = z.object({
	integration: integrationKeySchema,
	redirectUrl: z.string().min(1).max(2048).optional(),
}).strict();

export const setEndUserConnectionSchema = z.object({
	token: z.string().min(1).max(4096).optional(),
	fields: connectionFieldsSchema.optional(),
}).strict().refine((body) => (body.token === undefined) !== (body.fields === undefined), {
	message: "Send token or fields, not both",
});

export const confirmEndUserConnectionSchema = z.object({
	flowId: z.string().min(1).max(64),
}).strict();

export const decideEndUserApprovalSchema = z.object({
	decision: z.enum(["approve", "deny"]),
	reason: z.string().max(1000).optional(),
}).strict();

export const createEndUserSessionSchema = z.object({
	ttlSeconds: z.number().int().min(60).max(3600).optional(),
}).strict();

export const sessionApprovalsQuerySchema = z.object({
	status: z.enum(["pending", "approved", "denied", "expired"]).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
	offset: z.coerce.number().int().min(0).optional(),
}).strict();

export const listEndUsersQuerySchema = z.object({
	cursor: z.string().max(128).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
	prefix: z.string().min(1).max(128).optional(),
	integration: z.string().min(1).max(64).optional(),
});

export const putEnvironmentOAuthAppSchema = z.object({
	clientId: z.string().min(1).max(256).regex(/^\S+$/, "clientId must not contain spaces"),
	clientSecret: z.string().min(1).max(1024),
}).strict();

export const updateImpactLimitSchema = z.object({
	name: z.string().trim().min(1).max(120).optional(),
	amount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().refine((data) => Object.keys(data).length > 0, "At least one field must be provided");

export const resolveInvocationSchema = z.object({
	outcome: z.enum(["succeeded", "failed"]),
	evidence: z.string().trim().min(10, "Describe what you checked at the destination (at least 10 characters).").max(2000),
	externalReference: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();

export const listInvocationsQuerySchema = z.object({
	action: z.string().min(1).max(100).optional(),
	status: z.enum(actionInvocationStatusEnum.enumValues).optional(),
	endUserId: z.string().regex(/^[A-Za-z0-9._:@-]{1,128}$/).optional(),
	actingFor: z.enum(ACTING_FOR).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
	offset: z.coerce.number().int().min(0).optional(),
});

export const importActionsSchema = z.object({
	spec: z.record(z.string(), z.unknown()),
	baseUrl: ssrfSafeUrl("baseUrl is not a valid target").optional(),
	auth: z
		.object({
			headerName: z.string().min(1).max(100),
			secretName: secretNameSchema,
			valueTemplate: z.string().min(1).max(500).optional(),
		})
		.optional(),
	requiresApproval: z.boolean().optional(),
	dryRun: z.boolean().optional(),
	only: z.array(z.string().min(1).max(200)).max(200).optional(),
	governed: z.boolean().optional(),
	operations: z
		.record(
			z.string().min(1).max(200),
			z
				.object({
					requiresApproval: z.boolean().optional(),
					impact: actionImpactSchema.nullable().optional(),
				})
				.strict(),
		)
		.refine((value) => Object.keys(value).length <= 200, "operations names at most 200 operations")
		.optional(),
});

export const MAX_APPROVAL_WAIT_SECONDS = 55;

export const createApprovalSchema = z.object({
	title: z.string().min(1).max(200),
	description: z.string().max(2000).optional(),
	payload: z.record(z.string(), z.unknown()).optional(),
	expiresInSeconds: z.number().int().min(60).max(2592000).optional(),
	runId: z.string().max(80).optional(),
	parentSpanId: z.string().max(80).optional(),
});

export const assistantSettingsSchema = z
	.object({
		enabled: z.boolean().optional(),
		consentVersion: z.string().max(40).optional(),
		excludedFields: z.array(z.string().min(1).max(200)).max(50).optional(),
		autoApprove: z
			.object({
				enabled: z.boolean().optional(),
				actions: z.array(z.string().min(1).max(100)).max(100).optional(),
				environments: z.array(z.string().guid()).max(20).optional(),
				maxAmount: z.number().nonnegative().nullable().optional(),
				minConfidence: z.number().min(0.8).max(1).optional(),
				maxRisk: z.number().int().min(0).max(4).optional(),
				minHistory: z.number().int().min(0).max(10000).optional(),
			})
			.strict()
			.optional(),
		auditSampleRate: z.number().min(0).max(1).optional(),
	})
	.strict();

export const adviceAuditSchema = z.object({ verdict: z.enum(["agree", "disagree"]) }).strict();

export const decideApprovalSchema = z.object({
	note: z.string().max(1000).optional(),
});

export const listApprovalsQuerySchema = z.object({
	status: z.enum(["pending", "approved", "denied", "expired"]).optional(),
	decisionOrigin: z.enum(["human", "policy", "system", "unknown", "assistant", "automated"]).optional(),
	endUserId: z.string().regex(/^[A-Za-z0-9._:@-]{1,128}$/).optional(),
	actingFor: z.enum(ACTING_FOR).optional(),
	decider: z.enum(["team", "end_user"]).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
	offset: z.coerce.number().int().min(0).optional(),
});

export const getApprovalQuerySchema = z.object({
	waitSeconds: z.coerce
		.number()
		.int()
		.transform((n) => Math.min(Math.max(n, 0), MAX_APPROVAL_WAIT_SECONDS))
		.optional(),
});

export const putBudgetSchema = z
	.object({
		monthlyCostCentsCap: z.number().int().min(0).nullable().optional(),
		dimensionCaps: z
			.object({
				messages: z.number().int().min(0).optional(),
				eventPublishes: z.number().int().min(0).optional(),
				actionInvokes: z.number().int().min(0).optional(),
			})
			.optional(),
		alertThreshold: z.number().min(0.1).max(1).optional(),
		enabled: z.boolean().optional(),
	})
	.refine(
		(data) => Object.keys(data).length > 0,
		"At least one field must be provided",
	);

export function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
