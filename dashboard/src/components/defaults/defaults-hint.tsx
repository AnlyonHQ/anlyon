import { Link } from "@tanstack/react-router";
import { SlidersHorizontal, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useNotificationPreferences } from "@/hooks/api/use-notifications";
import { useWorkspaceDefaults } from "@/hooks/api/use-workspace-defaults";
import type { Approval, NotificationType } from "@/lib/types";
import { windowLabel } from "@/lib/workspace-defaults";

type Situation =
	| "user-call-to-team"
	| "request-expired"
	| "outcome-unknown"
	| "connection-broken";

const SECTION: Record<Situation, string> = {
	"user-call-to-team": "who-decides",
	"request-expired": "when-something-goes-wrong",
	"outcome-unknown": "when-something-goes-wrong",
	"connection-broken": "when-something-goes-wrong",
};

const key = (workspaceId: string, situation: Situation) =>
	`anlyon.defaults-hint.${workspaceId}.${situation}`;

function isDismissed(workspaceId: string, situation: Situation): boolean {
	try {
		return localStorage.getItem(key(workspaceId, situation)) === "1";
	} catch {
		return false;
	}
}

function DefaultsHint({
	workspaceId,
	situation,
	children,
}: {
	workspaceId: string;
	situation: Situation;
	children: ReactNode;
}) {
	const [dismissed, setDismissed] = useState(() =>
		isDismissed(workspaceId, situation),
	);
	if (dismissed) return null;
	return (
		<output
			className="flex items-center gap-2.5 rounded-lg border bg-muted/40 px-3 py-2 text-[13px] motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
			data-situation={situation}
		>
			<SlidersHorizontal
				aria-hidden="true"
				className="size-3.5 shrink-0 text-muted-foreground"
			/>
			<span className="min-w-0 flex-1 text-pretty">
				{children}{" "}
				<Link
					className="font-medium underline underline-offset-2 hover:no-underline"
					hash={SECTION[situation]}
					to="/settings/defaults"
				>
					Change
				</Link>
			</span>
			<button
				aria-label="Dismiss"
				className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				onClick={() => {
					try {
						localStorage.setItem(key(workspaceId, situation), "1");
					} catch {
					}
					setDismissed(true);
				}}
				type="button"
			>
				<X aria-hidden="true" className="size-3.5" />
			</button>
		</output>
	);
}

function useAlertOn(workspaceId: string | undefined, type: NotificationType) {
	const preferences = useNotificationPreferences(workspaceId).data;
	return preferences ? preferences.enabledTypes.includes(type) : undefined;
}

export function ApprovalsDefaultsHint({
	workspaceId,
	approvals,
}: {
	workspaceId: string | undefined;
	approvals: Approval[];
}) {
	const defaults = useWorkspaceDefaults(workspaceId).data;
	const tellOnExpired = useAlertOn(workspaceId, "approval_expired");
	if (!workspaceId || !defaults) return null;

	const userCallToTeam = approvals.some(
		(approval) =>
			approval.endUserId &&
			!approval.matchedPolicyId &&
			(approval.decider ?? "team") === "team",
	);
	if (userCallToTeam)
		return (
			<DefaultsHint situation="user-call-to-team" workspaceId={workspaceId}>
				A call for one of your users had no policy saying who decides, so it
				came to your team.
			</DefaultsHint>
		);

	if (
		tellOnExpired !== undefined &&
		approvals.some((approval) => approval.status === "expired")
	)
		return (
			<DefaultsHint situation="request-expired" workspaceId={workspaceId}>
				A request nobody answers in{" "}
				{windowLabel(defaults.effective.approvalWindowHours)} expires and the
				call is cancelled
				{tellOnExpired ? ", and your team is told." : ", without an alert."}
			</DefaultsHint>
		);
	return null;
}

export function OutcomeUnknownHint({
	workspaceId,
	show,
}: {
	workspaceId: string | undefined;
	show: boolean;
}) {
	const tell = useAlertOn(workspaceId, "outcome_unknown");
	if (!workspaceId || !show || tell === undefined) return null;
	return (
		<DefaultsHint situation="outcome-unknown" workspaceId={workspaceId}>
			{tell
				? "When a provider never confirms a call, your team gets an alert to check it."
				: "When a provider never confirms a call, it waits here without an alert."}
		</DefaultsHint>
	);
}

export function ConnectionBrokenHint({
	workspaceId,
	show,
}: {
	workspaceId: string | undefined;
	show: boolean;
}) {
	const tell = useAlertOn(workspaceId, "connection_broken");
	if (!workspaceId || !show || tell === undefined) return null;
	return (
		<DefaultsHint situation="connection-broken" workspaceId={workspaceId}>
			{tell
				? "When one of your connected accounts stops working, your team gets an alert to reconnect it."
				: "When one of your connected accounts stops working, it shows here without an alert."}
		</DefaultsHint>
	);
}
