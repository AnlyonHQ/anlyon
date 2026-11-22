import type { Action, Invocation, Secret } from "@/lib/types";
import { API_BASE_URL } from "./constants";

export const DEMO_SECRET = "DEMO_API_TOKEN";
export const DEMO_ACTION = "demo-refund-order";
export const DEMO_INPUT = { orderId: "ord_1042", amount: 4900 } as const;

export function sandboxUrl(apiBase: string = API_BASE_URL): string {
	return `${apiBase.replace(/\/$/, "")}/api/v2/public/sandbox/echo`;
}

export function sandboxHost(apiBase: string = API_BASE_URL): string {
	return new URL(apiBase).hostname;
}

export function demoToken(
	random: (n: number) => Uint8Array = randomBytes,
): string {
	const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
	const bytes = random(24);
	let out = "demo_sk_";
	for (const byte of bytes) out += alphabet[byte % alphabet.length];
	return out;
}

function randomBytes(n: number): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(n));
}

export function demoAction(apiBase: string = API_BASE_URL) {
	return {
		name: DEMO_ACTION,
		description:
			"First-run tour: refunds an order through Anlyon's sandbox. Safe to delete.",
		method: "POST" as const,
		urlTemplate: sandboxUrl(apiBase),
		headers: {
			Authorization: `Bearer {{secret:${DEMO_SECRET}}}`,
			"Content-Type": "application/json",
		},
		bodyTemplate: {
			orderId: "{{input.orderId}}",
			amount: "{{input.amount}}",
		},
		requiresApproval: true,
	};
}

export type FirstRunStep = "vault" | "action" | "call" | "approve" | "done";

export const STEP_ORDER: readonly FirstRunStep[] = [
	"vault",
	"action",
	"call",
	"approve",
] as const;

export interface FirstRunState {
	step: FirstRunStep;
	invocation: Invocation | null;
}

export function firstRunState(input: {
	secrets: Pick<Secret, "name">[] | undefined;
	actions: Pick<Action, "name">[] | undefined;
	invocations: Invocation[] | undefined;
}): FirstRunState {
	const hasSecret = (input.secrets ?? []).some((s) => s.name === DEMO_SECRET);
	const hasAction = (input.actions ?? []).some((a) => a.name === DEMO_ACTION);
	const invocation =
		[...(input.invocations ?? [])]
			.filter((i) => i.actionName === DEMO_ACTION)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;

	if (!hasSecret) return { step: "vault", invocation: null };
	if (!hasAction) return { step: "action", invocation: null };
	if (!invocation) return { step: "call", invocation: null };
	switch (invocation.status) {
		case "pending_approval":
			return { step: "approve", invocation };
		case "running":
		case "succeeded":
		case "unknown":
			return { step: "done", invocation };
		default:
			return { step: "call", invocation };
	}
}

export function isStepDone(current: FirstRunStep, step: FirstRunStep): boolean {
	if (current === "done") return true;
	return STEP_ORDER.indexOf(step) < STEP_ORDER.indexOf(current);
}

export interface SandboxReceipt {
	authorization: string | null;
	body: unknown;
	receivedAt: string | null;
}

export function sandboxReceipt(body: string | null): SandboxReceipt | null {
	if (!body) return null;
	try {
		const parsed = JSON.parse(body) as {
			data?: {
				authorization?: string | null;
				body?: unknown;
				receivedAt?: string;
			};
		};
		if (!parsed.data) return null;
		return {
			authorization: parsed.data.authorization ?? null,
			body: parsed.data.body ?? null,
			receivedAt: parsed.data.receivedAt ?? null,
		};
	} catch {
		return null;
	}
}

export function tokenWasRedacted(receipt: SandboxReceipt | null): boolean {
	return Boolean(receipt?.authorization?.includes("[REDACTED]"));
}

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export type SnippetLanguage = "typescript" | "python" | "curl";

export function agentSnippet(language: SnippetLanguage): string {
	const { orderId, amount } = DEMO_INPUT;
	switch (language) {
		case "typescript":
			return `const { data } = await anlyon.actions.invoke("${DEMO_ACTION}", {
  orderId: "${orderId}",
  amount: ${amount},
});`;
		case "python":
			return `result = anlyon.actions.invoke("${DEMO_ACTION}", {
    "orderId": "${orderId}",
    "amount": ${amount},
})`;
		case "curl":
			return `curl -X POST ${API_BASE_URL}/api/v2/actions/${DEMO_ACTION}/invoke \\
  -H "Authorization: Bearer $ANLYON_AGENT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"input":{"orderId":"${orderId}","amount":${amount}}}'`;
	}
}
