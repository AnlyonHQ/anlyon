import { Check, Users } from "lucide-react";
import { hasPlanActions, PlanAction } from "@/components/extension-slots";
import { useWorkspace } from "@/contexts/workspace-context";
import { useCan } from "@/hooks/api/use-permissions";
import { usePlanAccess } from "@/hooks/use-plan-access";
import { cn } from "@/lib/utils";

const TEAM_FEATURES = [
	{
		name: "Single sign-on",
		detail: "OIDC or SAML, found from the email domain",
	},
	{
		name: "Directory sync",
		detail: "SCIM provisioning from your identity provider",
	},
	{
		name: "Audit streaming",
		detail: "Every audit event, sent to your own sink",
	},
	{ name: "Secret stores", detail: "Credentials read from your own vault" },
	{
		name: "Roles per environment",
		detail: "A different role in each environment",
	},
];

export function TeamPlanNotice({
	feature,
	hasConfiguration = false,
	variant = "card",
	className,
}: {
	feature: string;
	hasConfiguration?: boolean;
	variant?: "card" | "inline";
	className?: string;
}) {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const { teamPlanRequired } = usePlanAccess(workspaceId);
	const canManageBilling = useCan(workspaceId)("billing.manage");
	if (!teamPlanRequired) return null;

	const body = hasConfiguration
		? "Your current setup keeps working. Changing it, or adding another, needs the Team plan."
		: `${feature} is included on the Team and Enterprise plans.`;
	const actions = hasPlanActions();
	if (variant === "inline")
		return (
			<div
				className={cn(
					"flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-gradient-to-r from-primary/[0.07] via-muted/40 to-muted/40 px-4 py-3",
					className,
				)}
				data-testid="team-plan-notice"
				role="status"
			>
				<div className="flex min-w-0 items-start gap-3">
					<span
						aria-hidden="true"
						className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
					>
						<Users className="size-3.5" />
					</span>
					<div className="min-w-0">
						<p className="font-medium text-sm">{feature} needs the Team plan</p>
						<p className="mt-0.5 text-muted-foreground text-xs">{body}</p>
					</div>
				</div>
				<PlanAction
					canManageBilling={canManageBilling}
					site="team-notice-inline"
				/>
			</div>
		);

	const current = feature.toLowerCase();
	return (
		<section
			className={cn(
				"grid overflow-hidden rounded-xl border bg-card",
				actions && "md:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]",
				className,
			)}
			data-testid="team-plan-notice"
			role="status"
		>
			<div className="space-y-6 p-6 md:p-8">
				<div className="space-y-2.5">
					<span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 font-medium text-primary text-xs">
						<Users aria-hidden="true" className="size-3.5" />
						Team plan
					</span>
					<h2 className="font-heading text-2xl leading-tight">
						{feature} needs the Team plan
					</h2>
					<p className="max-w-prose text-muted-foreground text-sm leading-relaxed">
						{body}
					</p>
				</div>

				<ul className="grid gap-2 sm:grid-cols-2">
					{TEAM_FEATURES.map((item) => {
						const here = item.name.toLowerCase() === current;
						return (
							<li
								className={cn(
									"flex gap-2.5 rounded-lg border px-3 py-2.5",
									here
										? "border-primary/40 bg-primary/5"
										: "border-transparent bg-muted/40",
								)}
								key={item.name}
							>
								<Check
									aria-hidden="true"
									className="mt-0.5 size-4 shrink-0 text-primary"
								/>
								<span className="min-w-0">
									<span className="block font-medium text-sm">{item.name}</span>
									<span className="block text-muted-foreground text-xs">
										{item.detail}
									</span>
								</span>
							</li>
						);
					})}
				</ul>

				{actions ? (
					<div className="flex flex-wrap items-center gap-x-3 gap-y-3">
						<PlanAction
							canManageBilling={canManageBilling}
							site="team-notice"
						/>
					</div>
				) : null}
			</div>

			<PlanAction
				canManageBilling={canManageBilling}
				site="team-notice-aside"
			/>
		</section>
	);
}
