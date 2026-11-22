import type {
	McpAdoptChoice,
	McpAdoptedTool,
	McpRegistration,
	McpRiskClass,
	McpSignIn,
	McpToolSnapshot,
	McpUpstream,
	McpUpstreamCheck,
} from "@/hooks/api/use-mcp-upstreams";
import type { Secret } from "@/lib/types";
import { actionToolName } from "./action-tool-name";

export const SERVER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED_NAMES = new Set(["new"]);
export const SECRET_NAME = /^[A-Z0-9_]+$/;

export function normalizeServerUrl(input: string): string {
	const text = input.trim();
	if (!text) return "";
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
}

export function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

const GENERIC_LABELS = new Set([
	"mcp",
	"api",
	"www",
	"app",
	"server",
	"remote",
]);

export function suggestName(
	url: string,
	taken: readonly string[] = [],
): string {
	const labels = hostOf(url).toLowerCase().split(".").filter(Boolean);
	const words = labels.length > 1 ? labels.slice(0, -1) : labels;
	const word =
		[...words].reverse().find((label) => !GENERIC_LABELS.has(label)) ??
		words.at(-1) ??
		"server";
	const clean = word
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/^[^a-z]+/, "")
		.replace(/-+$/, "")
		.slice(0, 32);
	const base = clean && !RESERVED_NAMES.has(clean) ? clean : "server";
	if (!taken.includes(base)) return base;
	for (let n = 2; n < 100; n++) {
		const candidate = `${base.slice(0, 32 - String(n).length - 1)}-${n}`;
		if (!taken.includes(candidate)) return candidate;
	}
	return base;
}

export function serverNameProblem(
	name: string,
	taken: readonly string[],
): string | null {
	if (!name) return "Give the server a name.";
	if (!SERVER_NAME.test(name))
		return "Use lowercase letters, digits and hyphens, starting with a letter, 32 at most.";
	if (RESERVED_NAMES.has(name)) return "That name is reserved. Choose another.";
	if (taken.includes(name)) return `A server named ${name} already exists.`;
	return null;
}

export function secretNameFor(
	serverName: string,
	suffix: "CLIENT_SECRET" | "MCP_TOKEN",
): string {
	const base = serverName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
	return `${base}_${suffix}`;
}

export interface AdoptionCounts {
	live: number;
	changed: number;
	missing: number;
	adopted: number;
}

export function adoptionCounts(server: McpUpstream): AdoptionCounts {
	const count = (test: (tool: McpAdoptedTool) => boolean) =>
		server.adopted.filter(test).length;
	return {
		live: count((tool) => tool.state === "current" && tool.enabled),
		changed: count((tool) => tool.state === "changed"),
		missing: count((tool) => tool.state === "missing"),
		adopted: server.adopted.length,
	};
}

export type NextStep =
	| { kind: "sign-in" }
	| { kind: "listing-failed"; message: string; at: string }
	| { kind: "review"; changed: number; missing: number }
	| { kind: "no-tools" }
	| { kind: "choose-tools"; toolCount: number }
	| { kind: "live"; live: number };

export function nextStep(server: McpUpstream): NextStep {
	if (server.oauth && !server.oauth.operatorConnected && !server.listedAt) {
		return { kind: "sign-in" };
	}
	if (server.lastError) {
		return {
			kind: "listing-failed",
			message: server.lastError.message,
			at: server.lastError.at,
		};
	}
	const { live, changed, missing } = adoptionCounts(server);
	if (changed + missing > 0) return { kind: "review", changed, missing };
	if (server.adopted.length > 0) return { kind: "live", live };
	if (server.tools.length === 0) return { kind: "no-tools" };
	return { kind: "choose-tools", toolCount: server.tools.length };
}

export interface CheckSummary {
	kind: McpUpstreamCheck["status"];
	lead: string;
	at: string | null;
	tail: string | null;
}

export function checkSummary(server: McpUpstream): CheckSummary | null {
	const { check } = server;
	if (!check || !server.listedAt) return null;
	const changes = server.changes?.length ?? 0;
	switch (check.status) {
		case "needs_sign_in":
			return {
				kind: "needs_sign_in",
				lead: "Not being checked: this server only lists its tools to someone signed in, and nobody has connected their own account. Last listed",
				at: server.listedAt,
				tail: "A tool that changed is still refused when an agent calls it, but nobody hears before that. Connect your account on the People tab to turn checks on",
			};
		case "failed":
			return {
				kind: "failed",
				lead:
					check.failures > 1
						? `The last ${check.failures} checks failed, so nothing is known since the last good listing`
						: "The last check failed, so nothing is known since the last good listing",
				at: server.listedAt,
				tail: "Anlyon keeps trying, less often each time. Every call still checks its tool first",
			};
		case "pending":
			return {
				kind: "pending",
				lead: "Listed",
				at: server.listedAt,
				tail: "Its first scheduled check is coming up",
			};
		case "ok":
			return {
				kind: "ok",
				lead: "Checked",
				at: check.checkedAt,
				tail: changes === 0 ? "No change" : null,
			};
	}
}

export function lastCheckedCell(server: McpUpstream): {
	prefix: string | null;
	at: string | null;
	text: string | null;
} {
	const { check } = server;
	if (check?.status === "needs_sign_in") {
		return { prefix: null, at: null, text: "Cannot check" };
	}
	const at = check?.checkedAt ?? server.listedAt;
	if (!at) return { prefix: null, at: null, text: "Never" };
	return {
		prefix: check?.status === "failed" ? "Failed" : null,
		at,
		text: null,
	};
}

export function checkWarning(server: McpUpstream): string | null {
	if (server.check?.status === "needs_sign_in") return "Cannot be checked";
	if (server.check?.status === "failed") return "Last check failed";
	return null;
}

export type StatusTone = "neutral" | "info" | "success" | "warning" | "error";

export function serverStatus(server: McpUpstream): {
	label: string;
	tone: StatusTone;
} {
	const step = nextStep(server);
	switch (step.kind) {
		case "sign-in":
			return { label: "Needs sign-in", tone: "warning" };
		case "listing-failed":
			return { label: "Listing failed", tone: "error" };
		case "review":
			return {
				label: `${step.changed + step.missing} changed`,
				tone: "warning",
			};
		case "no-tools":
			return { label: "No tools listed", tone: "neutral" };
		case "choose-tools":
			return { label: "Choose tools", tone: "info" };
		case "live":
			return { label: `${step.live} live`, tone: "success" };
	}
}

export function credentialSecretName(server: McpUpstream): string | null {
	for (const value of Object.values(server.headers)) {
		const match = /\{\{secret:([A-Za-z0-9_]+)\}\}/.exec(value);
		if (match) return match[1] ?? null;
	}
	return null;
}

export function signInLabel(server: McpUpstream): string {
	if (server.oauth) return "OAuth";
	return credentialSecretName(server) ? "Stored credential" : "None";
}

export const LISTED_WITH = {
	anonymous: "No credential",
	headers: "The stored credential",
	operator: "Your connected account",
} as const;

export interface SignInStart {
	url: string;
	expiresAt: string;
	updatedAt: string;
	listedAt: string | null;
	errorAt: string | null;
}

export type SignInProgress =
	| "waiting"
	| "listing"
	| "listed"
	| "failed"
	| "expired";

export function signInProgress(
	start: SignInStart,
	server: McpUpstream,
	now: number,
): SignInProgress {
	if (server.listedAt !== start.listedAt) return "listed";
	if ((server.lastError?.at ?? null) !== start.errorAt) return "failed";
	if (server.updatedAt !== start.updatedAt) return "listing";
	return now > new Date(start.expiresAt).getTime() ? "expired" : "waiting";
}

export const RISK_LABEL: Record<McpRiskClass, string> = {
	read: "Read",
	write: "Write",
	irreversible: "Irreversible",
	destructive: "Destructive",
};

export const RISK_MEANING: Record<McpRiskClass, string> = {
	read: "Looks at data and changes nothing.",
	write: "Creates or changes something.",
	irreversible: "Does something that cannot be taken back once it has run.",
	destructive: "Deletes or overwrites data.",
};

export const RISK_VARIANT: Record<
	McpRiskClass,
	"secondary" | "info" | "warning" | "error"
> = {
	read: "secondary",
	write: "info",
	irreversible: "warning",
	destructive: "error",
};

export type ToolState =
	| "available"
	| "live"
	| "disabled"
	| "changed"
	| "missing";

export interface ToolRow {
	name: string;
	tool: McpToolSnapshot | null;
	adopted: McpAdoptedTool | null;
	state: ToolState;
	risk: McpRiskClass | null;
}

export function toolRows(server: McpUpstream): ToolRow[] {
	const adopted = new Map(server.adopted.map((tool) => [tool.tool, tool]));
	const listed = server.tools.map((tool): ToolRow => {
		const mine = adopted.get(tool.name) ?? null;
		const state: ToolState = !mine
			? "available"
			: mine.state === "changed"
				? "changed"
				: mine.enabled
					? "live"
					: "disabled";
		return {
			name: tool.name,
			tool,
			adopted: mine,
			state,
			risk: tool.suggestedClass,
		};
	});
	const names = new Set(server.tools.map((tool) => tool.name));
	const gone = server.adopted
		.filter((tool) => !names.has(tool.tool))
		.map(
			(tool): ToolRow => ({
				name: tool.tool,
				tool: null,
				adopted: tool,
				state: "missing",
				risk: null,
			}),
		);
	return [...gone, ...listed];
}

export type ToolFilter = "all" | "adopted" | "review";

export function filterRows(
	rows: readonly ToolRow[],
	query: string,
	filter: ToolFilter,
): ToolRow[] {
	const q = query.trim().toLowerCase();
	return rows.filter((row) => {
		if (filter === "adopted" && !row.adopted) return false;
		if (
			filter === "review" &&
			row.state !== "changed" &&
			row.state !== "missing"
		)
			return false;
		if (!q) return true;
		return (
			row.name.toLowerCase().includes(q) ||
			(row.tool?.definition.description ?? "").toLowerCase().includes(q)
		);
	});
}

export interface ToolGroup {
	key: McpRiskClass | "gone";
	rows: ToolRow[];
}

const GROUP_ORDER: ToolGroup["key"][] = [
	"gone",
	"read",
	"write",
	"irreversible",
	"destructive",
];

export function groupRows(rows: readonly ToolRow[]): ToolGroup[] {
	return GROUP_ORDER.map((key) => ({
		key,
		rows: rows
			.filter((row) => (row.risk ?? "gone") === key)
			.sort(
				(a, b) => Number(b.state === "changed") - Number(a.state === "changed"),
			),
	})).filter((group) => group.rows.length > 0);
}

export const suggestsApproval = (risk: McpRiskClass | null) =>
	risk === "irreversible" || risk === "destructive";

export const LOOSE_CHECK_TEXT =
	"This server's input schema uses something Anlyon doesn't check, so arguments are sent as your agent wrote them. Approvals show them in full.";

export function looselyChecked(row: ToolRow): boolean {
	return row.adopted?.schemaCheck
		? row.adopted.schemaCheck === "loose"
		: row.tool?.schemaCheck === "loose";
}

export const rowSuggestsApproval = (row: ToolRow) =>
	suggestsApproval(row.risk) || looselyChecked(row);

export function initialChoice(row: ToolRow): McpAdoptChoice {
	const read = row.tool ? { toolHash: row.tool.hash } : {};
	return row.state === "changed"
		? read
		: { requiresApproval: rowSuggestsApproval(row), ...read };
}

export const groupSelectable = (rows: readonly ToolRow[]) =>
	rows.filter((row) => row.state === "available");

export const MAX_ADOPT = 100;

export function selectionSummary(
	selection: Record<string, McpAdoptChoice>,
	readopting = 0,
): string {
	const choices = Object.values(selection);
	const approvals = choices.filter((choice) => choice.requiresApproval).length;
	return [
		`${choices.length} ${choices.length === 1 ? "tool" : "tools"} selected`,
		readopting > 0 ? `${readopting} to re-adopt` : null,
		approvals > 0
			? `${approvals} ${approvals === 1 ? "requires" : "require"} approval`
			: null,
	]
		.filter(Boolean)
		.join(", ");
}

export interface ToolInput {
	name: string;
	type: string;
	required: boolean;
	description: string | null;
}

export function toolInputs(schema: unknown): ToolInput[] {
	if (!schema || typeof schema !== "object") return [];
	const { properties, required } = schema as {
		properties?: unknown;
		required?: unknown;
	};
	if (!properties || typeof properties !== "object") return [];
	const needed = new Set(Array.isArray(required) ? required : []);
	return Object.entries(properties as Record<string, unknown>).map(
		([name, value]) => {
			const prop = (value ?? {}) as { type?: unknown; description?: unknown };
			return {
				name,
				type: Array.isArray(prop.type)
					? prop.type.join(" | ")
					: typeof prop.type === "string"
						? prop.type
						: "any",
				required: needed.has(name),
				description:
					typeof prop.description === "string" ? prop.description : null,
			};
		},
	);
}

const SAFE_KEY = /^[A-Za-z0-9_-]{1,64}$/;

export function exampleInput(schema: unknown): Record<string, unknown> {
	const example: Record<string, unknown> = {};
	for (const input of toolInputs(schema)) {
		if (!input.required || !SAFE_KEY.test(input.name)) continue;
		example[input.name] =
			input.type === "number" || input.type === "integer"
				? 1
				: input.type === "boolean"
					? true
					: input.type === "array"
						? []
						: input.type === "object"
							? {}
							: "...";
	}
	return example;
}

export function curlSnippet(
	baseUrl: string,
	action: string,
	schema: unknown,
): string {
	return `curl -X POST ${baseUrl}/api/v2/actions/${action}/invoke \\
  -H "Authorization: Bearer $ANLYON_AGENT_KEY" \\
  -H "Anlyon-End-User: user_123" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify({ input: exampleInput(schema) })}'`;
}

export const mcpToolName = (action: string) => actionToolName(action);

export type SecretChoice =
	| { mode: "new"; name: string; value: string }
	| { mode: "existing"; name: string };

export type CredentialHeader = "bearer" | "x-api-key";

export interface CredentialForm {
	secret: SecretChoice;
	header: CredentialHeader;
}

export interface OAuthForm {
	anlyonClient?: boolean;
	clientId: string;
	secret: SecretChoice | null;
	scopes: string[];
}

export type SecretFit = "bound" | "anywhere" | "elsewhere" | "closed";

export function secretFit(secret: Secret, host: string): SecretFit {
	const allowed = secret.allowedHosts ?? [];
	if (allowed.length === 0) {
		return secret.kind === "external" ? "closed" : "anywhere";
	}
	const target = host.toLowerCase();
	const fits = allowed.some((entry) => {
		const want = entry.toLowerCase().trim();
		return want.startsWith(".") ? target.endsWith(want) : target === want;
	});
	return fits ? "bound" : "elsewhere";
}

export function secretProblem(
	choice: SecretChoice,
	secrets: readonly Secret[],
	host: string,
): string | null {
	if (choice.mode === "new") {
		if (!SECRET_NAME.test(choice.name))
			return "Name the secret in uppercase letters, digits and underscores.";
		if (secrets.some((secret) => secret.name === choice.name))
			return `A secret named ${choice.name} already exists. Choose it from the list instead.`;
		if (!choice.value) return "Paste the secret's value.";
		return null;
	}
	if (!choice.name) return "Choose a secret.";
	const secret = secrets.find((item) => item.name === choice.name);
	if (!secret) return null;
	const fit = secretFit(secret, host);
	if (fit === "elsewhere")
		return `${secret.name} may not be sent to ${host}, so the server would be refused.`;
	if (fit === "closed")
		return `${secret.name} comes from your secret store and has no allowed hosts, so it is sent nowhere.`;
	return null;
}

export const anlyonClientAvailable = (signIn: McpSignIn): boolean =>
	signIn.advertised.clientIdMetadataDocuments ||
	signIn.advertised.dynamicRegistration;

export function oauthProblem(
	form: OAuthForm,
	signIn: McpSignIn,
	secrets: readonly Secret[],
): string | null {
	if (!signIn.redirectUri)
		return "This deployment cannot sign people in, because connected accounts are not configured on it.";
	if (!form.anlyonClient) {
		const clientId = form.clientId.trim();
		if (!clientId) return "Paste the client id the vendor gave you.";
		if (/^https:\/\//i.test(clientId))
			return "A client id that is a URL is a Client ID Metadata Document. Anlyon uses only its own, so use a client id the vendor issued.";
		if (form.secret) {
			const problem = secretProblem(form.secret, secrets, signIn.tokenHost);
			if (problem) return problem;
		}
	}
	if (signIn.scopesSupported.length > 0 && form.scopes.length === 0)
		return "Choose at least one scope. With none, Anlyon would ask for all of them.";
	if (form.scopes.length > 50) return "Choose at most 50 scopes.";
	return null;
}

export function credentialHeaders(
	form: CredentialForm,
): Record<string, string> {
	const ref = `{{secret:${form.secret.name}}}`;
	return form.header === "bearer"
		? { Authorization: `Bearer ${ref}` }
		: { "X-API-Key": ref };
}

export function registration(
	name: string,
	url: string,
	access:
		| { kind: "none" }
		| { kind: "credential"; form: CredentialForm }
		| { kind: "oauth"; form: OAuthForm },
): McpRegistration {
	const base = { name: name.trim(), url };
	if (access.kind === "credential")
		return { ...base, headers: credentialHeaders(access.form) };
	if (access.kind === "oauth")
		return {
			...base,
			oauth: {
				...(access.form.anlyonClient
					? {}
					: {
							clientId: access.form.clientId.trim(),
							...(access.form.secret
								? { clientSecret: `{{secret:${access.form.secret.name}}}` }
								: {}),
						}),
				...(access.form.scopes.length > 0
					? { scopes: access.form.scopes }
					: {}),
			},
		};
	return base;
}

const REFUSAL: Record<string, string> = {
	not_https: "It signs in over a connection that is not https.",
	resource_mismatch: "Its sign-in details are for a different server.",
	issuer_mismatch: "Its sign-in server's details do not match its address.",
	pkce_unsupported:
		"Its sign-in server does not offer PKCE, which MCP requires.",
	authorization_code_unsupported:
		"Its sign-in server does not offer the sign-in flow Anlyon uses.",
	no_authorization_server: "It does not say who signs people in.",
	no_authorization_server_metadata:
		"Its sign-in server does not publish its details.",
	metadata_invalid: "Its sign-in details could not be read.",
	metadata_unreachable: "Its sign-in details could not be reached.",
	tools_invalid: "Its list of tools could not be read.",
	authorization_server_not_listed:
		"The server does not name that sign-in server.",
};

export const refusalHeadline = (reason: string) =>
	REFUSAL[reason] ?? "Anlyon will not sign in to this server.";
