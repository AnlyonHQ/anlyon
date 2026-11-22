"use client";

import { FileCode } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
	useImportOpenApi,
	usePutSecret,
	useSecrets,
} from "@/hooks/api/use-actions";
import { ApiError } from "@/lib/api-client";
import {
	type ChoiceMode,
	defaultChoice,
	describeImpact,
	type ImpactKind,
	type ImportedOperation,
	type ImportRequest,
	type ImportResult,
	type ImportRisk,
	importSelection,
	operationKey,
	parseSpec,
	type RowChoice,
	suggestedChoice,
	suggestionNeedsInput,
} from "@/lib/openapi-import";

const RISK_LABEL: Record<ImportRisk, string> = {
	read: "Read",
	write: "Write",
	irreversible: "Irreversible",
	destructive: "Destructive",
};

const RISK_VARIANT: Record<
	ImportRisk,
	"secondary" | "info" | "warning" | "error"
> = {
	read: "secondary",
	write: "info",
	irreversible: "warning",
	destructive: "error",
};

const NEW_SECRET = "__new__";
const SECRET_NAME = /^[A-Z0-9_]+$/;

function describe(error: unknown): string {
	if (error instanceof ApiError)
		return error.code ? `${error.message} (${error.code})` : error.message;
	if (error instanceof Error) return error.message;
	return "The import did not complete.";
}

export function ImportOpenApiDialog({
	workspaceId,
	vendor,
}: {
	workspaceId?: string;
	vendor?: string;
}) {
	const id = useId();
	const secrets = useSecrets(workspaceId).data ?? [];
	const importApi = useImportOpenApi();
	const putSecret = usePutSecret();

	const [open, setOpen] = useState(vendor !== undefined);
	const [specText, setSpecText] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [credential, setCredential] = useState("");
	const [headerName, setHeaderName] = useState("Authorization");
	const [valueTemplate, setValueTemplate] = useState("Bearer {{secret}}");
	const [newName, setNewName] = useState("");
	const [newValue, setNewValue] = useState("");

	const [preview, setPreview] = useState<ImportResult | null>(null);
	const [rows, setRows] = useState<Record<string, RowChoice>>({});
	const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
	const [result, setResult] = useState<ImportResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [working, setWorking] = useState(false);

	const existing = secrets.find((s) => s.name === credential);
	const isNew = credential === NEW_SECRET;

	const reset = () => {
		setSpecText("");
		setBaseUrl("");
		setCredential("");
		setHeaderName("Authorization");
		setValueTemplate("Bearer {{secret}}");
		setNewName("");
		setNewValue("");
		setPreview(null);
		setRows({});
		setRowErrors({});
		setResult(null);
		setError(null);
	};

	const edited = () => {
		setPreview(null);
		setResult(null);
		setError(null);
	};

	const formProblem = (): string | null => {
		if (isNew) {
			if (!SECRET_NAME.test(newName))
				return "Name the new key in uppercase letters, digits and underscores, such as ACME_API_KEY.";
			if (secrets.some((s) => s.name === newName))
				return `A secret named ${newName} already exists. Choose it from the list instead.`;
			if (!newValue) return "Paste the key's value.";
		}
		if (credential && !headerName.trim())
			return "Name the header the key is sent in.";
		return null;
	};

	const auth = (secretName: string): ImportRequest["auth"] => ({
		headerName: headerName.trim(),
		secretName,
		...(valueTemplate.trim() ? { valueTemplate: valueTemplate.trim() } : {}),
	});

	const runReview = async () => {
		if (!workspaceId) return;
		const parsed = parseSpec(specText);
		if ("error" in parsed) return setError(parsed.error);
		const problem = formProblem();
		if (problem) return setError(problem);
		setError(null);
		setWorking(true);
		try {
			const reviewed = await importApi.mutateAsync({
				workspaceId,
				spec: parsed.spec,
				dryRun: true,
				...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
				...(existing ? { auth: auth(existing.name) } : {}),
			});
			setPreview(reviewed);
			setRows(
				Object.fromEntries(
					reviewed.created.map((op) => [operationKey(op), defaultChoice(op)]),
				),
			);
			setRowErrors({});
		} catch (caught) {
			setError(describe(caught));
		} finally {
			setWorking(false);
		}
	};

	const runImport = async () => {
		if (!workspaceId || !preview) return;
		const parsed = parseSpec(specText);
		if ("error" in parsed) return setError(parsed.error);
		const selection = importSelection(preview.created, rows);
		if ("errors" in selection) {
			setRowErrors(selection.errors);
			return setError(
				"Some operations need a value before they can be imported.",
			);
		}
		if (selection.only.length === 0)
			return setError("Choose at least one operation to import.");
		setRowErrors({});
		setError(null);
		setWorking(true);
		try {
			let secretName = existing?.name;
			if (isNew) {
				await putSecret.mutateAsync({
					workspaceId,
					name: newName,
					value: newValue,
					allowedHosts: preview.suggestedAllowedHosts,
				});
				secretName = newName;
			}
			const imported = await importApi.mutateAsync({
				workspaceId,
				spec: parsed.spec,
				only: selection.only,
				...(Object.keys(selection.operations).length > 0
					? { operations: selection.operations }
					: {}),
				...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
				...(secretName ? { auth: auth(secretName) } : {}),
			});
			setResult(imported);
		} catch (caught) {
			setError(describe(caught));
		} finally {
			setWorking(false);
		}
	};

	const setRow = (key: string, next: RowChoice) => {
		setRows((current) => ({ ...current, [key]: next }));
		setRowErrors((current) =>
			Object.fromEntries(Object.entries(current).filter(([k]) => k !== key)),
		);
	};

	const acceptAll = () => {
		if (!preview) return;
		setRows((current) =>
			Object.fromEntries(
				preview.created.map((op) => {
					const key = operationKey(op);
					return [
						key,
						{ ...suggestedChoice(op), include: current[key]?.include ?? true },
					];
				}),
			),
		);
		setRowErrors({});
	};

	const included = preview
		? preview.created.filter((op) => rows[operationKey(op)]?.include !== false)
				.length
		: 0;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) reset();
			}}
		>
			<DialogTrigger
				render={
					<Button disabled={!workspaceId} size="sm" variant="outline">
						<FileCode aria-hidden="true" className="size-4" />
						Import OpenAPI
					</Button>
				}
			/>
			<DialogPopup className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>
						{vendor
							? `Import ${vendor}'s OpenAPI spec`
							: "Import an OpenAPI spec"}
					</DialogTitle>
					<DialogDescription>
						Every operation becomes an action. Review what Anlyon suggests for
						each one, its risk, whether a person approves each call and what it
						counts, and accept or change it before anything is created.
					</DialogDescription>
				</DialogHeader>

				<DialogPanel className="space-y-4 py-2">
					{result ? (
						<ImportDone result={result} />
					) : (
						<>
							<Field>
								<FieldLabel htmlFor={`${id}-spec`}>
									OpenAPI 3 spec (JSON)
								</FieldLabel>
								<Textarea
									autoCapitalize="none"
									className="max-h-48 min-h-24 font-mono text-xs"
									id={`${id}-spec`}
									onChange={(e) => {
										setSpecText(e.target.value);
										edited();
									}}
									placeholder='{"openapi": "3.0.3", "servers": [...], "paths": {...}}'
									spellCheck={false}
									value={specText}
								/>
							</Field>

							<div className="grid gap-3 sm:grid-cols-2">
								<Field>
									<FieldLabel htmlFor={`${id}-base`}>
										Base URL (optional)
									</FieldLabel>
									<Input
										autoComplete="off"
										className="font-mono"
										id={`${id}-base`}
										inputMode="url"
										onChange={(e) => {
											setBaseUrl(e.target.value);
											edited();
										}}
										placeholder="The spec's first server"
										spellCheck={false}
										value={baseUrl}
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor={`${id}-credential`}>
										Credential
									</FieldLabel>
									<NativeSelect
										className="w-full"
										id={`${id}-credential`}
										onChange={(e) => {
											setCredential(e.target.value);
											edited();
										}}
										value={credential}
									>
										<NativeSelectOption value="">None</NativeSelectOption>
										{secrets
											.filter((s) => s.kind !== "connection")
											.map((s) => (
												<NativeSelectOption key={s.id} value={s.name}>
													{s.name}
												</NativeSelectOption>
											))}
										<NativeSelectOption value={NEW_SECRET}>
											Add a new key…
										</NativeSelectOption>
									</NativeSelect>
								</Field>
							</div>

							{isNew ? (
								<div className="grid gap-3 sm:grid-cols-2">
									<Field>
										<FieldLabel htmlFor={`${id}-new-name`}>Key name</FieldLabel>
										<Input
											autoComplete="off"
											className="font-mono"
											id={`${id}-new-name`}
											onChange={(e) => {
												setNewName(e.target.value.toUpperCase());
												edited();
											}}
											placeholder="ACME_API_KEY"
											spellCheck={false}
											value={newName}
										/>
									</Field>
									<Field>
										<FieldLabel htmlFor={`${id}-new-value`}>Value</FieldLabel>
										<Input
											autoComplete="off"
											className="font-mono"
											id={`${id}-new-value`}
											onChange={(e) => setNewValue(e.target.value)}
											type="password"
											value={newValue}
										/>
									</Field>
								</div>
							) : null}

							{credential ? (
								<div className="grid gap-3 sm:grid-cols-2">
									<Field>
										<FieldLabel htmlFor={`${id}-header`}>Header</FieldLabel>
										<Input
											autoComplete="off"
											className="font-mono"
											id={`${id}-header`}
											onChange={(e) => {
												setHeaderName(e.target.value);
												edited();
											}}
											spellCheck={false}
											value={headerName}
										/>
									</Field>
									<Field>
										<FieldLabel htmlFor={`${id}-template`}>
											Header value
										</FieldLabel>
										<Input
											autoComplete="off"
											className="font-mono"
											id={`${id}-template`}
											onChange={(e) => {
												setValueTemplate(e.target.value);
												edited();
											}}
											spellCheck={false}
											value={valueTemplate}
										/>
										<p className="text-muted-foreground text-xs">
											<code translate="no">{"{{secret}}"}</code> stands for the
											key. Anlyon fills it in; the agent never sees it.
										</p>
									</Field>
								</div>
							) : null}

							{preview ? (
								<ReviewList
									acceptAll={acceptAll}
									credentialName={isNew ? newName : existing?.name}
									existingHosts={existing?.allowedHosts ?? null}
									isNew={isNew}
									preview={preview}
									rowErrors={rowErrors}
									rows={rows}
									setRow={setRow}
								/>
							) : null}

							{working ? (
								<p
									aria-live="polite"
									className="text-muted-foreground text-sm"
									role="status"
								>
									Working…
								</p>
							) : null}
							{error ? (
								<Alert role="alert" variant="error">
									<AlertTitle>Nothing was imported</AlertTitle>
									<AlertDescription className="whitespace-pre-line">
										{error}
									</AlertDescription>
								</Alert>
							) : null}
						</>
					)}
				</DialogPanel>

				<DialogFooter>
					<DialogClose
						render={
							<Button variant="outline">{result ? "Close" : "Cancel"}</Button>
						}
					/>
					{result ? null : preview ? (
						<Button
							disabled={working || included === 0}
							onClick={() => void runImport()}
						>
							{working ? (
								<Spinner aria-hidden="true" className="size-4" />
							) : null}
							Import {included} {included === 1 ? "action" : "actions"}
						</Button>
					) : (
						<Button
							disabled={working || !specText.trim()}
							onClick={() => void runReview()}
						>
							{working ? (
								<Spinner aria-hidden="true" className="size-4" />
							) : null}
							Review operations
						</Button>
					)}
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}

function ReviewList({
	preview,
	rows,
	rowErrors,
	setRow,
	acceptAll,
	isNew,
	credentialName,
	existingHosts,
}: {
	preview: ImportResult;
	rows: Record<string, RowChoice>;
	rowErrors: Record<string, string>;
	setRow: (key: string, row: RowChoice) => void;
	acceptAll: () => void;
	isNew: boolean;
	credentialName: string | undefined;
	existingHosts: string[] | null;
}) {
	const hosts = preview.suggestedAllowedHosts;
	return (
		<section aria-label="Operations" className="space-y-3 border-t pt-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-sm">
					{preview.created.length}{" "}
					{preview.created.length === 1 ? "operation" : "operations"} can be
					imported
					{preview.skipped.length > 0
						? `, ${preview.skipped.length} cannot`
						: ""}
					. Each keeps the defaults unless you accept or change its suggestion.
				</p>
				<Button onClick={acceptAll} size="sm" variant="outline">
					Accept every suggestion
				</Button>
			</div>

			<ul className="divide-y rounded-lg border">
				{preview.created.map((op) => {
					const key = operationKey(op);
					return (
						<OperationRow
							error={rowErrors[key]}
							key={key}
							op={op}
							row={rows[key] ?? defaultChoice(op)}
							setRow={(row) => setRow(key, row)}
						/>
					);
				})}
			</ul>

			{preview.skipped.length > 0 ? (
				<details className="text-sm">
					<summary className="cursor-pointer text-muted-foreground">
						Not imported ({preview.skipped.length})
					</summary>
					<ul className="mt-2 space-y-1">
						{preview.skipped.map((s) => (
							<li className="text-xs" key={`${s.method} ${s.path}`}>
								<span className="font-mono">
									{s.method} {s.path}
								</span>
								<span className="text-muted-foreground">: {s.reason}</span>
							</li>
						))}
					</ul>
				</details>
			) : null}

			{hosts.length > 0 && isNew && credentialName ? (
				<div className="space-y-0.5 rounded-lg border p-3">
					<p className="font-medium text-sm">
						{credentialName} is only sent to {hosts.join(", ")}
					</p>
					<p className="text-muted-foreground text-xs">
						From the spec's servers. Anlyon refuses to send the key to any other
						host.
					</p>
				</div>
			) : null}
			{hosts.length > 0 &&
			!isNew &&
			credentialName &&
			(!existingHosts || existingHosts.length === 0) ? (
				<p className="text-muted-foreground text-xs">
					{credentialName} may be sent to any public host. The spec's servers
					suggest limiting it to {hosts.join(", ")}: set these as its allowed
					hosts the next time you save the key.
				</p>
			) : null}
		</section>
	);
}

function OperationRow({
	op,
	row,
	error,
	setRow,
}: {
	op: ImportedOperation;
	row: RowChoice;
	error: string | undefined;
	setRow: (row: RowChoice) => void;
}) {
	const id = useId();
	const suggested = useMemo(() => suggestedChoice(op), [op]);
	const { suggestion } = op;

	const setMode = (mode: ChoiceMode) => {
		const base =
			mode === "default"
				? defaultChoice(op)
				: mode === "suggested"
					? suggested
					: { ...row, mode: "custom" as const };
		setRow({ ...base, mode, include: row.include });
	};
	const set = <K extends keyof RowChoice>(field: K, value: RowChoice[K]) =>
		setRow({ ...row, [field]: value });

	return (
		<li className="space-y-2 p-3">
			<div className="flex items-start gap-3">
				<Checkbox
					aria-label={`Import ${op.name}`}
					checked={row.include}
					className="mt-1"
					onCheckedChange={(checked) => set("include", checked === true)}
				/>
				<div className="min-w-0 flex-1 space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						<Badge className="font-mono" size="sm" variant="outline">
							{op.method}
						</Badge>
						<span className="truncate font-medium text-sm" translate="no">
							{op.name}
						</span>
						<Badge size="sm" variant={RISK_VARIANT[suggestion.risk]}>
							{RISK_LABEL[suggestion.risk]}
						</Badge>
					</div>
					<p className="truncate font-mono text-muted-foreground text-xs">
						{op.path}
					</p>
					<p className="text-muted-foreground text-xs">
						Suggested:{" "}
						{suggestion.requiresApproval ? "approve every call" : "no approval"}
						,{" "}
						{suggestion.impact
							? `counts ${describeImpact(suggested)}`
							: "not governed"}
						.
					</p>
					<details className="text-xs">
						<summary className="cursor-pointer text-muted-foreground">
							Why
						</summary>
						<ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
							{suggestion.reasons.map((reason) => (
								<li key={reason}>{reason}</li>
							))}
						</ul>
						{suggestion.impactNote ? (
							<p className="mt-1 text-muted-foreground">
								{suggestion.impactNote}
							</p>
						) : null}
					</details>
				</div>
				<NativeSelect
					aria-label={`Settings for ${op.name}`}
					className="w-36 shrink-0"
					disabled={!row.include}
					onChange={(e) => setMode(e.target.value as ChoiceMode)}
					value={row.mode}
				>
					<NativeSelectOption value="default">Defaults</NativeSelectOption>
					<NativeSelectOption value="suggested">Suggestion</NativeSelectOption>
					<NativeSelectOption value="custom">Custom</NativeSelectOption>
				</NativeSelect>
			</div>

			{row.include ? (
				<div className="space-y-2 pl-7">
					<p className="text-xs">
						<span className="text-muted-foreground">Imports with </span>
						{row.requiresApproval ? "approval on every call" : "no approval"}
						<span className="text-muted-foreground">, counting </span>
						{describeImpact(row)}
					</p>
					{row.mode === "suggested" && suggestionNeedsInput(op) ? (
						<div className="flex items-center gap-2">
							<Label className="text-xs" htmlFor={`${id}-currency`}>
								Currency
							</Label>
							<Input
								autoComplete="off"
								className="w-24 font-mono"
								id={`${id}-currency`}
								maxLength={3}
								onChange={(e) => set("unit", e.target.value.toUpperCase())}
								placeholder="USD"
								spellCheck={false}
								value={row.unit}
							/>
						</div>
					) : null}
					{row.mode === "custom" ? (
						<CustomFields id={id} row={row} set={set} />
					) : null}
					{error ? (
						<p className="text-destructive text-xs" role="alert">
							{error}
						</p>
					) : null}
				</div>
			) : null}
		</li>
	);
}

function CustomFields({
	id,
	row,
	set,
}: {
	id: string;
	row: RowChoice;
	set: <K extends keyof RowChoice>(field: K, value: RowChoice[K]) => void;
}) {
	return (
		<div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2">
			<div className="flex items-center gap-2 sm:col-span-2">
				<Checkbox
					checked={row.requiresApproval}
					id={`${id}-approval`}
					onCheckedChange={(checked) =>
						set("requiresApproval", checked === true)
					}
				/>
				<Label className="text-xs" htmlFor={`${id}-approval`}>
					A person approves every call
				</Label>
			</div>
			<div className="space-y-1">
				<Label className="text-xs" htmlFor={`${id}-kind`}>
					What it counts
				</Label>
				<NativeSelect
					className="w-full"
					id={`${id}-kind`}
					onChange={(e) => set("impactKind", e.target.value as ImpactKind)}
					value={row.impactKind}
				>
					<NativeSelectOption value="none">Not governed</NativeSelectOption>
					<NativeSelectOption value="resource_mutations">
						Resource changes
					</NativeSelectOption>
					<NativeSelectOption value="money">Money</NativeSelectOption>
					<NativeSelectOption value="declared">
						A declared unit
					</NativeSelectOption>
				</NativeSelect>
			</div>
			{row.impactKind === "money" || row.impactKind === "declared" ? (
				<div className="space-y-1">
					<Label className="text-xs" htmlFor={`${id}-unit`}>
						{row.impactKind === "money" ? "Currency" : "Unit"}
					</Label>
					<Input
						autoComplete="off"
						className="font-mono"
						id={`${id}-unit`}
						maxLength={row.impactKind === "money" ? 3 : 32}
						onChange={(e) =>
							set(
								"unit",
								row.impactKind === "money"
									? e.target.value.toUpperCase()
									: e.target.value,
							)
						}
						placeholder={row.impactKind === "money" ? "USD" : "emails"}
						spellCheck={false}
						value={row.unit}
					/>
				</div>
			) : null}
			{row.impactKind !== "none" ? (
				<>
					<div className="space-y-1">
						<Label className="text-xs" htmlFor={`${id}-amount`}>
							Amount
						</Label>
						<Input
							autoCapitalize="none"
							autoComplete="off"
							className="font-mono"
							id={`${id}-amount`}
							maxLength={200}
							onChange={(e) => set("amount", e.target.value)}
							placeholder="input.amount"
							spellCheck={false}
							value={row.amount}
						/>
						<p className="text-muted-foreground text-xs">
							An integer, input.&lt;path&gt; or count(input.&lt;path&gt;).
							{row.impactKind === "money"
								? " Money counts in minor units, such as cents."
								: ""}
						</p>
					</div>
					<div className="space-y-1">
						<Label className="text-xs" htmlFor={`${id}-bound`}>
							Bound
						</Label>
						<NativeSelect
							className="w-full"
							id={`${id}-bound`}
							onChange={(e) =>
								set(
									"bound",
									e.target.value === "upper_bound" ? "upper_bound" : "exact",
								)
							}
							value={row.bound}
						>
							<NativeSelectOption value="exact">Exact</NativeSelectOption>
							<NativeSelectOption value="upper_bound">
								Upper bound
							</NativeSelectOption>
						</NativeSelect>
					</div>
				</>
			) : null}
		</div>
	);
}

function ImportDone({ result }: { result: ImportResult }) {
	const chosen = result.created.filter((op) => op.customized).length;
	return (
		<div className="space-y-3">
			<Alert role="status" variant="success">
				<AlertTitle>
					Imported {result.created.length}{" "}
					{result.created.length === 1 ? "action" : "actions"}
				</AlertTitle>
				<AlertDescription>
					{chosen > 0
						? `${chosen} with the settings you chose, the rest with the defaults.`
						: "All with the defaults."}
				</AlertDescription>
			</Alert>
			{result.skipped.length > 0 ? (
				<ul className="space-y-1">
					{result.skipped.map((s) => (
						<li className="text-xs" key={`${s.method} ${s.path}`}>
							<span className="font-mono">
								{s.method} {s.path}
							</span>
							<span className="text-muted-foreground">: {s.reason}</span>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
