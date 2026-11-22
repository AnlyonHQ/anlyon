"use client";

import { Check, Copy, KeyRound } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useCreateApiKey } from "@/hooks/api/use-workspaces";
import {
	AGENT_CLIENTS,
	AGENT_KEY_SCOPES,
	type AgentClient,
	agentSnippet,
} from "@/lib/agent-snippets";
import { ApiError } from "@/lib/api-client";
import {
	createOperationLimit,
	enablePolicy,
	type LimitRow,
	type OperationRow,
	type OperationsView,
	type PolicyRow,
	readOperations,
	turnOperationOff,
	turnOperationOn,
	turnOperationsOn,
} from "@/lib/operations";
import {
	cataloguePack,
	consoleTransport,
	type OperationsApi,
	PackError,
} from "@/lib/packs";
import type { ConnectionIntegration } from "@/lib/types";
import { cn, copyToClipboard } from "@/lib/utils";

export type OperationsFlowStep = "operations" | "agent";

function describeError(error: unknown): string {
	if (error instanceof PackError) return error.message;
	if (error instanceof ApiError)
		return error.code ? `${error.message} (${error.code})` : error.message;
	return "The request failed. Nothing was changed.";
}

function isForbidden(error: unknown): boolean {
	return error instanceof ApiError && error.status === 403;
}

export function OperationsFlow({
	workspaceId,
	workspaceName,
	environmentName,
	environmentId,
	integration,
	secretName,
	initialStep = "operations",
	api: injectedApi,
}: {
	workspaceId: string;
	workspaceName: string;
	environmentName: string;
	environmentId?: string;
	integration: ConnectionIntegration;
	secretName: string;
	initialStep?: OperationsFlowStep;
	api?: OperationsApi;
}) {
	const api = useMemo(
		() => injectedApi ?? consoleTransport(workspaceId),
		[injectedApi, workspaceId],
	);
	const manifest = integration.operationsPack
		? cataloguePack(integration.operationsPack)
		: undefined;
	const [step, setStep] = useState<OperationsFlowStep>(initialStep);
	const [view, setView] = useState<OperationsView | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		if (!manifest) return;
		try {
			setView(await readOperations(api, manifest));
			setLoadError(null);
		} catch (error) {
			setLoadError(describeError(error));
		}
	}, [api, manifest]);

	useEffect(() => {
		void reload();
	}, [reload]);

	const enabledTools =
		view?.operations
			.filter((o) => o.state === "on")
			.map((o) => o.installedName) ?? [];

	if (!manifest) {
		return (
			<p className="text-muted-foreground text-sm">
				Anlyon has no ready-made operations for {integration.name} yet. Write a
				declared action that sends{" "}
				<code className="font-mono text-xs">{`Bearer {{secret:${secretName}}}`}</code>{" "}
				to its API.
			</p>
		);
	}

	return (
		<div className="space-y-4">
			<nav aria-label="Steps" className="flex gap-1 border-b text-sm">
				{(
					[
						["operations", "1", "What may your agent do here?"],
						["agent", "2", "Add to your agent"],
					] as const
				).map(([value, number, label]) => (
					<button
						aria-current={step === value ? "step" : undefined}
						className={cn(
							"-mb-px inline-flex h-9 items-center gap-2 whitespace-nowrap border-b-2 px-2 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
							step === value
								? "border-foreground text-foreground"
								: "border-transparent text-muted-foreground hover:text-foreground",
						)}
						key={value}
						onClick={() => setStep(value)}
						type="button"
					>
						<span
							aria-hidden="true"
							className={cn(
								"flex size-4 items-center justify-center rounded-full text-[10px] tabular-nums",
								step === value
									? "bg-foreground text-background"
									: "bg-muted text-muted-foreground",
							)}
						>
							{number}
						</span>
						{label}
					</button>
				))}
			</nav>

			{loadError ? (
				<Alert variant="error" role="alert">
					<AlertTitle>The operations could not be read</AlertTitle>
					<AlertDescription>{loadError}</AlertDescription>
				</Alert>
			) : !view ? (
				<div className="space-y-1" aria-busy="true">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-10 w-full rounded-lg" />
					))}
				</div>
			) : step === "operations" ? (
				<OperationsStep
					api={api}
					view={view}
					manifest={manifest}
					secretName={secretName}
					onChanged={reload}
					onNext={() => setStep("agent")}
				/>
			) : (
				<AgentStep
					workspaceId={workspaceId}
					workspaceName={workspaceName}
					environmentName={environmentName}
					environmentId={environmentId}
					integrationName={integration.name}
					toolNames={enabledTools}
				/>
			)}
		</div>
	);
}

type Manifest = NonNullable<ReturnType<typeof cataloguePack>>;

function OperationsStep({
	api,
	view,
	manifest,
	secretName,
	onChanged,
	onNext,
}: {
	api: OperationsApi;
	view: OperationsView;
	manifest: Manifest;
	secretName: string;
	onChanged: () => Promise<void>;
	onNext: () => void;
}) {
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const policiesId = useId();
	const limitsId = useId();
	const readsId = useId();
	const writesId = useId();

	const run = async (key: string, work: () => Promise<void>) => {
		setPending(key);
		setError(null);
		try {
			await work();
			await onChanged();
		} catch (e) {
			setError(describeError(e));
		} finally {
			setPending(null);
		}
	};

	const installed = new Set(
		view.operations.filter((o) => o.state !== "absent").map((o) => o.name),
	);
	const policies = view.policies.filter((p) => installed.has(p.actionName));
	const limits = view.limits.filter(
		(l) => l.actionName === null || installed.has(l.actionName),
	);

	return (
		<div className="space-y-5">
			<p className="text-muted-foreground text-sm">
				Each operation you turn on becomes a tool your agent can call. Anlyon
				makes the call with {secretName}, or with your user's own account when
				the call is made for one, so the agent never holds the key. Reads return
				what the provider answers and change nothing. Writes are counted against
				your limits, can wait for an approval, and are read back where the
				provider allows. Turning one off disables it; its history stays.
			</p>

			{error ? (
				<Alert variant="error" role="alert">
					<AlertTitle>Nothing was changed</AlertTitle>
					<AlertDescription className="whitespace-pre-line">
						{error}
					</AlertDescription>
				</Alert>
			) : null}

			{(["read", "write"] as const).map((kind) => {
				const rows = view.operations.filter((o) => o.kind === kind);
				if (rows.length === 0) return null;
				const headingId = kind === "read" ? readsId : writesId;
				const notOn = rows.filter((o) => o.state !== "on");
				return (
					<section key={kind} className="space-y-2" aria-labelledby={headingId}>
						<div className="flex items-center justify-between gap-3">
							<h3 id={headingId} className="font-medium text-sm">
								{kind === "read" ? "Reads" : "Writes"}{" "}
								<span className="font-normal text-muted-foreground">
									{rows.length}
								</span>
							</h3>
							{kind === "read" && notOn.length > 0 ? (
								<Button
									size="sm"
									variant="outline"
									disabled={pending !== null}
									onClick={() =>
										run("reads", () =>
											turnOperationsOn(api, manifest, notOn, secretName),
										)
									}
								>
									{pending === "reads" ? (
										<Spinner className="size-4" aria-hidden="true" />
									) : null}
									Turn on all reads
								</Button>
							) : null}
						</div>
						<ul
							className="divide-y rounded-lg border"
							aria-label={kind === "read" ? "Reads" : "Writes"}
						>
							{rows.map((row) => (
								<OperationItem
									key={row.name}
									row={row}
									busy={pending === `op:${row.name}`}
									disabled={pending !== null}
									onToggle={(on, params) =>
										run(`op:${row.name}`, () =>
											on
												? turnOperationOn(
														api,
														manifest,
														row,
														secretName,
														params,
													)
												: turnOperationOff(api, row),
										)
									}
								/>
							))}
						</ul>
					</section>
				);
			})}

			{policies.length > 0 ? (
				<section className="space-y-2" aria-labelledby={policiesId}>
					<h3 id={policiesId} className="font-medium text-sm">
						Approval policies
					</h3>
					<p className="text-muted-foreground text-xs">
						Suggested with the operations and installed off. Turn one on to make
						a person approve matching calls.
					</p>
					<ul className="divide-y rounded-lg border">
						{policies.map((row) => (
							<PolicyItem
								key={row.name}
								row={row}
								busy={pending === `policy:${row.name}`}
								disabled={pending !== null}
								onEnable={() =>
									run(`policy:${row.name}`, () =>
										enablePolicy(api, manifest, row),
									)
								}
							/>
						))}
					</ul>
				</section>
			) : null}

			{limits.length > 0 ? (
				<section className="space-y-2" aria-labelledby={limitsId}>
					<h3 id={limitsId} className="font-medium text-sm">
						Limits
					</h3>
					<p className="text-muted-foreground text-xs">
						A limit refuses a call that would go past it. Nothing is created
						until you ask.
					</p>
					<ul className="divide-y rounded-lg border">
						{limits.map((row) => (
							<LimitItem
								key={row.name}
								row={row}
								api={api}
								manifest={manifest}
								onCreated={onChanged}
							/>
						))}
					</ul>
				</section>
			) : null}

			<div className="flex justify-end">
				<Button onClick={onNext}>Next: add to your agent</Button>
			</div>
		</div>
	);
}

function OperationItem({
	row,
	busy,
	disabled,
	onToggle,
}: {
	row: OperationRow;
	busy: boolean;
	disabled: boolean;
	onToggle: (on: boolean, params?: Record<string, string>) => void;
}) {
	const id = useId();
	const [summary] = row.description.split(" Limitation:");
	const needsSettings = row.state === "absent" && row.parameters.length > 0;
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [values, setValues] = useState<Record<string, string>>(() =>
		Object.fromEntries(row.parameters.map((p) => [p.name, p.default ?? ""])),
	);
	const invalid = row.parameters.filter((p) => {
		const value = values[p.name] ?? "";
		if (!value) return true;
		if (p.enum && !p.enum.includes(value)) return true;
		return p.pattern ? !new RegExp(p.pattern).test(value) : false;
	});
	return (
		<li className="flex flex-wrap items-start gap-3 p-3">
			<div className="min-w-0 flex-1 space-y-1">
				<Label htmlFor={id} className="font-mono text-sm" translate="no">
					{row.installedName}
				</Label>
				<p className="text-muted-foreground text-xs">{summary}</p>
				{row.description.includes("Limitation:") ? (
					<details className="text-muted-foreground text-xs">
						<summary className="cursor-pointer">Limitations</summary>
						<p className="mt-1">
							{row.description.slice(row.description.indexOf("Limitation:"))}
						</p>
					</details>
				) : null}
			</div>
			<div className="flex items-center gap-2">
				{busy ? <Spinner className="size-4" aria-hidden="true" /> : null}
				<span className="w-8 text-muted-foreground text-xs" aria-hidden="true">
					{row.state === "on" ? "On" : "Off"}
				</span>
				<Switch
					id={id}
					checked={row.state === "on"}
					disabled={disabled}
					onCheckedChange={(checked) =>
						checked === true && needsSettings
							? setSettingsOpen(true)
							: onToggle(checked === true)
					}
				/>
			</div>
			{settingsOpen && needsSettings ? (
				<form
					className="w-full space-y-3 border-primary/40 border-l-2 py-1 ps-3"
					aria-label={`Settings for ${row.installedName}`}
					onSubmit={(e) => {
						e.preventDefault();
						if (invalid.length > 0) return;
						setSettingsOpen(false);
						onToggle(true, values);
					}}
				>
					<p className="text-muted-foreground text-xs">
						This operation needs these settings. They are fixed into it when it
						is turned on, so your agent cannot change them.
					</p>
					{row.parameters.map((p) => (
						<div key={p.name} className="space-y-1">
							<Label htmlFor={`${id}-${p.name}`} className="font-mono text-xs">
								{p.name}
							</Label>
							{p.enum ? (
								<NativeSelect
									id={`${id}-${p.name}`}
									value={values[p.name] ?? ""}
									onChange={(e) =>
										setValues((v) => ({ ...v, [p.name]: e.target.value }))
									}
								>
									{p.enum.map((option) => (
										<NativeSelectOption key={option} value={option}>
											{option}
										</NativeSelectOption>
									))}
								</NativeSelect>
							) : (
								<Input
									id={`${id}-${p.name}`}
									value={values[p.name] ?? ""}
									autoComplete="off"
									spellCheck={false}
									onChange={(e) =>
										setValues((v) => ({
											...v,
											[p.name]: e.target.value.trim(),
										}))
									}
								/>
							)}
							<p className="text-muted-foreground text-xs">{p.description}</p>
						</div>
					))}
					<div className="flex gap-2">
						<Button
							type="submit"
							size="sm"
							disabled={invalid.length > 0 || disabled}
						>
							Turn on
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => setSettingsOpen(false)}
						>
							Cancel
						</Button>
					</div>
				</form>
			) : null}
		</li>
	);
}

function PolicyItem({
	row,
	busy,
	disabled,
	onEnable,
}: {
	row: PolicyRow;
	busy: boolean;
	disabled: boolean;
	onEnable: () => void;
}) {
	const enabled = row.installed?.enabled === true;
	return (
		<li className="flex items-start gap-3 p-3">
			<div className="min-w-0 flex-1 space-y-1">
				<p className="text-sm">{row.name}</p>
				<p className="text-muted-foreground text-xs">
					{row.effect === "auto_deny" ? "Refuses" : "Requires approval for"}{" "}
					{row.condition ? (
						<>
							calls where <code className="font-mono">{row.condition}</code>
						</>
					) : (
						"every call"
					)}
					.
				</p>
			</div>
			<div className="flex items-center gap-2">
				{busy ? <Spinner className="size-4" aria-hidden="true" /> : null}
				{enabled ? (
					<Badge variant="success">On</Badge>
				) : (
					<Switch
						aria-label={`Enable ${row.name}`}
						checked={false}
						disabled={disabled || !row.installed}
						onCheckedChange={(checked) => {
							if (checked === true) onEnable();
						}}
					/>
				)}
			</div>
		</li>
	);
}

function LimitItem({
	row,
	api,
	manifest,
	onCreated,
}: {
	row: LimitRow;
	api: OperationsApi;
	manifest: Manifest;
	onCreated: () => Promise<void>;
}) {
	const id = useId();
	const [amount, setAmount] = useState(String(row.suggestedAmount));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const value = Number(amount);
	const valid = Number.isInteger(value) && value > 0;
	const unit =
		row.currency ??
		(row.dimension === "resource_mutations" ? "changes" : row.dimension);

	const create = async () => {
		setBusy(true);
		setError(null);
		try {
			await createOperationLimit(api, manifest, row, value);
			await onCreated();
		} catch (e) {
			setError(
				isForbidden(e)
					? "Creating a limit needs permission to manage impact limits (impact-limits:write), which your role does not have. Ask a workspace admin to create it."
					: describeError(e),
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<li className="space-y-2 p-3">
			<div className="flex flex-wrap items-center gap-3">
				<Label htmlFor={id} className="min-w-0 flex-1 text-sm">
					{row.name}
				</Label>
				{row.created ? (
					<Badge variant="success">Created</Badge>
				) : (
					<>
						<Input
							id={id}
							inputMode="numeric"
							className="w-24 font-mono"
							value={amount}
							onChange={(e) => setAmount(e.target.value.trim())}
							aria-invalid={!valid}
						/>
						<span className="text-muted-foreground text-xs">
							{unit} per {row.period}
						</span>
						<Button
							size="sm"
							variant="outline"
							disabled={!valid || busy}
							onClick={() => void create()}
						>
							{busy ? <Spinner className="size-4" aria-hidden="true" /> : null}
							Create limit
						</Button>
					</>
				)}
			</div>
			{error ? (
				<p className="text-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
		</li>
	);
}

function CopyButton({ value, label }: { value: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			size="sm"
			variant="outline"
			aria-label={label}
			onClick={async () => {
				const result = await copyToClipboard(value);
				if (result.success) setCopied(true);
			}}
		>
			{copied ? (
				<Check className="size-4" aria-hidden="true" />
			) : (
				<Copy className="size-4" aria-hidden="true" />
			)}
			{copied ? "Copied" : "Copy"}
		</Button>
	);
}

export function AgentStep({
	workspaceId,
	workspaceName,
	environmentName,
	environmentId,
	integrationName,
	toolNames,
}: {
	workspaceId: string;
	workspaceName: string;
	environmentName: string;
	environmentId?: string;
	integrationName: string;
	toolNames: string[];
}) {
	const clientId = useId();
	const [client, setClient] = useState<AgentClient>("claude-code");
	const snippet = agentSnippet(client, {
		toolNames,
		workspaceName,
		environmentName,
	});

	return (
		<div className="space-y-4">
			{toolNames.length === 0 ? (
				<Alert variant="warning" role="status">
					<AlertTitle>No operations are on yet</AlertTitle>
					<AlertDescription>
						Turn on at least one operation first. Your agent only sees the ones
						that are on.
					</AlertDescription>
				</Alert>
			) : (
				<div className="space-y-1">
					<p className="text-sm">Your agent's tools:</p>
					<ul className="flex flex-wrap gap-1.5" aria-label="Tools">
						{toolNames.map((name) => (
							<li key={name}>
								<Badge variant="secondary" className="font-mono" translate="no">
									{name}
								</Badge>
							</li>
						))}
					</ul>
				</div>
			)}

			<div className="space-y-1">
				<Label htmlFor={clientId}>Your agent runs in</Label>
				<NativeSelect
					id={clientId}
					value={client}
					onChange={(e) => setClient(e.target.value as AgentClient)}
				>
					{AGENT_CLIENTS.map((c) => (
						<NativeSelectOption key={c.id} value={c.id}>
							{c.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</div>

			{snippet.blocks.map((b) => (
				<div key={b.code} className="relative">
					<pre
						className="overflow-x-auto rounded-lg border bg-muted p-3 pr-24 font-mono text-xs"
						data-language={b.language}
					>
						<code>{b.code}</code>
					</pre>
					<div className="absolute top-2 right-2">
						<CopyButton
							value={b.code}
							label={`Copy the ${b.language} snippet`}
						/>
					</div>
				</div>
			))}
			<p className="text-muted-foreground text-xs">{snippet.toolHint}</p>

			{snippet.signsIn ? null : (
				<AgentKeyCreator
					workspaceId={workspaceId}
					environmentId={environmentId}
					environmentName={environmentName}
				/>
			)}

			<p className="text-muted-foreground text-xs">
				A {integrationName} tool already in your own code is not governed by
				Anlyon. Replace it with these, or its calls go straight to{" "}
				{integrationName} with no approval, limit or receipt.
			</p>
		</div>
	);
}

function AgentKeyCreator({
	workspaceId,
	environmentId,
	environmentName,
}: {
	workspaceId: string;
	environmentId?: string;
	environmentName: string;
}) {
	const createApiKey = useCreateApiKey();
	const [key, setKey] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	if (key) {
		return (
			<Alert variant="success" role="status">
				<AlertTitle>Agent key created</AlertTitle>
				<AlertDescription className="space-y-2">
					<p>
						It is shown once. Store it where your agent reads ANLYON_API_KEY.
					</p>
					<div className="flex gap-2">
						<Input
							readOnly
							value={key}
							aria-label="Agent key"
							className="font-mono text-xs"
						/>
						<CopyButton value={key} label="Copy the agent key" />
					</div>
				</AlertDescription>
			</Alert>
		);
	}

	return (
		<div className="space-y-1 rounded-lg border p-3">
			<p className="text-sm">
				This needs an agent key for {environmentName}: it can invoke and read
				actions and read approvals ({AGENT_KEY_SCOPES.join(", ")}), and nothing
				else.
			</p>
			<Button
				size="sm"
				variant="outline"
				disabled={createApiKey.isPending}
				onClick={async () => {
					setError(null);
					try {
						const result = await createApiKey.mutateAsync({
							workspaceId,
							data: {
								name: "Agent key (connected account)",
								...(environmentId ? { environmentId } : {}),
								scopes: [...AGENT_KEY_SCOPES],
							},
						});
						setKey(result.key);
					} catch (e) {
						setError(describeError(e));
					}
				}}
			>
				<KeyRound className="size-4" aria-hidden="true" />
				Create an agent key
			</Button>
			{error ? (
				<p className="text-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}
