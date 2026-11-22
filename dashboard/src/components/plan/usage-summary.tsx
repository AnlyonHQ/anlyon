import { PlanAction } from "@/components/extension-slots";
import { SettingsSection } from "@/components/settings/settings-page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Meter,
	MeterIndicator,
	MeterLabel,
	MeterTrack,
} from "@/components/ui/meter";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUsage, useQuotaStatus } from "@/hooks/api/use-plan";
import { formatCount, formatMoney } from "@/lib/plan-display";
import type { BillableDimension, FunctionRunUsage } from "@/lib/types";

interface Dimension {
	key: BillableDimension;
	label: string;
	bytes?: boolean;
	resets: boolean;
}
const actionDimensions: Dimension[] = [
	{ key: "actionInvokes", label: "Action executions", resets: true },
	{ key: "storage", label: "Stored data", bytes: true, resets: false },
	{ key: "bandwidth", label: "Egress", bytes: true, resets: true },
];
const otherDimensions: Dimension[] = [
	{ key: "messages", label: "Messages", resets: true },
];
export const utcDate = (iso: string) =>
	new Date(iso).toLocaleDateString(undefined, {
		dateStyle: "long",
		timeZone: "UTC",
	});
const formatUnits = (units: number, bytes?: boolean) =>
	bytes
		? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(units / 1024 ** 3)} GiB`
		: formatCount(units);

function FunctionRuns({ usage }: { usage: FunctionRunUsage }) {
	const { runsPerMonth, concurrentRuns } = usage.limits;
	const description =
		runsPerMonth === "unlimited"
			? `${formatCount(usage.used)} runs`
			: `${formatCount(usage.used)} of ${formatCount(runsPerMonth)} runs`;
	return (
		<section
			aria-label="Hosted functions"
			className="flex flex-col gap-2"
			data-testid="function-runs"
		>
			<Meter
				value={
					runsPerMonth === "unlimited" || runsPerMonth === 0
						? 0
						: Math.min(100, (usage.used / runsPerMonth) * 100)
				}
				aria-valuetext={description}
			>
				<div className="flex flex-wrap justify-between gap-2">
					<MeterLabel>Function runs</MeterLabel>
					<span className="text-sm tabular-nums">{description}</span>
				</div>
				<MeterTrack>
					<MeterIndicator />
				</MeterTrack>
			</Meter>
			<p className="text-sm text-muted-foreground tabular-nums">
				{formatCount(usage.running)} running now
				{concurrentRuns === "unlimited"
					? ""
					: ` · ${formatCount(concurrentRuns)} at once on your plan`}
				. Their action calls count as governed actions.
			</p>
		</section>
	);
}

export function UsageSummary({
	workspaceId,
	beta,
}: {
	workspaceId: string;
	beta?: { usageResetsAt: string };
}) {
	const query = useQuotaStatus(workspaceId);
	const actionAllowance = useCurrentUsage(workspaceId).data?.actionAllowance;
	if (query.isPending) return <Skeleton className="h-64 w-full" />;
	if (query.error || !query.data?.allowances)
		return (
			<Alert variant="error">
				<AlertTitle>Usage is unavailable</AlertTitle>
				<AlertDescription>
					<p>Refresh to retrieve your current allowances.</p>
					<Button variant="outline" onClick={() => query.refetch()}>
						Retry
					</Button>
				</AlertDescription>
			</Alert>
		);
	const { allowances, plan, functionRuns } = query.data;
	const showFunctionRuns =
		!!functionRuns && (functionRuns.available || functionRuns.used > 0);
	const otherInUse = otherDimensions.filter(
		({ key }) => allowances[key].usedUnits > 0,
	);
	const renderDimension = ({
		key,
		label: baseLabel,
		bytes,
		resets,
	}: Dimension) => {
		const label =
			key === "actionInvokes" && !beta ? "Governed actions" : baseLabel;
		const usage = allowances[key];
		const packs =
			key === "actionInvokes" && !beta && actionAllowance?.included != null
				? actionAllowance
				: null;
		const included = packs
			? (packs.included ?? 0) + packs.credits
			: usage.includedUnits;
		const used = formatUnits(usage.usedUnits, bytes);
		const description =
			included === null
				? `${used} used · custom allowance`
				: `${used} of ${formatUnits(included, bytes)} ${beta && !resets ? "capacity" : plan === "free" ? "available" : "included"}`;
		const credits = packs?.credits
			? `Includes ${formatCount(packs.credits)} from action packs.`
			: null;
		return (
			<div className="flex flex-col gap-2" key={key}>
				<Meter
					value={
						included ? Math.min(100, (usage.usedUnits / included) * 100) : 0
					}
					aria-valuetext={description}
				>
					<div className="flex flex-wrap justify-between gap-2">
						<MeterLabel>{label}</MeterLabel>
						<span className="text-sm tabular-nums">{description}</span>
					</div>
					<MeterTrack>
						<MeterIndicator />
					</MeterTrack>
				</Meter>
				{usage.reservedUnits ? (
					<p className="text-sm text-muted-foreground tabular-nums">
						{formatCount(usage.reservedUnits)} pending or uncertain executions
						reserved. Not billed.
					</p>
				) : null}
				{beta && included !== null ? (
					<p className="text-sm text-muted-foreground tabular-nums">
						{Math.max(
							0,
							included - usage.usedUnits - (usage.reservedUnits ?? 0),
						) === 0
							? "None"
							: formatUnits(
									Math.max(
										0,
										included - usage.usedUnits - (usage.reservedUnits ?? 0),
									),
									bytes,
								)}{" "}
						remaining
						{resets
							? ` · resets ${utcDate(beta.usageResetsAt)}`
							: " · frees up as you delete data"}
					</p>
				) : null}
				{credits ? (
					<p className="text-sm text-muted-foreground tabular-nums">
						{credits}
					</p>
				) : null}
			</div>
		);
	};
	return (
		<SettingsSection
			title="Monthly usage"
			description={
				beta
					? `Monthly allowances reset on ${utcDate(beta.usageResetsAt)} at 00:00 UTC. Stored data is capacity, so it does not reset.`
					: "Resets on the first day of each month at 00:00 UTC."
			}
		>
			<div className="flex flex-col gap-8">
				<div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
					{actionDimensions.map(renderDimension)}
					{showFunctionRuns && functionRuns ? (
						<FunctionRuns usage={functionRuns} />
					) : null}
				</div>
				{otherInUse.length > 0 ? (
					<section
						aria-label="Other usage"
						className="flex flex-col gap-4"
						data-testid="other-usage"
					>
						<h4 className="font-medium text-sm">Other usage</h4>
						<div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
							{otherInUse.map(renderDimension)}
						</div>
					</section>
				) : null}
				{beta ? (
					<p className="text-sm font-medium tabular-nums">
						Current charge: {formatMoney(0)}. No overage billing.
					</p>
				) : null}
				<div className="flex flex-col gap-1.5 border-t pt-5 text-sm">
					<p className="font-medium">
						{beta
							? "Early Beta Access has hard usage caps"
							: "No surprise bills"}
					</p>
					<p className="text-pretty text-muted-foreground">
						{beta
							? "Requests stop at the allowance until it resets or you free up room. Nothing is ever charged automatically."
							: plan === "free"
								? "This workspace has no plan, so actions are refused. Choose a plan to run them."
								: "You get an alert at 80% and at 100% of the governed actions allowance. A 10% buffer follows, then actions are refused until the month resets. Nothing is charged automatically."}{" "}
						No separate trace, span, approval, or public token charges.
					</p>
					{!beta && (
						<PlanAction
							className="w-fit text-foreground underline underline-offset-4 hover:no-underline"
							plan={plan}
							site="usage-summary"
						/>
					)}
				</div>
			</div>
		</SettingsSection>
	);
}
