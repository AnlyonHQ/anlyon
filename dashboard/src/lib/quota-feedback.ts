import { useSyncExternalStore } from "react";
import { ApiError } from "./api-client";

export interface QuotaFeedback {
	code: string;
	message: string;
	workspaceId?: string;
	period: string;
	feature?: string;
	requiredPlan?: string;
}

const PLAN_CODES = [
	"QUOTA_EXCEEDED",
	"BUDGET_EXCEEDED",
	"FEATURE_NOT_AVAILABLE",
	"feature_not_available",
	"PAYMENT_REQUIRED",
	"PLAN_FEATURE_REQUIRED",
];

function detail(details: unknown, key: string): string | undefined {
	const value = (details as Record<string, unknown> | null | undefined)?.[key];
	return typeof value === "string" ? value : undefined;
}
let current: QuotaFeedback | null = null;
let suppressed: { message: string; until: number } | null = null;
const listeners = new Set<() => void>();
export function publishQuotaFeedback(error: unknown) {
	if (!(error instanceof ApiError) || !PLAN_CODES.includes(error.code ?? ""))
		return;
	const period = new Date().toISOString().slice(0, 7);
	current = {
		code: error.code ?? "QUOTA_EXCEEDED",
		message: error.message,
		workspaceId: error.workspaceId,
		period,
		feature: detail(error.details, "feature"),
		requiredPlan: detail(error.details, "requiredPlan"),
	};
	suppressed = { message: error.message, until: Date.now() + 1000 };
	for (const listener of listeners) listener();
}
export function clearQuotaFeedback() {
	current = null;
	for (const listener of listeners) listener();
}
export function suppressQuotaToast(message: string) {
	return suppressed?.message === message && suppressed.until >= Date.now();
}
function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
export function useQuotaFeedback() {
	return useSyncExternalStore(
		subscribe,
		() => current,
		() => null,
	);
}
