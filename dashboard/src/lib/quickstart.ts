import type { Invocation, Secret } from "@/lib/types";

export interface RecipeField {
	key: string;
	label: string;
	placeholder: string;
	fromUser?: "email";
	fromParam?: string;
}

export interface QuickstartRecipe {
	integration: string;
	pitch: string;
	prompt: string;
	fields: RecipeField[];
	runs: string;
	waits: string;
}

export const RECIPES: readonly QuickstartRecipe[] = [
	{
		integration: "github",
		pitch:
			"Your agent reads a repository, opens an issue, and asks you before closing it.",
		prompt:
			'Using Anlyon, list the open issues in {repo}. Then open an issue there titled "Hello from my agent", and close it again.',
		fields: [{ key: "repo", label: "Repository", placeholder: "owner/repo" }],
		runs: "create-issue",
		waits: "close-issue",
	},
	{
		integration: "stripe",
		pitch:
			"Your agent reads your balance and charges, creates a customer, and asks you before deleting it.",
		prompt:
			'Using Anlyon, show my Stripe balance and my five most recent charges. Then create a customer named "Hello from my agent" with the email {email}, and delete it again.',
		fields: [
			{
				key: "email",
				label: "Your email",
				placeholder: "you@example.com",
				fromUser: "email",
			},
		],
		runs: "create-customer",
		waits: "delete-customer",
	},
	{
		integration: "notion",
		pitch:
			"Your agent finds a page, writes a new one, and asks you before archiving it.",
		prompt:
			'Using Anlyon, find my most recently edited Notion page and tell me what it is about. Then create a page under it titled "Hello from my agent", and archive that new page.',
		fields: [],
		runs: "create-page",
		waits: "archive-page",
	},
	{
		integration: "intercom",
		pitch:
			"Your agent reads a conversation, leaves a note, and asks you before replying.",
		prompt:
			"Using Anlyon, find my most recent open Intercom conversation and add an internal note summarising it. Then draft a reply to the customer and send it.",
		fields: [],
		runs: "add-conversation-note",
		waits: "reply-to-conversation",
	},
	{
		integration: "attio",
		pitch:
			"Your agent reads your CRM, adds a person, and asks you before creating a company.",
		prompt:
			'Using Anlyon, show the five people most recently added in Attio. Then add a person named "Hello Agent" with the email {email}, and create a company called "Hello from my agent" with the domain hello-from-my-agent.example.',
		fields: [
			{
				key: "email",
				label: "Your email",
				placeholder: "you@example.com",
				fromUser: "email",
			},
		],
		runs: "create-person",
		waits: "create-company",
	},
	{
		integration: "sentry",
		pitch:
			"Your agent reads your issues, marks one seen, and asks you before resolving it.",
		prompt:
			"Using Anlyon, list the unresolved issues in my Sentry projects and tell me which is noisiest. Mark it as seen, then resolve it.",
		fields: [],
		runs: "mark-issue-seen",
		waits: "resolve-issue",
	},
	{
		integration: "pagerduty",
		pitch:
			"Your agent reads who is on call, notes an incident, and asks you before resolving it.",
		prompt:
			'Using Anlyon, show who is on call and the open incidents. As {email}, add a note "Checked by my agent" to the newest incident, then resolve it.',
		fields: [
			{
				key: "email",
				label: "Your PagerDuty email",
				placeholder: "you@example.com",
				fromUser: "email",
			},
		],
		runs: "add-note",
		waits: "resolve-incident",
	},
	{
		integration: "asana",
		pitch:
			"Your agent reads your projects, creates a task, and asks you before completing it.",
		prompt:
			'Using Anlyon, list my Asana projects. Create a task titled "Hello from my agent" in the first one, then mark it complete.',
		fields: [],
		runs: "create-task",
		waits: "complete-task",
	},
	{
		integration: "discord",
		pitch:
			"Your agent reads a channel, posts a summary, and asks you before editing it.",
		prompt:
			"Using Anlyon, read the last ten messages in the first text channel of my Discord server and post a one-line summary there. Then edit that message to start with today's date.",
		fields: [],
		runs: "post-message",
		waits: "edit-message",
	},
	{
		integration: "resend",
		pitch:
			"Your agent reads your domains and emails, adds a contact, and asks you before sending.",
		prompt:
			"Using Anlyon, list my Resend domains and my five most recent emails. Add {email} as a contact, then send a short hello email to {email} from hello@{domain}.",
		fields: [
			{
				key: "email",
				label: "Your email",
				placeholder: "you@example.com",
				fromUser: "email",
			},
			{
				key: "domain",
				label: "Verified domain",
				placeholder: "mail.example.com",
				fromParam: "sending_domain",
			},
		],
		runs: "create-contact",
		waits: "send-email",
	},
];

export function recipeFor(integrationId: string): QuickstartRecipe | undefined {
	return RECIPES.find((r) => r.integration === integrationId);
}

export function fillPrompt(
	recipe: QuickstartRecipe,
	values: Record<string, string>,
): string {
	return recipe.prompt.replace(/\{([a-z]+)\}/g, (whole, key: string) => {
		const field = recipe.fields.find((f) => f.key === key);
		if (!field) return whole;
		const value = values[key]?.trim();
		return value ? value : field.placeholder;
	});
}

export type QuickstartStep = "pick" | "connect" | "tools" | "agent" | "done";

export const QUICKSTART_STEPS: readonly Exclude<QuickstartStep, "done">[] = [
	"pick",
	"connect",
	"tools",
	"agent",
];

export function connectedAccount(
	connections:
		| Pick<Secret, "name" | "integrationId" | "connection" | "createdAt">[]
		| undefined,
	integrationId: string | null,
): { name: string } | null {
	if (!integrationId) return null;
	const matches = (connections ?? [])
		.filter(
			(s) =>
				(s.integrationId ?? s.connection?.integrationId ?? null) ===
				integrationId,
		)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return matches[0] ? { name: matches[0].name } : null;
}

export function journeyCalls(
	invocations: Invocation[] | undefined,
	installedPrefix: string,
	since: string | null,
): Invocation[] {
	return (invocations ?? [])
		.filter((i) => i.actionName.startsWith(installedPrefix))
		.filter((i) => !since || i.createdAt >= since)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function waitedWriteDecided(
	calls: Invocation[],
	waitsInstalledName: string,
): Invocation | null {
	return (
		calls.find(
			(i) =>
				i.actionName === waitsInstalledName &&
				i.approvalId !== null &&
				i.status !== "pending_approval",
		) ?? null
	);
}

export function quickstartStep(input: {
	integrationId: string | null;
	account: { name: string } | null;
	toolsReady: boolean;
	decided: Invocation | null;
}): QuickstartStep {
	if (!input.integrationId) return "pick";
	if (!input.account) return "connect";
	if (!input.toolsReady) return "tools";
	if (!input.decided) return "agent";
	return "done";
}

export function callLabel(
	invocation: Pick<Invocation, "status" | "approvalId">,
): {
	text: string;
	tone: "neutral" | "good" | "wait" | "bad";
} {
	switch (invocation.status) {
		case "pending_approval":
			return { text: "Waiting for you", tone: "wait" };
		case "running":
			return { text: "Running", tone: "neutral" };
		case "succeeded":
			return {
				text: invocation.approvalId ? "Approved, ran" : "Ran",
				tone: "good",
			};
		case "unknown":
			return { text: "Outcome unknown", tone: "wait" };
		default:
			return {
				text: invocation.approvalId ? "Not run" : "Refused",
				tone: "bad",
			};
	}
}
