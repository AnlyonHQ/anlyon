import type { ActionPreview, Approval } from "@/lib/types";

export type PreviewGate =
	| { kind: "not_governed" }
	| { kind: "ready"; preview: ActionPreview }
	| { kind: "blocked"; reason: string; preview?: ActionPreview };

export interface PreviewQueryState {
	data?: ActionPreview;
	isError: boolean;
	error?: unknown;
}

export function boundPreviewId(approval: Approval): string | undefined {
	const id = approval.payload?.previewId;
	return typeof id === "string" ? id : undefined;
}

export function previewGate(
	approval: Approval,
	query: PreviewQueryState,
	now: number,
): PreviewGate {
	const previewId = boundPreviewId(approval);
	if (!previewId) return { kind: "not_governed" };
	if (query.isError) {
		const message =
			query.error instanceof Error ? query.error.message : "unknown error";
		return {
			kind: "blocked",
			reason: `The preview could not be loaded (${message}). Approve only what you can review. Deny, or try again once it loads.`,
		};
	}
	const preview = query.data;
	if (!preview) {
		return {
			kind: "blocked",
			reason: "Loading the preview you are approving…",
		};
	}
	const binding = approval.payload?.bindingDigest;
	if (
		preview.id !== previewId ||
		(typeof binding === "string" && preview.bindingDigest !== binding)
	) {
		return {
			kind: "blocked",
			reason:
				"The loaded preview is not the one this approval is bound to. Reload before approving.",
		};
	}
	if (new Date(preview.expiresAt).getTime() <= now) {
		return {
			kind: "blocked",
			reason:
				"This preview has expired, so the operation can no longer execute. A new preview and approval are required.",
			preview,
		};
	}
	return { kind: "ready", preview };
}
