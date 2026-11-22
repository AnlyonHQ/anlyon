"use client";

import { ChevronRight, Loader2 } from "lucide-react";
import {
	type ReactElement,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import {
	Sheet,
	SheetClose,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetPanel,
	SheetPopup,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { useEnvironmentActions } from "@/hooks/api/use-actions";
import {
	useConditionAssist,
	useCreateApprovalPolicy,
	useUpdateApprovalPolicy,
} from "@/hooks/api/use-approval-policies";
import { useEnvironments } from "@/hooks/api/use-environments";
import { conditionInWords } from "@/lib/action-summary";
import {
	type BuilderState,
	buildCondition,
	builderFields,
	OPERATORS,
	parseCondition,
} from "@/lib/policy-builder";
import {
	describePolicyConditions,
	describePolicyIntent,
	needsBroadConfirmation,
	type PolicyScope,
	policyFormProblem,
	SCOPE_LABEL,
	scopeOf,
	targetingFor,
} from "@/lib/policy-targeting";
import type {
	ApprovalDecider,
	ApprovalPolicy,
	ApprovalPolicyEffect,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { PolicyConditionEditor } from "./policy-condition-editor";

const SCOPES: PolicyScope[] = [
	"specific_action",
	"all_actions",
	"custom_requests",
	"all_requests",
];

export interface PolicyFormInitial {
	environmentId?: string;
	actionName?: string;
}

export function PolicyFormDialog({
	workspaceId,
	trigger,
	policy,
	initial,
}: {
	workspaceId?: string;
	trigger: ReactElement;
	policy?: ApprovalPolicy;
	initial?: PolicyFormInitial;
}) {
	const editing = policy !== undefined;
	const [open, setOpen] = useState(false);
	const [discarding, setDiscarding] = useState(false);
	const opened = useRef(false);
	const baseline = useRef("");
	const [name, setName] = useState(policy?.name ?? "");
	const [environmentId, setEnvironmentId] = useState(
		policy?.environmentId ?? initial?.environmentId ?? "",
	);
	const [scope, setScope] = useState<PolicyScope>(
		policy ? scopeOf(policy) : "specific_action",
	);
	const [actionName, setActionName] = useState(
		policy?.match.actionName ?? initial?.actionName ?? "",
	);
	const [effect, setEffect] = useState<ApprovalPolicyEffect>(
		policy?.effect ?? "require_approval",
	);
	const [requiredApprovals, setRequiredApprovals] = useState(
		policy?.requiredApprovals ?? 1,
	);
	const [decidedBy, setDecidedBy] = useState<ApprovalDecider>(
		policy?.decidedBy ?? "team",
	);
	const [priority, setPriority] = useState(policy?.priority ?? 100);
	const [condition, setCondition] = useState(policy?.match.condition ?? "");
	const [convertedLegacy, setConvertedLegacy] = useState(false);
	const [broadConfirmed, setBroadConfirmed] = useState(false);
	const [changeNote, setChangeNote] = useState("");
	const [nameTouched, setNameTouched] = useState(false);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [whenMode, setWhenMode] = useState<"every" | "only" | "custom">(
		"every",
	);
	const [whenTouched, setWhenTouched] = useState(false);
	const [builder, setBuilder] = useState<BuilderState>({
		field: "",
		op: ">",
		value: "",
	});
	const formId = useId();
	const changeNoteId = `${formId}-change-note`;
	const [serverError, setServerError] = useState<string | null>(null);

	const envQuery = useEnvironments(workspaceId);
	const environments = envQuery.data ?? [];
	const actionsQuery = useEnvironmentActions(workspaceId, environmentId);
	const actions = actionsQuery.data ?? [];
	const selectedAction =
		scope === "specific_action"
			? actions.find((action) => action.name === actionName)
			: undefined;
	const fieldsKey = JSON.stringify([
		selectedAction?.inputSchema ?? null,
		selectedAction?.impact ?? null,
	]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: fieldsKey is the action's content.
	const fields = useMemo(() => builderFields(selectedAction), [fieldsKey]);
	const create = useCreateApprovalPolicy(workspaceId);
	const update = useUpdateApprovalPolicy(workspaceId);
	const pending = create.isPending || update.isPending;

	useEffect(() => {
		if (!open) {
			opened.current = false;
			return;
		}
		if (opened.current) return;
		opened.current = true;
		setDiscarding(false);
		baseline.current = JSON.stringify([
			policy?.name ?? "",
			policy?.environmentId ?? initial?.environmentId ?? "",
			policy ? scopeOf(policy) : "specific_action",
			policy?.match.actionName ?? initial?.actionName ?? "",
			policy?.effect ?? "require_approval",
			policy?.requiredApprovals ?? 1,
			policy?.priority ?? 100,
			policy?.match.condition ?? "",
			false,
			"",
			policy?.decidedBy ?? "team",
		]);
		setName(policy?.name ?? "");
		setEnvironmentId(policy?.environmentId ?? initial?.environmentId ?? "");
		setScope(policy ? scopeOf(policy) : "specific_action");
		setActionName(policy?.match.actionName ?? initial?.actionName ?? "");
		setEffect(policy?.effect ?? "require_approval");
		setRequiredApprovals(policy?.requiredApprovals ?? 1);
		setDecidedBy(policy?.decidedBy ?? "team");
		setPriority(policy?.priority ?? 100);
		setCondition(policy?.match.condition ?? "");
		setConvertedLegacy(false);
		setBroadConfirmed(false);
		setChangeNote("");
		setServerError(null);
		setNameTouched(false);
		setAdvancedOpen(false);
		setWhenTouched(false);
		setWhenMode(policy?.match.condition ? "custom" : "every");
		setBuilder({ field: "", op: ">", value: "" });
	}, [open, policy, initial?.environmentId, initial?.actionName]);

	useEffect(() => {
		if (!open || editing || environmentId || environments.length === 0) return;
		const fallback =
			environments.find((env) => env.isDefault) ?? environments[0];
		if (!fallback) return;
		setEnvironmentId(fallback.id);
		const base = JSON.parse(baseline.current || "[]") as unknown[];
		base[1] = fallback.id;
		baseline.current = JSON.stringify(base);
	}, [open, editing, environmentId, environments]);

	const dirty =
		JSON.stringify([
			name,
			environmentId,
			scope,
			actionName,
			effect,
			requiredApprovals,
			priority,
			condition,
			convertedLegacy,
			changeNote,
			decidedBy,
		]) !== baseline.current;
	useEffect(() => {
		if (!open || !dirty) return;
		const warn = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [open, dirty]);
	const changeOpen = (next: boolean) => {
		if (!next && pending) return;
		if (!next && dirty) {
			setDiscarding(true);
			return;
		}
		setOpen(next);
	};

	useEffect(() => {
		if (!open || whenTouched) return;
		const parsed = parseCondition(condition, fields);
		if (parsed) {
			setBuilder((current) =>
				current.field === parsed.field &&
				current.op === parsed.op &&
				current.value === parsed.value
					? current
					: parsed,
			);
			setWhenMode("only");
		} else {
			setWhenMode(condition.trim() ? "custom" : "every");
		}
	}, [open, whenTouched, fields, condition]);

	const applyBuilder = (next: BuilderState) => {
		setWhenTouched(true);
		setBuilder(next);
		const chosen = fields.find((f) => f.name === next.field);
		setCondition(
			chosen ? (buildCondition(chosen, next.op, next.value) ?? "") : "",
		);
	};
	const chooseWhen = (mode: "every" | "only") => {
		setWhenTouched(true);
		setWhenMode(mode);
		if (mode === "every") {
			setCondition("");
			return;
		}
		const current = fields.find((f) => f.name === builder.field);
		const first = current ?? fields[0];
		if (!first) return;
		applyBuilder(
			current
				? builder
				: {
						field: first.name,
						op: OPERATORS[first.kind][0]?.op ?? ">",
						value: "",
					},
		);
	};
	const builderField = fields.find((f) => f.name === builder.field);
	const builderIncomplete = whenMode === "only" && !condition.trim();

	const words = conditionInWords(condition, selectedAction ?? { impact: null });
	const verb =
		effect === "auto_deny"
			? "Refuse"
			: effect === "auto_approve"
				? "Auto-approve"
				: "Approve";
	const targetWords =
		scope === "specific_action"
			? actionName || "an action"
			: SCOPE_LABEL[scope].toLowerCase();
	const autoName = `${verb} ${targetWords}${
		condition.trim()
			? words
				? ` when ${words}`
				: " (custom condition)"
			: " every time"
	}`.slice(0, 80);
	const effectiveName = editing || nameTouched ? name : autoName;

	const environmentName =
		environments.find((env) => env.id === environmentId)?.name ?? "";
	const formProblem = policyFormProblem({
		name: effectiveName,
		environmentId,
		scope,
		actionName,
		effect,
		broadConfirmed,
	});
	const problem =
		formProblem ??
		(builderIncomplete
			? "Enter a value for the condition, or choose Every call."
			: null);
	const intent = useMemo(
		() => describePolicyIntent({ effect, scope, actionName, environmentName }),
		[effect, scope, actionName, environmentName],
	);
	const broad = needsBroadConfirmation(scope, effect);
	const hasLegacy =
		!!policy &&
		!convertedLegacy &&
		(policy.match.minAmount != null ||
			Object.keys(policy.match.conditions ?? {}).length > 0);
	const legacy = useConditionAssist(
		workspaceId,
		open && hasLegacy && policy
			? {
					environmentId: policy.environmentId,
					matchKind: policy.match.kind,
					policyId: policy.id,
				}
			: null,
	);
	const olderCondition = legacy.data?.legacyCondition ?? null;
	const otherConditions =
		policy && !convertedLegacy
			? describePolicyConditions({ ...policy.match, condition: null })
			: policy
				? describePolicyConditions({
						...policy.match,
						minAmount: null,
						conditions: null,
						condition: null,
					})
				: [];
	const convertLegacy = () => {
		if (!olderCondition) return;
		setCondition((current) =>
			current.trim()
				? `(${olderCondition}) && (${current.trim()})`
				: olderCondition,
		);
		setConvertedLegacy(true);
	};

	const submit = () => {
		setServerError(null);
		if (pending) return;
		if (problem) {
			setServerError(problem);
			const suffix = !effectiveName.trim()
				? "name"
				: !environmentId
					? "env"
					: scope === "specific_action" && !actionName
						? "action"
						: builderIncomplete
							? "value"
							: "broad";
			if (suffix === "name" || suffix === "env") setAdvancedOpen(true);
			setTimeout(() => document.getElementById(`${formId}-${suffix}`)?.focus());
			return;
		}
		if (
			!Number.isInteger(requiredApprovals) ||
			requiredApprovals < 1 ||
			requiredApprovals > 20 ||
			!Number.isInteger(priority) ||
			priority < 0 ||
			priority > 10000
		) {
			setServerError("Use 1–20 approvals and a priority from 0–10,000.");
			return;
		}
		const expression = condition.trim();
		const target = targetingFor(scope, actionName);
		const onSuccess = () => setOpen(false);
		const onError = (error: Error) => setServerError(error.message);
		const note = changeNote.trim() ? { changeNote: changeNote.trim() } : {};
		const decider =
			effect === "require_approval" && (policy || decidedBy === "end_user")
				? { decidedBy }
				: {};
		if (policy) {
			update.mutate(
				{
					policyId: policy.id,
					name: effectiveName,
					effect,
					requiredApprovals,
					priority,
					condition: expression || null,
					...(convertedLegacy ? { minAmount: null, conditions: null } : {}),
					matchKind: target.matchKind,
					matchActionName: target.matchActionName,
					...(broad ? { acknowledgeBroadScope: true } : {}),
					...decider,
					...note,
				},
				{ onSuccess, onError },
			);
			return;
		}
		create.mutate(
			{
				name: effectiveName,
				environmentId,
				effect,
				requiredApprovals,
				priority,
				...(expression ? { condition: expression } : {}),
				matchKind: target.matchKind,
				...(target.matchActionName
					? { matchActionName: target.matchActionName }
					: {}),
				...(broad ? { acknowledgeBroadScope: true } : {}),
				...decider,
				...note,
			},
			{ onSuccess, onError },
		);
	};

	return (
		<Sheet onOpenChange={changeOpen} open={open}>
			<SheetTrigger render={trigger} />
			<SheetPopup
				className="w-full max-w-[880px] motion-reduce:transition-none"
				showCloseButton={!pending}
			>
				<SheetHeader className="shrink-0 border-b pr-12">
					<SheetTitle>
						{editing ? "Edit approval policy" : "Create approval policy"}
					</SheetTitle>
					<SheetDescription>
						Choose an action and when this policy applies.
						{environmentName ? (
							<>
								{" "}
								In <span className="text-foreground">{environmentName}</span>.
							</>
						) : null}
					</SheetDescription>
				</SheetHeader>
				<SheetPanel
					className="space-y-7 py-6"
					onKeyDown={(event) => {
						if (
							event.key === "Enter" &&
							event.target instanceof HTMLInputElement &&
							event.target.type !== "radio" &&
							!pending
						) {
							event.preventDefault();
							submit();
						}
					}}
				>
					<section className="space-y-2">
						<StepTitle>Which action?</StepTitle>
						{scope === "specific_action" ? (
							<div className="space-y-1.5">
								<Label className="sr-only" htmlFor={`${formId}-action`}>
									Action
								</Label>
								<NativeSelect
									className="w-full"
									disabled={!environmentId}
									id={`${formId}-action`}
									onChange={(e) => {
										setActionName(e.target.value);
										setWhenTouched(false);
									}}
									value={actionName}
								>
									<NativeSelectOption value="">
										{environmentId
											? actionsQuery.isLoading
												? "Loading actions…"
												: "Select an action…"
											: "Choose an environment first"}
									</NativeSelectOption>
									{actions.map((action) => (
										<NativeSelectOption key={action.id} value={action.name}>
											{action.name}
										</NativeSelectOption>
									))}
								</NativeSelect>
								{selectedAction?.description ? (
									<p className="text-muted-foreground text-xs">
										{selectedAction.description}
									</p>
								) : null}
							</div>
						) : (
							<p className="text-sm">
								{SCOPE_LABEL[scope]}.{" "}
								<span className="text-muted-foreground">
									Change it under Advanced.
								</span>
							</p>
						)}
					</section>

					<section className="space-y-2">
						<StepTitle>What happens?</StepTitle>
						<Label className="sr-only" htmlFor={`${formId}-effect`}>
							What happens
						</Label>
						<NativeSelect
							className="w-full"
							id={`${formId}-effect`}
							onChange={(e) =>
								setEffect(e.target.value as ApprovalPolicyEffect)
							}
							value={effect}
						>
							<NativeSelectOption value="require_approval">
								A person must approve the call
							</NativeSelectOption>
							<NativeSelectOption value="auto_deny">
								Anlyon refuses the call
							</NativeSelectOption>
							<NativeSelectOption value="auto_approve">
								Anlyon approves the call without asking
							</NativeSelectOption>
						</NativeSelect>
					</section>

					{effect === "require_approval" ? (
						<section className="space-y-2">
							<StepTitle>Decided by</StepTitle>
							<Label className="sr-only" htmlFor={`${formId}-decider`}>
								Decided by
							</Label>
							<NativeSelect
								className="w-full"
								id={`${formId}-decider`}
								onChange={(e) =>
									setDecidedBy(
										e.target.value === "end_user" ? "end_user" : "team",
									)
								}
								value={decidedBy}
							>
								<NativeSelectOption value="team">Team</NativeSelectOption>
								<NativeSelectOption value="end_user">
									The user
								</NativeSelectOption>
							</NativeSelect>
							<p className="text-muted-foreground text-xs">
								{decidedBy === "end_user"
									? "The user the call acts for decides in your app. It does not reach this inbox."
									: "Your team decides in Approvals."}
							</p>
						</section>
					) : null}

					<section className="space-y-2">
						<StepTitle>When?</StepTitle>
						{whenMode === "custom" ? (
							<div className="space-y-2 rounded-lg border p-3 text-sm">
								<p>A condition written by hand applies:</p>
								<code className="block break-all font-mono text-xs">
									{condition.trim()}
								</code>
								<p className="text-muted-foreground text-xs">
									Change it under Advanced, or start again with{" "}
									<button
										className="underline underline-offset-2"
										onClick={() => chooseWhen("every")}
										type="button"
									>
										Every call
									</button>
									.
								</p>
							</div>
						) : (
							<div className="space-y-2">
								<WhenChoice
									checked={whenMode === "every"}
									id={`${formId}-every`}
									label="Every call"
									name={`${formId}-when`}
									onSelect={() => chooseWhen("every")}
								/>
								<div
									className={cn(
										"rounded-lg border p-3 transition-colors",
										whenMode === "only" && "border-foreground/60",
									)}
								>
									<WhenChoice
										checked={whenMode === "only"}
										disabled={fields.length === 0}
										id={`${formId}-only`}
										label="Only when"
										name={`${formId}-when`}
										onSelect={() => chooseWhen("only")}
										plain
									/>
									{fields.length === 0 ? (
										<p className="ms-6 mt-1 text-muted-foreground text-xs">
											{scope === "specific_action" && actionName
												? "This action's inputs cannot be compared here. Write a condition under Advanced."
												: "Choose an action to compare one of its inputs."}
										</p>
									) : whenMode === "only" && builderField ? (
										<div className="ms-6 mt-3 space-y-2">
											<div className="flex flex-wrap gap-2">
												<Label className="sr-only" htmlFor={`${formId}-field`}>
													Field
												</Label>
												<NativeSelect
													className="w-44"
													id={`${formId}-field`}
													onChange={(e) => {
														const next = fields.find(
															(f) => f.name === e.target.value,
														);
														if (!next) return;
														applyBuilder({
															field: next.name,
															op: OPERATORS[next.kind][0]?.op ?? ">",
															value: "",
														});
													}}
													value={builder.field}
												>
													{fields.map((f) => (
														<NativeSelectOption key={f.name} value={f.name}>
															{f.name}
														</NativeSelectOption>
													))}
												</NativeSelect>
												<Label
													className="sr-only"
													htmlFor={`${formId}-comparison`}
												>
													Comparison
												</Label>
												<NativeSelect
													className="w-44"
													id={`${formId}-comparison`}
													onChange={(e) =>
														applyBuilder({
															...builder,
															op: e.target.value as BuilderState["op"],
														})
													}
													value={builder.op}
												>
													{OPERATORS[builderField.kind].map((o) => (
														<NativeSelectOption key={o.op} value={o.op}>
															{o.label}
														</NativeSelectOption>
													))}
												</NativeSelect>
												<Label className="sr-only" htmlFor={`${formId}-value`}>
													Value
												</Label>
												{builderField.kind === "choice" ||
												builderField.kind === "flag" ? (
													<NativeSelect
														className="w-44"
														id={`${formId}-value`}
														onChange={(e) =>
															applyBuilder({
																...builder,
																value: e.target.value,
															})
														}
														value={builder.value}
													>
														<NativeSelectOption value="">
															Choose…
														</NativeSelectOption>
														{builderField.options.map((option) => (
															<NativeSelectOption key={option} value={option}>
																{option}
															</NativeSelectOption>
														))}
													</NativeSelect>
												) : (
													<div className="flex items-center gap-1.5">
														{builderField.kind === "money" ? (
															<span className="text-muted-foreground text-sm">
																{(
																	selectedAction?.impact?.unit ?? ""
																).toUpperCase()}
															</span>
														) : null}
														<Input
															autoComplete="off"
															className="w-36"
															id={`${formId}-value`}
															inputMode="decimal"
															onChange={(e) =>
																applyBuilder({
																	...builder,
																	value: e.target.value,
																})
															}
															placeholder={
																builderField.kind === "money"
																	? "100.00"
																	: builderField.kind === "text"
																		? "text"
																		: "0"
															}
															value={builder.value}
														/>
													</div>
												)}
											</div>
											{builderField.kind === "money" && condition.trim() ? (
												<p className="text-muted-foreground text-xs">
													This action sends the amount in the smallest unit of
													the currency, so Anlyon checks{" "}
													<code className="font-mono">{condition.trim()}</code>.
												</p>
											) : null}
											{builderField.kind === "list" ? (
												<p className="text-muted-foreground text-xs">
													Counts the entries in {builderField.name}.
												</p>
											) : null}
										</div>
									) : null}
								</div>
							</div>
						)}
					</section>

					<p
						aria-live="polite"
						className="break-words rounded-lg bg-muted/50 px-4 py-3 text-sm leading-relaxed"
						data-testid="policy-intent"
					>
						{intent}
						{condition.trim()
							? words && whenMode === "only"
								? ` Only when ${words}.`
								: ` Only when: ${condition.trim()}.`
							: ""}
						{otherConditions.length
							? ` Also requires: ${otherConditions.join("; ")}. These restrictions are preserved when saving.`
							: ""}
					</p>

					{broad ? (
						<div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
							<Checkbox
								checked={broadConfirmed}
								id={`${formId}-broad`}
								onCheckedChange={(checked) =>
									setBroadConfirmed(checked === true)
								}
							/>
							<Label
								className="font-normal text-sm leading-snug"
								htmlFor={`${formId}-broad`}
							>
								This denies{" "}
								{scope === "all_requests" ? "every request" : "every action"} in{" "}
								{environmentName || "this environment"}, not one. I mean that.
							</Label>
						</div>
					) : null}

					{serverError ? (
						<p className="text-destructive text-sm" role="alert">
							{serverError}
						</p>
					) : null}

					<Collapsible
						className="border-t"
						onOpenChange={setAdvancedOpen}
						open={advancedOpen}
					>
						<CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 py-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
							<span className="font-medium">Advanced</span>
							<span className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
								<span className="truncate">
									Name, environment, scope, approvers, order, condition code
								</span>
								<ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[panel-open]:rotate-90" />
							</span>
						</CollapsibleTrigger>
						<CollapsiblePanel>
							<div className="space-y-6 pt-2 pb-2">
								<div className="space-y-1.5">
									<Label htmlFor={`${formId}-name`}>Name</Label>
									<Input
										autoComplete="off"
										id={`${formId}-name`}
										maxLength={80}
										onChange={(e) => {
											setName(e.target.value);
											setNameTouched(true);
										}}
										value={effectiveName}
									/>
									{!editing && !nameTouched ? (
										<p className="text-muted-foreground text-xs">
											Filled in from your choices until you change it.
										</p>
									) : null}
								</div>
								<div className="grid gap-4 sm:grid-cols-2">
									<div className="space-y-1.5">
										<Label htmlFor={`${formId}-env`}>Environment</Label>
										<NativeSelect
											className="w-full"
											disabled={editing}
											id={`${formId}-env`}
											onChange={(e) => {
												setEnvironmentId(e.target.value);
												setActionName("");
											}}
											value={environmentId}
										>
											{environmentId ? null : (
												<NativeSelectOption value="">
													Select an environment…
												</NativeSelectOption>
											)}
											{environments.map((env) => (
												<NativeSelectOption key={env.id} value={env.id}>
													{env.name}
												</NativeSelectOption>
											))}
										</NativeSelect>
									</div>
									<div className="space-y-1.5">
										<Label htmlFor={`${formId}-scope`}>Matches</Label>
										<NativeSelect
											className="w-full"
											id={`${formId}-scope`}
											onChange={(e) => {
												setScope(e.target.value as PolicyScope);
												setBroadConfirmed(false);
											}}
											value={scope}
										>
											{SCOPES.map((option) => (
												<NativeSelectOption key={option} value={option}>
													{SCOPE_LABEL[option]}
												</NativeSelectOption>
											))}
										</NativeSelect>
									</div>
								</div>
								<div className="grid grid-cols-2 gap-3">
									<div className="space-y-1.5">
										<Label htmlFor={`${formId}-req`}>Required approvals</Label>
										<Input
											id={`${formId}-req`}
											max={20}
											min={1}
											onChange={(e) =>
												setRequiredApprovals(Number(e.target.value))
											}
											type="number"
											value={requiredApprovals}
										/>
										<p className="text-muted-foreground text-xs">
											How many people must approve.
										</p>
									</div>
									<div className="space-y-1.5">
										<Label htmlFor={`${formId}-prio`}>Priority</Label>
										<Input
											id={`${formId}-prio`}
											max={10000}
											min={0}
											onChange={(e) => setPriority(Number(e.target.value))}
											type="number"
											value={priority}
										/>
										<p className="text-muted-foreground text-xs">
											Lower numbers are checked first. The first policy that
											matches decides.
										</p>
									</div>
								</div>
								<div className="space-y-1.5">
									{environmentId ? (
										<PolicyConditionEditor
											key={`${environmentId}:${scope}:${actionName}`}
											environmentId={environmentId}
											matchActionName={
												targetingFor(scope, actionName).matchActionName ?? null
											}
											matchKind={targetingFor(scope, actionName).matchKind}
											onChange={(next) => {
												setCondition(next);
												setWhenTouched(false);
											}}
											value={condition}
											workspaceId={workspaceId}
										/>
									) : (
										<p className="text-muted-foreground text-sm">
											Choose an environment to add a condition.
										</p>
									)}
								</div>

								{hasLegacy && policy ? (
									<div className="space-y-2 rounded-lg bg-muted/50 p-3 text-sm">
										<p>
											This policy also uses the older fields:{" "}
											{describePolicyConditions({
												...policy.match,
												agentId: null,
												userId: null,
												tags: null,
												condition: null,
											}).join("; ")}
											. They keep working as they are.
										</p>
										{olderCondition ? (
											<Button
												onClick={convertLegacy}
												size="xs"
												type="button"
												variant="outline"
											>
												Convert to a condition
											</Button>
										) : null}
									</div>
								) : null}

								<Field>
									<FieldLabel htmlFor={changeNoteId}>
										Change note (optional)
									</FieldLabel>
									<Input
										aria-describedby={`${changeNoteId}-help`}
										autoComplete="off"
										id={changeNoteId}
										maxLength={1000}
										name="changeNote"
										onChange={(event) => setChangeNote(event.target.value)}
										placeholder="Why this change, for example the ticket or approval"
										value={changeNote}
									/>
									<FieldDescription id={`${changeNoteId}-help`}>
										Recorded with this version in the policy's history. A
										recorded version cannot be edited.
									</FieldDescription>
								</Field>
							</div>
						</CollapsiblePanel>
					</Collapsible>
				</SheetPanel>
				<SheetFooter className="shrink-0">
					{discarding ? (
						<div
							className="flex w-full flex-wrap items-center justify-between gap-3"
							role="alert"
						>
							<p className="text-sm">Discard your unsaved policy changes?</p>
							<div className="flex gap-2">
								<Button variant="outline" onClick={() => setDiscarding(false)}>
									Keep editing
								</Button>
								<Button variant="destructive" onClick={() => setOpen(false)}>
									Discard changes
								</Button>
							</div>
						</div>
					) : (
						<>
							<SheetClose
								disabled={pending}
								render={<Button variant="ghost">Cancel</Button>}
							/>
							<Button
								disabled={pending}
								onClick={submit}
								title={problem ?? undefined}
							>
								{pending ? (
									<Loader2
										className="animate-spin motion-reduce:animate-none"
										data-icon="inline-start"
										aria-hidden="true"
									/>
								) : null}
								{editing ? "Save changes" : "Create"}
							</Button>
						</>
					)}
				</SheetFooter>
			</SheetPopup>
		</Sheet>
	);
}

function StepTitle({ children }: { children: React.ReactNode }) {
	return (
		<h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
			{children}
		</h3>
	);
}

function WhenChoice({
	id,
	name,
	label,
	checked,
	disabled = false,
	plain = false,
	onSelect,
}: {
	id: string;
	name: string;
	label: string;
	checked: boolean;
	disabled?: boolean;
	plain?: boolean;
	onSelect: () => void;
}) {
	return (
		<label
			className={cn(
				"flex items-center gap-3 text-sm",
				!plain && "rounded-lg border p-3 transition-colors",
				!plain && checked && "border-foreground/60",
				disabled ? "text-muted-foreground" : "cursor-pointer",
			)}
			htmlFor={id}
		>
			<input
				checked={checked}
				className="size-4 accent-foreground"
				disabled={disabled}
				id={id}
				name={name}
				onChange={onSelect}
				type="radio"
			/>
			{label}
		</label>
	);
}
