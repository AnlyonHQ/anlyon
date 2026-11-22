"use client";

import { type FormEvent, useId, useMemo, useState } from "react";
import { formatQuantity } from "@/components/effects/preview-blocks";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
	type ActionDeclarationsInput,
	useUpdateAction,
} from "@/hooks/api/use-actions";
import { useEffects } from "@/hooks/api/use-effects";
import { useCan } from "@/hooks/api/use-permissions";
import type {
	Action,
	ActionImpactDeclaration,
	ActionVerifyDeclaration,
	VerifyScalar,
} from "@/lib/types";
import { useUnsavedChangesGuard } from "@/lib/unsaved-changes";

type ImpactKind = "none" | "money" | "resource_mutations" | "declared";

export interface DeclarationValues {
	governed: boolean;
	impactKind: ImpactKind;
	unit: string;
	currency: string;
	amount: string;
	bound: ActionImpactDeclaration["bound"];
	verifyUrl: string;
	verifyStatus: string;
	verifyMatch: string;
}

const FIELDS = [
	"unit",
	"currency",
	"amount",
	"verifyUrl",
	"verifyStatus",
	"verifyMatch",
] as const;
type FieldName = (typeof FIELDS)[number];
export type DeclarationErrors = Partial<Record<FieldName, string>>;

const DECLARED_UNIT = /^[a-z][a-z0-9_]{0,31}$/;
const MATCH_PATH = /^(?:[a-zA-Z0-9_]+|\*)(?:\.(?:[a-zA-Z0-9_]+|\*))*$/;

function isScalar(value: unknown): value is VerifyScalar {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

function parsesAsJson(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

function matchValueText(equals: VerifyScalar): string {
	if (typeof equals !== "string") return JSON.stringify(equals);
	return equals === "" || equals !== equals.trim() || parsesAsJson(equals)
		? JSON.stringify(equals)
		: equals;
}

function matchValue(text: string): VerifyScalar {
	try {
		const parsed: unknown = JSON.parse(text);
		if (isScalar(parsed)) return parsed;
	} catch {
	}
	return text;
}

export function declarationValues(action: Action): DeclarationValues {
	const { impact, verify } = action;
	const impactKind: ImpactKind = !impact
		? "none"
		: impact.dimension === "money" || impact.dimension === "resource_mutations"
			? impact.dimension
			: "declared";
	return {
		governed: action.governed,
		impactKind,
		unit: impactKind === "declared" && impact ? impact.dimension : "",
		currency: impactKind === "money" && impact ? impact.unit.toUpperCase() : "",
		amount: impact?.amount ?? "",
		bound: impact?.bound ?? "exact",
		verifyUrl: verify?.url ?? "",
		verifyStatus: String(verify?.status ?? 200),
		verifyMatch: (verify?.match ?? [])
			.map(
				(check) =>
					`${check.path} ${check.absent ? "!=" : "="} ${matchValueText(check.equals)}`,
			)
			.join("\n"),
	};
}

function impactOf(
	values: DeclarationValues,
	errors: DeclarationErrors,
): ActionImpactDeclaration | null {
	if (values.impactKind === "none") return null;
	let dimension: string = values.impactKind;
	let unit = dimension;
	if (values.impactKind === "declared") {
		dimension = values.unit.trim().toLowerCase();
		unit = dimension;
		if (!DECLARED_UNIT.test(dimension)) {
			errors.unit =
				"Name the unit in lowercase letters, digits and underscores, such as emails.";
		}
	} else if (values.impactKind === "money") {
		unit = values.currency.trim().toLowerCase();
		if (!/^[a-z]{3}$/.test(unit)) {
			errors.currency = "Enter a three-letter currency code, such as USD.";
		}
	}
	const amount = values.amount.trim();
	if (!amount) {
		errors.amount =
			"Enter an amount, such as 1, input.amount or count(input.to).";
	}
	return { dimension, unit, amount, bound: values.bound };
}

function verifyOf(
	values: DeclarationValues,
	errors: DeclarationErrors,
): ActionVerifyDeclaration | null {
	const url = values.verifyUrl.trim();
	const lines = values.verifyMatch
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (!url) {
		if (lines.length > 0) {
			errors.verifyUrl = "A match rule needs a read-back URL.";
		}
		return null;
	}
	const status = Number(values.verifyStatus.trim());
	if (!Number.isInteger(status) || status < 100 || status > 599) {
		errors.verifyStatus = "Enter the HTTP status to expect, such as 200.";
	}
	const match: ActionVerifyDeclaration["match"] = [];
	for (const line of lines) {
		const at = line.indexOf("=");
		const absent = at > 0 && line[at - 1] === "!";
		const path = at < 0 ? "" : line.slice(0, absent ? at - 1 : at).trim();
		const value = at < 0 ? "" : line.slice(at + 1).trim();
		if (!MATCH_PATH.test(path) || !value) {
			errors.verifyMatch = `Write each check as path = value, such as data.status = succeeded. Check “${line}”.`;
			break;
		}
		match.push({
			path,
			equals: matchValue(value),
			...(absent ? { absent: true } : {}),
		});
	}
	return { url, status, match };
}

function sameImpact(
	a: ActionImpactDeclaration | null,
	b: ActionImpactDeclaration | null,
): boolean {
	if (!a || !b) return a === b;
	return (
		a.dimension === b.dimension &&
		a.unit === b.unit &&
		a.amount === b.amount &&
		a.bound === b.bound
	);
}

function sameVerify(
	a: ActionVerifyDeclaration | null,
	b: ActionVerifyDeclaration | null,
): boolean {
	if (!a || !b) return a === b;
	const checks = (verify: ActionVerifyDeclaration) =>
		JSON.stringify(
			(verify.match ?? []).map((c) => [c.path, c.equals, c.absent === true]),
		);
	return a.url === b.url && a.status === b.status && checks(a) === checks(b);
}

export function declarationsPayload(
	action: Pick<Action, "governed" | "impact" | "verify">,
	values: DeclarationValues,
): { payload: ActionDeclarationsInput } | { errors: DeclarationErrors } {
	if (!values.governed) {
		return { payload: action.governed ? { governed: false } : {} };
	}
	const errors: DeclarationErrors = {};
	const impact = impactOf(values, errors);
	const verify = verifyOf(values, errors);
	if (Object.keys(errors).length > 0) return { errors };

	const payload: ActionDeclarationsInput = {};
	if (!sameImpact(impact, action.impact)) payload.impact = impact;
	if (!sameVerify(verify, action.verify)) payload.verify = verify;
	if (!action.governed && !impact && !verify) payload.governed = true;
	return { payload };
}

function isDirty(saved: DeclarationValues, values: DeclarationValues): boolean {
	return (Object.keys(saved) as (keyof DeclarationValues)[]).some(
		(key) => saved[key] !== values[key],
	);
}

const AMOUNT_HELP =
	"An integer, input.<path> or count(input.<path>). You may multiply by one integer.";

export function DeclarationsForm({
	action,
	workspaceId,
}: {
	action: Action;
	workspaceId?: string;
}) {
	const id = useId();
	const update = useUpdateAction();
	const canManage = useCan(workspaceId)("actions.manage", action.environmentId);
	const saved = useMemo(() => declarationValues(action), [action]);
	const [values, setValues] = useState(saved);
	const [errors, setErrors] = useState<DeclarationErrors>({});
	const [notice, setNotice] = useState<string | null>(null);
	const [serverError, setServerError] = useState<string | null>(null);
	const blocker = useUnsavedChangesGuard(isDirty(saved, values));

	const set = <K extends keyof DeclarationValues>(
		key: K,
		value: DeclarationValues[K],
	) => {
		setValues((current) => ({ ...current, [key]: value }));
		setNotice(null);
	};

	const submit = (event: FormEvent) => {
		event.preventDefault();
		setServerError(null);
		setNotice(null);
		const result = declarationsPayload(action, values);
		if ("errors" in result) {
			setErrors(result.errors);
			const first = FIELDS.find((field) => result.errors[field]);
			if (first) document.getElementById(`${id}-${first}`)?.focus();
			return;
		}
		setErrors({});
		if (Object.keys(result.payload).length === 0) {
			return setNotice("Nothing changed.");
		}
		if (!workspaceId) return;
		update.mutate(
			{ ref: action.name, workspaceId, ...result.payload },
			{ onError: (error: Error) => setServerError(error.message) },
		);
	};

	const fieldProps = (field: FieldName) => ({
		id: `${id}-${field}`,
		"aria-invalid": errors[field] ? true : undefined,
		"aria-describedby": errors[field] ? `${id}-${field}-error` : undefined,
	});
	const fieldError = (field: FieldName) =>
		errors[field] ? (
			<p
				className="text-destructive text-xs"
				id={`${id}-${field}-error`}
				role="alert"
			>
				{errors[field]}
			</p>
		) : null;

	return (
		<>
			<AlertDialog
				onOpenChange={(open) => {
					if (!open && blocker.status === "blocked") blocker.reset();
				}}
				open={blocker.status === "blocked"}
			>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle>Leave without saving?</AlertDialogTitle>
						<AlertDialogDescription>
							Your changes to what “{action.name}” declares are not saved.
							Leaving discards them.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose
							onClick={() => blocker.reset?.()}
							render={<Button variant="ghost" />}
						>
							Stay
						</AlertDialogClose>
						<AlertDialogClose
							onClick={() => blocker.proceed?.()}
							render={<Button variant="outline" />}
						>
							Leave without saving
						</AlertDialogClose>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
			<form
				aria-labelledby={`${id}-title`}
				className="space-y-4 rounded-lg border p-4"
				noValidate
				onSubmit={submit}
			>
				<div className="space-y-1">
					<h3 className="font-medium text-sm" id={`${id}-title`}>
						Declarations
					</h3>
					<p className="text-muted-foreground text-xs">
						What one invocation changes, and how Anlyon reads the result back.
					</p>
				</div>

				<div className="flex items-start gap-2">
					<Checkbox
						checked={values.governed}
						className="mt-0.5"
						id={`${id}-governed`}
						onCheckedChange={(checked) => set("governed", checked === true)}
					/>
					<div className="space-y-0.5">
						<Label className="font-medium text-sm" htmlFor={`${id}-governed`}>
							Govern this action
						</Label>
						<p className="text-muted-foreground text-xs">
							Every invocation becomes an effect with a receipt. Impact limits
							apply when it declares an impact.
						</p>
					</div>
				</div>

				{values.governed ? (
					<>
						<fieldset className="space-y-3 border-t pt-4">
							<legend className="sr-only">Impact</legend>
							<p aria-hidden="true" className="font-medium text-sm">
								Impact
							</p>
							<div className="grid gap-3 sm:grid-cols-2">
								<div className="space-y-1.5">
									<Label htmlFor={`${id}-kind`}>What it counts</Label>
									<NativeSelect
										className="w-full"
										id={`${id}-kind`}
										onChange={(e) =>
											set("impactKind", e.target.value as ImpactKind)
										}
										value={values.impactKind}
									>
										<NativeSelectOption value="none">
											Not declared
										</NativeSelectOption>
										<NativeSelectOption value="money">Money</NativeSelectOption>
										<NativeSelectOption value="resource_mutations">
											Resource changes
										</NativeSelectOption>
										<NativeSelectOption value="declared">
											A declared unit
										</NativeSelectOption>
									</NativeSelect>
								</div>
								{values.impactKind === "money" ? (
									<div className="space-y-1.5">
										<Label htmlFor={`${id}-currency`}>Currency</Label>
										<Input
											autoComplete="off"
											maxLength={3}
											onChange={(e) =>
												set("currency", e.target.value.toUpperCase())
											}
											placeholder="USD"
											spellCheck={false}
											value={values.currency}
											{...fieldProps("currency")}
										/>
										{fieldError("currency")}
									</div>
								) : null}
								{values.impactKind === "declared" ? (
									<div className="space-y-1.5">
										<Label htmlFor={`${id}-unit`}>Unit</Label>
										<Input
											autoCapitalize="none"
											autoComplete="off"
											className="font-mono"
											maxLength={32}
											onChange={(e) => set("unit", e.target.value)}
											placeholder="emails"
											spellCheck={false}
											value={values.unit}
											{...fieldProps("unit")}
										/>
										{fieldError("unit")}
									</div>
								) : null}
							</div>
							{values.impactKind === "none" ? (
								<p className="text-muted-foreground text-xs">
									With no impact declared, no impact limit counts this action.
								</p>
							) : (
								<div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
									<div className="space-y-1.5">
										<Label htmlFor={`${id}-amount`}>Amount</Label>
										<Input
											autoCapitalize="none"
											autoComplete="off"
											className="font-mono"
											maxLength={200}
											onChange={(e) => set("amount", e.target.value)}
											placeholder="count(input.to)"
											spellCheck={false}
											value={values.amount}
											{...fieldProps("amount")}
										/>
										{fieldError("amount")}
										<p className="text-muted-foreground text-xs">
											{AMOUNT_HELP}
											{values.impactKind === "money"
												? " Money counts in minor units, such as cents."
												: ""}
										</p>
									</div>
									<div className="space-y-1.5">
										<Label htmlFor={`${id}-bound`}>Bound</Label>
										<NativeSelect
											className="w-full"
											id={`${id}-bound`}
											onChange={(e) =>
												set(
													"bound",
													e.target.value === "upper_bound"
														? "upper_bound"
														: "exact",
												)
											}
											value={values.bound}
										>
											<NativeSelectOption value="exact">
												Exact
											</NativeSelectOption>
											<NativeSelectOption value="upper_bound">
												Upper bound
											</NativeSelectOption>
										</NativeSelect>
									</div>
								</div>
							)}
						</fieldset>

						<fieldset className="space-y-3 border-t pt-4">
							<legend className="sr-only">Verify</legend>
							<p aria-hidden="true" className="font-medium text-sm">
								Verify
							</p>
							<div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
								<div className="space-y-1.5">
									<Label htmlFor={`${id}-verifyUrl`}>Read-back URL</Label>
									<Input
										autoCapitalize="none"
										autoComplete="off"
										className="font-mono"
										inputMode="url"
										maxLength={2048}
										onChange={(e) => set("verifyUrl", e.target.value)}
										placeholder="https://api.example.com/items/{{response.id}}"
										spellCheck={false}
										value={values.verifyUrl}
										{...fieldProps("verifyUrl")}
									/>
									{fieldError("verifyUrl")}
								</div>
								<div className="space-y-1.5">
									<Label htmlFor={`${id}-verifyStatus`}>Expected status</Label>
									<Input
										autoComplete="off"
										inputMode="numeric"
										onChange={(e) => set("verifyStatus", e.target.value)}
										value={values.verifyStatus}
										{...fieldProps("verifyStatus")}
									/>
									{fieldError("verifyStatus")}
								</div>
							</div>
							<p className="text-muted-foreground text-xs">
								A GET on the action’s own host, sent after dispatch with the
								same credential. Leave the URL empty to declare no read-back.
							</p>
							<div className="space-y-1.5">
								<Label htmlFor={`${id}-verifyMatch`}>Match rule</Label>
								<Textarea
									autoCapitalize="none"
									className="min-h-16 font-mono"
									onChange={(e) => set("verifyMatch", e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
											e.currentTarget.form?.requestSubmit();
										}
									}}
									placeholder="data.status = succeeded"
									spellCheck={false}
									value={values.verifyMatch}
									{...fieldProps("verifyMatch")}
								/>
								{fieldError("verifyMatch")}
								<p className="text-muted-foreground text-xs">
									One check per line, as path = value. A value is a literal,{" "}
									<code translate="no">{"{{input.field}}"}</code> or{" "}
									<code translate="no">{"{{response.field}}"}</code>. Quote a
									number to match it as text. A <code>*</code> in the path
									matches any item of a list; write <code>path != value</code>{" "}
									to check a removal.
								</p>
							</div>
						</fieldset>

						<div className="space-y-1 border-t pt-4">
							<p className="flex items-center gap-2 font-medium text-sm">
								Preview
								<span className="rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground text-xs">
									Always on
								</span>
							</p>
							<p className="text-muted-foreground text-xs">
								Every approval binds to a digest of the reviewed request, and
								dispatch refuses a request that differs.
							</p>
						</div>
					</>
				) : null}

				{serverError ? (
					<p className="text-destructive text-sm" role="alert">
						{serverError}
					</p>
				) : null}
				<div className="flex flex-wrap items-center gap-3">
					<Button
						disabled={!workspaceId || !canManage}
						loading={update.isPending}
						size="sm"
						type="submit"
					>
						Save declarations
					</Button>
					<output aria-live="polite" className="text-muted-foreground text-xs">
						{notice}
					</output>
				</div>
			</form>
		</>
	);
}

export function AdapterDeclarations({
	action,
	workspaceId,
}: {
	action: Action;
	workspaceId?: string;
}) {
	const latest = useEffects(workspaceId, action.environmentId, {
		action: action.name,
	});
	const impact = latest.data?.data[0]?.impact ?? [];
	return (
		<section
			aria-label="Declarations"
			className="space-y-2 rounded-lg border p-4"
		>
			<h3 className="font-medium text-sm">Declarations</h3>
			<p className="text-muted-foreground text-sm">
				Governed by the{" "}
				<span className="font-mono text-foreground text-xs" translate="no">
					{action.adapter?.type}
				</span>{" "}
				adapter. Its impact and read-back come from the adapter and cannot be
				edited here.
				{action.adapter?.type === "stripe.refund"
					? " The action config names live or test mode, and the Stripe key must match it."
					: ""}
			</p>
			<p className="text-sm">
				<span className="text-muted-foreground">
					Impact on the latest effect{" "}
				</span>
				{impact.length > 0 ? (
					<span className="font-medium tabular-nums">
						{impact.map(formatQuantity).join(", ")}
					</span>
				) : (
					<span className="text-muted-foreground">
						{latest.isLoading
							? "Loading…"
							: "is not known yet. No receipts so far."}
					</span>
				)}
			</p>
		</section>
	);
}
