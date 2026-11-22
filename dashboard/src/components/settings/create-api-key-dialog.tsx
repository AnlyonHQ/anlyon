import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxGroup } from "@/components/ui/checkbox-group";
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogForm,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";
import { Fieldset, FieldsetLegend } from "@/components/ui/fieldset";
import { Frame, FramePanel } from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import {
	ALL_SCOPES,
	OFFERED_SCOPES,
	presetForSelection,
	READ_ONLY_SCOPES,
	SCOPE_GROUPS,
	type ScopeGroup,
	STANDARD_SCOPES,
} from "@/lib/api-key-scopes";
import type { Environment } from "@/lib/types";

const RESOURCE_LABELS: Record<string, string> = { "end-users": "users" };

const PRESETS = [
	{
		value: "standard",
		label: "Standard",
		description:
			"What an agent needs. It cannot read or write secrets, decide approvals or change budgets.",
	},
	{
		value: "read-only",
		label: "Read only",
		description: "Observe resources without changing them.",
	},
	{
		value: "full",
		label: "Full access",
		description: "Every scope, including secrets and budgets.",
	},
] as const;

export interface CreateApiKeyDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	apiKeyName: string;
	onApiKeyNameChange: (value: string) => void;
	environments?: Environment[];
	environmentId?: string;
	onEnvironmentChange?: (value: string) => void;
	selectedScopes: string[];
	onScopesChange: (scopes: string[]) => void;
	endUserRequired?: boolean;
	onEndUserRequiredChange?: (value: boolean) => void;
	onSubmit: () => void;
	isPending: boolean;
}

export function CreateApiKeyDialog({
	open,
	onOpenChange,
	apiKeyName,
	onApiKeyNameChange,
	environments,
	environmentId,
	onEnvironmentChange,
	selectedScopes,
	onScopesChange,
	endUserRequired,
	onEndUserRequiredChange,
	onSubmit,
	isPending,
}: CreateApiKeyDialogProps) {
	const nameId = useId();
	const endUserId = useId();
	const environmentSelectId = useId();
	const presetIdPrefix = useId();
	const scopeIdPrefix = useId();
	const selected = new Set(selectedScopes);
	const preset = presetForSelection(selectedScopes);

	const setPreset = (value: string) => {
		if (value === "full") onScopesChange([...ALL_SCOPES]);
		else if (value === "standard") onScopesChange([...STANDARD_SCOPES]);
		else if (value === "read-only") onScopesChange([...READ_ONLY_SCOPES]);
	};

	const toggleScope = (scope: string, checked: boolean) => {
		const next = new Set(selected);
		if (checked) next.add(scope);
		else next.delete(scope);
		onScopesChange(OFFERED_SCOPES.filter((s) => next.has(s)));
	};

	const toggleGroup = (scopes: readonly string[], checked: boolean) => {
		const next = new Set(selected);
		for (const scope of scopes) {
			if (checked) next.add(scope);
			else next.delete(scope);
		}
		onScopesChange(OFFERED_SCOPES.filter((s) => next.has(s)));
	};

	const renderGroup = (group: ScopeGroup) => {
		const groupId = `${scopeIdPrefix}-group-${group.resource}`;
		const groupSelected = group.scopes.filter((s) => selected.has(s)).length;
		const allInGroup = groupSelected === group.scopes.length;
		const someInGroup = groupSelected > 0 && !allInGroup;
		return (
			<div key={group.resource} className="flex flex-col gap-1.5">
				<label
					htmlFor={groupId}
					className="flex min-h-6 cursor-pointer items-center gap-2 font-medium text-sm capitalize max-sm:min-h-11"
				>
					<Checkbox
						id={groupId}
						checked={allInGroup}
						indeterminate={someInGroup}
						onCheckedChange={(checked) =>
							toggleGroup(group.scopes, checked === true)
						}
					/>
					{RESOURCE_LABELS[group.resource] ?? group.resource.replace(/-/g, " ")}
				</label>
				<div className="ml-6 flex flex-wrap gap-x-4 gap-y-1">
					{group.scopes.map((scope) => (
						<label
							key={scope}
							htmlFor={`${scopeIdPrefix}-${scope.replace(":", "-")}`}
							className="flex min-h-6 cursor-pointer items-center gap-2 text-muted-foreground text-xs max-sm:min-h-11"
						>
							<Checkbox
								id={`${scopeIdPrefix}-${scope.replace(":", "-")}`}
								checked={selected.has(scope)}
								onCheckedChange={(checked) =>
									toggleScope(scope, checked === true)
								}
							/>
							{scope.split(":")[1]}
						</label>
					))}
				</div>
			</div>
		);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup className="sm:max-w-2xl">
				<DialogForm
					onSubmit={(event) => {
						event.preventDefault();
						onSubmit();
					}}
				>
					<DialogHeader>
						<DialogTitle>Create API key</DialogTitle>
						<DialogDescription>
							Choose where this key can be used and grant only the permissions
							it needs.
						</DialogDescription>
					</DialogHeader>
					<DialogPanel>
						<FieldGroup>
							<div className="grid gap-5 sm:grid-cols-2">
								<Field>
									<FieldLabel htmlFor={nameId}>Key name</FieldLabel>
									<Input
										autoFocus
										id={nameId}
										name="api-key-name"
										placeholder="Production agent"
										value={apiKeyName}
										onChange={(event) => onApiKeyNameChange(event.target.value)}
										className="max-sm:[&_input]:text-base"
										autoComplete="off"
									/>
									<FieldDescription>
										Use a name that identifies the service or agent.
									</FieldDescription>
								</Field>
								{environments && onEnvironmentChange ? (
									<Field>
										<FieldLabel htmlFor={environmentSelectId}>
											Environment
										</FieldLabel>
										<NativeSelect
											id={environmentSelectId}
											name="api-key-environment"
											value={environmentId ?? ""}
											onChange={(event) =>
												onEnvironmentChange(event.target.value)
											}
											className="w-full max-sm:[&_select]:text-base"
										>
											<NativeSelectOption value="">
												Workspace default
											</NativeSelectOption>
											{environments.map((environment) => (
												<NativeSelectOption
													key={environment.id}
													value={environment.id}
												>
													{environment.name}
													{environment.isProtected ? " (protected)" : ""}
												</NativeSelectOption>
											))}
										</NativeSelect>
										<FieldDescription>
											The key can only access data in this environment.
										</FieldDescription>
									</Field>
								) : null}
							</div>

							{onEndUserRequiredChange ? (
								<div className="flex items-start justify-between gap-4 rounded-lg border border-border/70 px-4 py-3">
									<div className="flex min-w-0 flex-col gap-1">
										<label
											className="cursor-pointer font-medium text-sm"
											htmlFor={endUserId}
										>
											Require a user
										</label>
										<p
											className="text-muted-foreground text-xs leading-snug"
											id={`${endUserId}-help`}
										>
											Every call must name the user it acts for, and the key
											never uses your workspace's own connections. It reads only
											that user's invocations, receipts and approvals, so keep a
											second key without this for your own admin reads.
										</p>
									</div>
									<Switch
										aria-describedby={`${endUserId}-help`}
										checked={endUserRequired ?? false}
										id={endUserId}
										onCheckedChange={(checked) =>
											onEndUserRequiredChange(checked === true)
										}
									/>
								</div>
							) : null}

							<Fieldset className="max-w-none gap-3">
								<div className="flex items-end justify-between gap-4">
									<div className="flex flex-col gap-1">
										<FieldsetLegend className="text-sm">
											Permissions
										</FieldsetLegend>
										<p className="text-muted-foreground text-xs">
											Start with a preset, then fine-tune individual scopes.
										</p>
									</div>
									<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
										{preset === "custom" ? "Custom · " : ""}
										{selectedScopes.length} of {ALL_SCOPES.length} selected
									</span>
								</div>

								<RadioGroup
									aria-label="Permission preset"
									className="grid gap-2 sm:grid-cols-3"
									value={preset === "custom" ? "" : preset}
									onValueChange={(value) => setPreset(String(value))}
								>
									{PRESETS.map((option) => {
										const id = `${presetIdPrefix}-${option.value}`;
										return (
											<label
												key={option.value}
												htmlFor={id}
												className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border border-border/70 bg-background p-3 transition-colors hover:bg-muted/40 has-data-checked:border-foreground/25 has-data-checked:bg-muted/50 has-focus-visible:ring-2 has-focus-visible:ring-ring"
											>
												<Radio id={id} value={option.value} className="mt-px" />
												<span className="flex min-w-0 flex-col gap-1">
													<span className="font-medium text-sm leading-4">
														{option.label}
													</span>
													<span className="text-muted-foreground text-xs leading-snug">
														{option.description}
													</span>
												</span>
											</label>
										);
									})}
								</RadioGroup>

								<Frame>
									<FramePanel className="p-0">
										<ScrollArea
											className="h-64 rounded-lg"
											scrollFade
											scrollbarGutter
										>
											<CheckboxGroup className="grid gap-x-6 gap-y-4 p-4 sm:grid-cols-2">
												{SCOPE_GROUPS.map(renderGroup)}
											</CheckboxGroup>
										</ScrollArea>
									</FramePanel>
								</Frame>
							</Fieldset>
						</FieldGroup>
					</DialogPanel>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" />}>
							Cancel
						</DialogClose>
						<Button
							type="submit"
							loading={isPending}
							disabled={!apiKeyName.trim() || selectedScopes.length === 0}
						>
							Create API key
						</Button>
					</DialogFooter>
				</DialogForm>
			</DialogPopup>
		</Dialog>
	);
}
