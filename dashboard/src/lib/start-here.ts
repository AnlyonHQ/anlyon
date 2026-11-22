export type StartStepId = "key" | "connect" | "call";

export interface StartHereInput {
	apiKeys?: number;
	connectedUsers?: number;
	usersWithCalls?: number;
	redirectUrlSet?: boolean;
	actions?: number;
	exampleAction?: string;
}

export interface StartStep {
	id: StartStepId;
	done: boolean | undefined;
}

const known = (n: number | undefined) => (n === undefined ? undefined : n > 0);

export function startSteps(input: StartHereInput): StartStep[] {
	return [
		{ id: "key", done: known(input.apiKeys) },
		{ id: "connect", done: known(input.connectedUsers) },
		{ id: "call", done: known(input.usersWithCalls) },
	];
}

export interface StartProgress {
	done: number;
	total: number;
	complete: boolean;
	next: StartStepId | null;
	loading: boolean;
}

export function startProgress(steps: StartStep[]): StartProgress {
	const done = steps.filter((step) => step.done === true).length;
	return {
		done,
		total: steps.length,
		complete: done === steps.length,
		next: steps.find((step) => step.done === false)?.id ?? null,
		loading: steps.some((step) => step.done === undefined),
	};
}

export function connectNeeds(input: StartHereInput): "redirect" | "code" {
	return input.redirectUrlSet === false ? "redirect" : "code";
}

export function callNeeds(input: StartHereInput): "action" | "code" {
	return input.actions === 0 ? "action" : "code";
}

const hiddenKey = (workspaceId: string) =>
	`anlyon.start-here.hidden.${workspaceId}`;

export function readStartHereHidden(workspaceId: string | undefined): boolean {
	if (!workspaceId) return false;
	try {
		return window.localStorage.getItem(hiddenKey(workspaceId)) === "1";
	} catch {
		return false;
	}
}

export function writeStartHereHidden(
	workspaceId: string,
	hidden: boolean,
): void {
	try {
		if (hidden) window.localStorage.setItem(hiddenKey(workspaceId), "1");
		else window.localStorage.removeItem(hiddenKey(workspaceId));
	} catch {
	}
}

export const START_SNIPPETS = {
	key: `// On your server. The key never goes to the browser.
import { Client } from '@anlyonhq/sdk';

const anlyon = new Client({ apiKey: process.env.ANLYON_API_KEY! });`,
	connect: `// A connect link for one of your users, by your own id for them.
const { data } = await anlyon.endUsers.createConnectLink({
  endUserId: user.id,
  integration: 'gmail',
});
// Send them to data.url. Back on your redirect URL, confirm it
// for the user signed in to your app:
const result = parseConnectRedirect(request.url);
await anlyon.forUser(user.id).connections.confirm(result.flowId);`,
	call: (
		action: string,
	) => `// Your agent acts as that user. Limits, approvals and a receipt apply.
const forUser = anlyon.forUser(user.id);
await forUser.actions.invoke('${action}', input);`,
} as const;
