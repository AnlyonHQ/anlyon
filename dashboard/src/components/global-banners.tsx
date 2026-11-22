import { Link, useRouterState } from "@tanstack/react-router";
import {
	ArrowUpRight,
	Eye,
	FlaskConical,
	Gauge,
	KeyRound,
	OctagonPause,
	ShieldCheck,
	SlidersHorizontal,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PlanAction, useExtensionBanners } from "@/components/extension-slots";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/contexts/workspace-context";
import { useEdition } from "@/hooks/api/use-edition";
import { useEnvironments } from "@/hooks/api/use-environments";
import { useWorkspacePermissions } from "@/hooks/api/use-permissions";
import { useCurrentUsage, useQuotaStatus } from "@/hooks/api/use-plan";
import {
	useSaveWorkspaceDefaults,
	useWorkspaceDefaults,
} from "@/hooks/api/use-workspace-defaults";
import { useAuth } from "@/hooks/use-auth";
import { usePlanAccess } from "@/hooks/use-plan-access";
import { teamFeatureLabel } from "@/lib/plans";
import { clearQuotaFeedback, useQuotaFeedback } from "@/lib/quota-feedback";
import { cn } from "@/lib/utils";

const PROMOS: {
	id: string;
	message: string;
	href: string;
	linkLabel: string;
	more?: { href: string; label: string };
}[] = [
	{
		id: "early-beta-notice-2026",
		message:
			"Anlyon is in early beta. The API contract can change before 1.0, and every change is announced in the changelog with a migration note.",
		href: "https://docs.anlyon.com/account/billing",
		linkLabel: "See your plan's terms",
		more: { href: "https://docs.anlyon.com/changelog", label: "Changelog" },
	},
	{
		id: "approval-gates-launch",
		message:
			"The SDK approval gate waits for a decision before it calls your function. It depends on your code going through the wrapper.",
		href: "https://docs.anlyon.com/guides/approval-gates",
		linkLabel: "Read the guide",
	},
];

const DISMISS_PREFIX = "anlyon.banner.dismissed.";
const HOME_PATHS = new Set(["/dashboard", "/analytics"]);
const twoFactorBannerId = "two-factor-reminder";
const twoFactorSnoozeMs = 14 * 24 * 60 * 60 * 1000;

export function isBannerDismissed(id: string): boolean {
	try {
		return localStorage.getItem(DISMISS_PREFIX + id) === "1";
	} catch {
		return false;
	}
}

export function dismissBanner(id: string): void {
	try {
		localStorage.setItem(DISMISS_PREFIX + id, "1");
	} catch {
	}
}

function isTwoFactorReminderSnoozed(): boolean {
	try {
		const dismissedAt = Number(
			localStorage.getItem(DISMISS_PREFIX + twoFactorBannerId),
		);
		return (
			Number.isFinite(dismissedAt) &&
			Date.now() - dismissedAt < twoFactorSnoozeMs
		);
	} catch {
		return false;
	}
}

function snoozeTwoFactorReminder(): void {
	try {
		localStorage.setItem(
			DISMISS_PREFIX + twoFactorBannerId,
			String(Date.now()),
		);
	} catch {
	}
}

export function Banner({
	tone,
	icon,
	children,
	onDismiss,
}: {
	tone: "error" | "warning" | "info";
	icon: React.ReactNode;
	children: React.ReactNode;
	onDismiss?: () => void;
}) {
	return (
		<div
			role={tone === "error" ? "alert" : "status"}
			className={cn(
				"flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm",
				"motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-200",
				tone === "error" &&
					"border-destructive/40 bg-destructive/10 text-destructive-foreground",
				tone === "warning" &&
					"border-warning/50 bg-warning/10 text-warning-foreground",
				tone === "info" && "border-border bg-muted/50 text-foreground",
			)}
		>
			<span aria-hidden="true" className="shrink-0">
				{icon}
			</span>
			<div className="min-w-0 flex-1">{children}</div>
			{onDismiss ? (
				<button
					type="button"
					aria-label="Dismiss"
					className="shrink-0 rounded-md p-1 transition-colors hover:bg-foreground/10"
					onClick={onDismiss}
				>
					<X className="size-3.5" aria-hidden="true" />
				</button>
			) : null}
		</div>
	);
}

export function GlobalBanners() {
	const { currentWorkspace } = useWorkspace();
	const { user } = useAuth();
	const workspaceId = currentWorkspace?.id;
	const environments = useEnvironments(workspaceId);
	const permissions = useWorkspacePermissions(workspaceId).data;
	const role = permissions?.role;
	const canManageBilling =
		permissions?.permissions.includes("billing.manage") ?? false;
	const quota = useQuotaStatus(workspaceId);
	const { plan: planDetails, access } = usePlanAccess(workspaceId);
	const actionAllowance = useCurrentUsage(workspaceId).data?.actionAllowance;
	const defaults = useWorkspaceDefaults(workspaceId).data;
	const putDefaultsAside = useSaveWorkspaceDefaults(workspaceId, {
		source: "home_prompt",
		successMessage: null,
	});
	const [, forceRender] = useState(0);
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const onHome = HOME_PATHS.has(pathname.replace(/\/+$/, "") || "/");
	const shownPromo = useRef<(typeof PROMOS)[number] | null>(null);
	const closedThisVisit = useRef(false);
	if (!onHome) {
		shownPromo.current = null;
		closedThisVisit.current = false;
	}

	const halted = (environments.data ?? []).filter((env) => env.halted);
	const license = useEdition().data?.license ?? null;
	const licenseNotice =
		license && (license.state !== "valid" || license.overSeats)
			? license
			: null;

	const feedback = useQuotaFeedback();
	const currentFeedback =
		feedback &&
		feedback.workspaceId === workspaceId &&
		feedback.period === new Date().toISOString().slice(0, 7)
			? feedback
			: null;
	const actions = quota.data?.allowances?.actionInvokes;
	const actionPercent = actions?.includedUnits
		? (100 * actions.usedUnits) / actions.includedUnits
		: 0;
	const monthly = quota.data?.monthly;
	const month = new Date().toISOString().slice(0, 7);
	const nearCap =
		quota.data?.plan === "free" &&
		access?.betaAllowancesApply === true &&
		monthly &&
		monthly.limit !== "unlimited" &&
		Math.max(monthly.percentage, actionPercent) >= 80;
	const quotaBannerId = `quota-80-${workspaceId}-${month}`;

	const paidPlan =
		!!planDetails &&
		planDetails.plan !== "free" &&
		planDetails.plan !== "enterprise";
	const allowanceTotal = actionAllowance
		? actionAllowance.included === null
			? 0
			: actionAllowance.included + actionAllowance.credits
		: (actions?.includedUnits ?? 0);
	const allowanceUsed = actionAllowance?.used ?? actions?.usedUnits ?? 0;
	const paidPercent =
		paidPlan && allowanceTotal > 0 ? (100 * allowanceUsed) / allowanceTotal : 0;
	const paidThreshold = paidPercent >= 100 ? 100 : paidPercent >= 80 ? 80 : 0;
	const paidBannerId = `actions-${paidThreshold}-${workspaceId}-${month}`;
	const showPaidUsage =
		paidThreshold > 0 && !nearCap && !isBannerDismissed(paidBannerId);

	const extensionBanners = useExtensionBanners({
		workspaceId,
		pathname,
		onHome,
		canManageBilling,
		quotaFeedbackShown: !!currentFeedback,
	});

	const showDefaultsPrompt =
		onHome &&
		defaults?.setup.status === null &&
		(permissions?.permissions.includes("workspace.update") ?? false) &&
		putDefaultsAside.isIdle;

	const promoAllowed =
		onHome &&
		!showDefaultsPrompt &&
		!closedThisVisit.current &&
		halted.length === 0 &&
		!nearCap &&
		!showPaidUsage &&
		!extensionBanners.quiet &&
		!currentFeedback;
	if (promoAllowed && !shownPromo.current) {
		shownPromo.current = PROMOS.find((p) => !isBannerDismissed(p.id)) ?? null;
	}
	const promo = promoAllowed ? shownPromo.current : null;
	useEffect(() => {
		if (promo) dismissBanner(promo.id);
	}, [promo]);
	const roleNoticeId = `role-notice-${workspaceId}-${role}`;
	const showRoleNotice =
		(role === "viewer" || role === "approver") &&
		!isBannerDismissed(roleNoticeId);
	const showTwoFactorReminder =
		onHome && !user?.twoFactorEnabled && !isTwoFactorReminderSnoozed();

	return (
		<>
			{showTwoFactorReminder && (
				<Banner
					tone="info"
					icon={<ShieldCheck className="size-4 text-primary" />}
					onDismiss={() => {
						snoozeTwoFactorReminder();
						forceRender((n) => n + 1);
					}}
				>
					Protect your account with an authenticator app.{" "}
					<Link
						className="font-medium underline underline-offset-2"
						to="/settings/security"
					>
						Set up two-factor authentication
					</Link>
				</Banner>
			)}

			{showDefaultsPrompt && (
				<Banner
					tone="info"
					icon={<SlidersHorizontal className="size-4 text-primary" />}
					onDismiss={() =>
						putDefaultsAside.mutate({ defaults: { setupStatus: "skipped" } })
					}
				>
					Choose who decides and what happens when something goes wrong. About
					two minutes, with a recommended answer for each.{" "}
					<Link
						className="font-medium underline underline-offset-2"
						to="/workspaces/setup"
					>
						Review defaults
					</Link>
				</Banner>
			)}

			{showRoleNotice && (
				<Banner
					tone="info"
					icon={<Eye className="size-4 text-primary" />}
					onDismiss={() => {
						dismissBanner(roleNoticeId);
						forceRender((n) => n + 1);
					}}
				>
					{role === "viewer"
						? "You have view-only access to this workspace."
						: "You can view this workspace and decide approvals."}{" "}
					A workspace admin can change your role.
				</Banner>
			)}

			{halted.length > 0 && (
				<Banner tone="error" icon={<OctagonPause className="size-4" />}>
					<span className="font-medium">
						{halted.length === 1
							? `Environment “${halted[0].name}” is halted`
							: `${halted.length} environments are halted`}
					</span>
					{halted[0].haltedReason ? `  ${halted[0].haltedReason}` : ""}. New
					dispatch is stopped until it is resumed. A request another server
					already accepted is not recalled.{" "}
					<Link
						className="font-medium underline underline-offset-2"
						to="/environments"
					>
						Manage
					</Link>
				</Banner>
			)}

			{licenseNotice && (
				<Banner
					tone={licenseNotice.state === "invalid" ? "error" : "warning"}
					icon={<KeyRound className="size-4" />}
				>
					{licenseNotice.state !== "valid" ? (
						licenseNotice.message
					) : (
						<>
							This install has {licenseNotice.seatsUsed} people in its
							workspaces and the licence covers {licenseNotice.seats}. Nothing
							is blocked. Contact Anlyon to add seats.
						</>
					)}
				</Banner>
			)}

			{extensionBanners.node}

			{showPaidUsage && (
				<Banner
					tone={paidThreshold === 100 ? "error" : "warning"}
					icon={<Gauge className="size-4" />}
					onDismiss={() => {
						dismissBanner(paidBannerId);
						forceRender((n) => n + 1);
					}}
				>
					{paidThreshold === 100
						? "Governed actions have reached this month's allowance. A 10% buffer runs, then actions are refused until the month resets."
						: `Governed actions are at ${Math.floor(paidPercent)}% of this month's allowance.`}{" "}
					No surprise bills.{" "}
					<PlanAction
						canManageBilling={canManageBilling}
						className="font-medium underline underline-offset-2"
						site="paid-usage-banner"
					/>
				</Banner>
			)}

			{nearCap && !isBannerDismissed(quotaBannerId) && (
				<Banner
					tone="warning"
					icon={<Gauge className="size-4" />}
					onDismiss={() => {
						dismissBanner(quotaBannerId);
						forceRender((n) => n + 1);
					}}
				>
					{actionPercent >= (monthly?.percentage ?? 0)
						? "Action executions"
						: "Messages"}{" "}
					are at {Math.round(Math.max(actionPercent, monthly?.percentage ?? 0))}
					% of the free monthly allowance. Requests stop at the cap. No
					automatic overage charges.{" "}
					<PlanAction
						canManageBilling={canManageBilling}
						className="font-medium underline underline-offset-2"
						fallback={
							<Link
								className="font-medium underline underline-offset-2"
								to="/settings/usage"
							>
								Review usage
							</Link>
						}
						site="allowance-banner"
					/>
				</Banner>
			)}

			{currentFeedback && (
				<Alert variant="warning" className="w-auto">
					<AlertTitle>
						{currentFeedback.code === "BUDGET_EXCEEDED"
							? "API key budget reached"
							: currentFeedback.code === "PAYMENT_REQUIRED"
								? "Choose a plan to run actions"
								: currentFeedback.code === "PLAN_FEATURE_REQUIRED"
									? `${teamFeatureLabel(currentFeedback.feature)} needs the Team plan`
									: "Workspace allowance reached"}
					</AlertTitle>
					<AlertDescription>
						<p>
							{currentFeedback.code === "PLAN_FEATURE_REQUIRED"
								? "Nothing was changed. What is already set up keeps working, and you can still delete it."
								: currentFeedback.message}
						</p>
						{currentFeedback.code === "BUDGET_EXCEEDED" ? (
							<Link to="/settings/api-keys" className="underline">
								Review the key budget
							</Link>
						) : (
							<PlanAction
								canManageBilling={canManageBilling}
								className="underline"
								code={currentFeedback.code}
								fallback={
									currentFeedback.code === "PAYMENT_REQUIRED" ||
									currentFeedback.code === "PLAN_FEATURE_REQUIRED" ? null : (
										<Link to="/settings/usage" className="underline">
											Review usage
										</Link>
									)
								}
								site="quota-feedback"
							/>
						)}
						<Button
							variant="ghost"
							className="self-start"
							onClick={clearQuotaFeedback}
						>
							Dismiss
						</Button>
					</AlertDescription>
				</Alert>
			)}
			{promo && (
				<Banner
					tone="info"
					icon={<FlaskConical className="size-4 text-primary" />}
					onDismiss={() => {
						closedThisVisit.current = true;
						forceRender((n) => n + 1);
					}}
				>
					{promo.message}{" "}
					<a
						className="inline-flex items-center gap-0.5 font-medium underline underline-offset-2"
						href={promo.href}
						rel="noreferrer"
						target="_blank"
					>
						{promo.linkLabel}
						<ArrowUpRight className="size-3" aria-hidden="true" />
					</a>
					{promo.more && (
						<>
							{" "}
							<a
								className="inline-flex items-center gap-0.5 font-medium underline underline-offset-2"
								href={promo.more.href}
								rel="noreferrer"
								target="_blank"
							>
								{promo.more.label}
								<ArrowUpRight className="size-3" aria-hidden="true" />
							</a>
						</>
					)}
				</Banner>
			)}
		</>
	);
}
