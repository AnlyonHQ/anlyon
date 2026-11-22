import { Wallet } from "lucide-react";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	useBudgets,
	useDeleteBudget,
	usePutBudget,
} from "@/hooks/api/use-budgets";
import { useCan } from "@/hooks/api/use-permissions";
import type { Budget } from "@/lib/types";

export function KeyBudgetEditor({
	apiKeyId,
	workspaceId,
}: {
	apiKeyId: string;
	workspaceId?: string;
}) {
	const budgetsQuery = useBudgets(workspaceId);
	const budget = budgetsQuery.data?.find(
		(b: Budget) => b.apiKeyId === apiKeyId,
	);
	const canEdit = useCan(workspaceId)("limits.manage");

	return (
		<div className="flex items-center gap-2">
			{budget ? (
				<Badge variant={budget.enabled ? "soft" : "outline"} size="sm">
					{formatCents(budget.estimatedCostCents)} /{" "}
					{budget.monthlyCostCentsCap != null
						? formatCents(budget.monthlyCostCentsCap)
						: "uncapped"}
				</Badge>
			) : (
				<span className="text-muted-foreground text-xs">No budget</span>
			)}
			{canEdit && (
				<BudgetDialog
					apiKeyId={apiKeyId}
					workspaceId={workspaceId}
					budget={budget}
				/>
			)}
		</div>
	);
}

function BudgetDialog({
	apiKeyId,
	workspaceId,
	budget,
}: {
	apiKeyId: string;
	workspaceId?: string;
	budget?: Budget;
}) {
	const capId = useId();
	const invokesId = useId();
	const thresholdId = useId();

	const [capDollars, setCapDollars] = useState(
		budget?.monthlyCostCentsCap != null
			? (budget.monthlyCostCentsCap / 100).toFixed(2)
			: "",
	);
	const [invokeCap, setInvokeCap] = useState(
		budget?.dimensionCaps.actionInvokes?.toString() ?? "",
	);
	const [threshold, setThreshold] = useState(
		((budget?.alertThreshold ?? 0.8) * 100).toString(),
	);

	const putBudget = usePutBudget();
	const deleteBudget = useDeleteBudget();

	const save = () => {
		if (!workspaceId) return;
		const dollars = Number.parseFloat(capDollars);
		const invokes = Number.parseInt(invokeCap, 10);
		const alertPercent = Number.parseFloat(threshold);

		putBudget.mutate({
			apiKeyId,
			workspaceId,
			monthlyCostCentsCap: Number.isFinite(dollars)
				? Math.round(dollars * 100)
				: null,
			dimensionCaps: Number.isFinite(invokes) ? { actionInvokes: invokes } : {},
			alertThreshold: Number.isFinite(alertPercent)
				? Math.min(Math.max(alertPercent / 100, 0.1), 1)
				: 0.8,
			enabled: true,
		});
	};

	return (
		<Dialog>
			<DialogTrigger
				render={
					<Button
						size="xs"
						variant="ghost"
						title={budget ? "Edit budget" : "Set budget"}
					>
						<Wallet aria-hidden="true" />
						{budget ? "Edit" : "Set"}
					</Button>
				}
			/>
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>Budget for this key</DialogTitle>
					<DialogDescription>
						Requests from this key are rejected with 429 BUDGET_EXCEEDED once a
						cap is reached. You are alerted once per month at the threshold.
					</DialogDescription>
				</DialogHeader>

				<DialogPanel className="space-y-4 py-2">
					<Field>
						<FieldLabel htmlFor={capId}>
							Monthly Anlyon usage cost cap (USD)
						</FieldLabel>
						<Input
							id={capId}
							value={capDollars}
							onChange={(e) => setCapDollars(e.target.value)}
							placeholder="5.00"
							inputMode="decimal"
						/>
						<p className="text-muted-foreground text-xs">
							An estimate of what this key's Anlyon usage costs, from the same
							unit costs your invoice uses. It does not cap money an action
							moves. Leave blank for no cost cap.
						</p>
					</Field>

					<Field>
						<FieldLabel htmlFor={invokesId}>
							Action invocations cap (optional)
						</FieldLabel>
						<Input
							id={invokesId}
							value={invokeCap}
							onChange={(e) => setInvokeCap(e.target.value)}
							placeholder="1000"
							inputMode="numeric"
						/>
					</Field>

					<Field>
						<FieldLabel htmlFor={thresholdId}>Alert at (%)</FieldLabel>
						<Input
							id={thresholdId}
							value={threshold}
							onChange={(e) => setThreshold(e.target.value)}
							placeholder="80"
							inputMode="numeric"
						/>
					</Field>

					{budget ? (
						<div className="rounded-lg border border-border/40 bg-muted/30 p-3">
							<p className="mb-1 font-medium text-xs uppercase tracking-wide">
								This month
							</p>
							<p className="text-muted-foreground text-xs">
								{Object.entries(budget.usage)
									.filter(([, count]) => count > 0)
									.map(([dimension, count]) => `${dimension}: ${count}`)
									.join(" · ") || "No usage yet"}
							</p>
						</div>
					) : null}
				</DialogPanel>

				<DialogFooter>
					{budget ? (
						<DialogClose
							render={
								<Button
									variant="outline"
									disabled={!workspaceId || deleteBudget.isPending}
									onClick={() => {
										if (!workspaceId) return;
										deleteBudget.mutate({ apiKeyId, workspaceId });
									}}
								>
									Remove cap
								</Button>
							}
						/>
					) : (
						<DialogClose render={<Button variant="outline">Cancel</Button>} />
					)}
					<DialogClose
						render={
							<Button
								disabled={!workspaceId || putBudget.isPending}
								onClick={save}
							>
								Save budget
							</Button>
						}
					/>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}

function formatCents(cents: number): string {
	return `$${(cents / 100).toFixed(2)}`;
}
