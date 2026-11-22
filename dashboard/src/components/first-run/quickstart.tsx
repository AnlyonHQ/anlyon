import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useState,
} from "react";
import { IntegrationLogo } from "@/components/actions/integration-logo";
import { AgentStep } from "@/components/actions/operations-flow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { actionKeys } from "@/hooks/api/use-actions";
import { useDecideApproval } from "@/hooks/api/use-approvals";
import {
	useConnectionIntegrations,
	useConnections,
	useConnectWithApiKey,
} from "@/hooks/api/use-connections";
import { useEnvironments } from "@/hooks/api/use-environments";
import { useAuth } from "@/hooks/use-auth";
import { ApiError, apiClient } from "@/lib/api-client";
import { SELF_APPROVED_LABEL } from "@/lib/approvals";
import { formatElapsed } from "@/lib/first-run";
import {
	useElapsed,
	useFirstRunHidden,
	useQuickstartChoice,
} from "@/lib/first-run-storage";
import {
	enablePolicy,
	installedActionName,
	type OperationsView,
	readOperations,
	turnOperationsOn,
} from "@/lib/operations";
import {
	cataloguePack,
	consoleTransport,
	type OperationsApi,
	PackError,
} from "@/lib/packs";
import {
	callLabel,
	connectedAccount,
	fillPrompt,
	journeyCalls,
	QUICKSTART_STEPS,
	type QuickstartRecipe,
	type QuickstartStep,
	quickstartStep,
	RECIPES,
	recipeFor,
	waitedWriteDecided,
} from "@/lib/quickstart";
import type {
	ConnectionIntegration,
	Invocation,
	PaginatedResponse,
} from "@/lib/types";
import { connectionKeyAuth } from "@/lib/types";
import { cn, copyToClipboard } from "@/lib/utils";
import { Dot, LiveDot, StepItem, StepList, StepProgress } from "./steps";

type Step = Exclude<QuickstartStep, "done">;
type Manifest = NonNullable<ReturnType<typeof cataloguePack>>;

const STEP_COPY: Record<
	Step,
	{ title: string; line: (name: string) => string }
> = {
	pick: {
		title: "A tool you use",
		line: () =>
			"Your agent will work in your own account, through Anlyon. Pick the one you know best.",
	},
	connect: {
		title: "Connect it",
		line: (name) =>
			`Paste a key. Anlyon checks it with ${name} and keeps it. Your agent never sees it.`,
	},
	tools: {
		title: "Its tools",
		line: () =>
			"Your agent gets the reads, and two writes: one runs at once, one waits for you.",
	},
	agent: {
		title: "Your agent",
		line: () =>
			"Add Anlyon to your agent, paste one prompt, and watch every call arrive here.",
	},
};

function describeError(error: unknown): string {
	if (error instanceof PackError) return error.message;
	if (error instanceof ApiError)
		return error.code ? `${error.message} (${error.code})` : error.message;
	return "The request failed. Nothing was changed.";
}

function defaultSecretName(integrationId: string): string {
	return integrationId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function toolsReadyIn(
	view: OperationsView | null,
	recipe: QuickstartRecipe | undefined,
): boolean {
	if (!view || !recipe) return false;
	const on = (name: string) =>
		view.operations.some((o) => o.name === name && o.state === "on");
	const gate = view.policies.find(
		(p) => p.actionName === recipe.waits && p.effect === "require_approval",
	);
	return (
		on(recipe.runs) &&
		on(recipe.waits) &&
		view.operations.some((o) => o.kind === "read" && o.state === "on") &&
		Boolean(gate?.installed?.enabled)
	);
}

export function Quickstart({
	workspaceId,
	workspaceName,
	operationsApi,
}: {
	workspaceId?: string;
	workspaceName?: string;
	operationsApi?: OperationsApi;
}) {
	const queryClient = useQueryClient();
	const integrationsQuery = useConnectionIntegrations(workspaceId);
	const connectionsQuery = useConnections(workspaceId);
	const environment = (useEnvironments(workspaceId).data ?? []).find(
		(env) => env.isDefault,
	);
	const [choice, setChoice] = useQuickstartChoice(workspaceId);
	const api = useMemo(
		() => operationsApi ?? (workspaceId ? consoleTransport(workspaceId) : null),
		[operationsApi, workspaceId],
	);

	const offered = useMemo(
		() =>
			RECIPES.map((recipe) =>
				(integrationsQuery.data ?? []).find(
					(i) => i.id === recipe.integration && connectionKeyAuth(i) !== null,
				),
			).filter((i): i is ConnectionIntegration => Boolean(i)),
		[integrationsQuery.data],
	);
	const integration = offered.find((i) => i.id === choice?.integration) ?? null;
	const recipe = integration ? recipeFor(integration.id) : undefined;
	const account = connectedAccount(
		connectionsQuery.data,
		integration?.id ?? null,
	);
	const manifest: Manifest | undefined = integration?.operationsPack
		? cataloguePack(integration.operationsPack)
		: undefined;

	const [view, setView] = useState<OperationsView | null>(null);
	const [viewError, setViewError] = useState<string | null>(null);
	const reload = useCallback(async () => {
		if (!api || !manifest || !account) {
			setView(null);
			return;
		}
		try {
			setView(await readOperations(api, manifest));
			setViewError(null);
		} catch (error) {
			setViewError(describeError(error));
		}
	}, [api, manifest, account]);
	useEffect(() => {
		void reload();
	}, [reload]);
	const toolsReady = toolsReadyIn(view, recipe);

	const prefix = manifest ? installedActionName(manifest, "") : "";
	const preStep = quickstartStep({
		integrationId: integration?.id ?? null,
		account,
		toolsReady,
		decided: null,
	});
	const watching = preStep === "agent";
	const callsQuery = useQuery({
		queryKey: [...actionKeys.all, "quickstart-calls", workspaceId],
		queryFn: () =>
			apiClient.get<PaginatedResponse<Invocation>>("/actions/invocations", {
				workspaceId,
				params: { limit: 25 },
			}),
		enabled: !!workspaceId && watching,
		refetchInterval: watching ? 2000 : false,
	});
	const calls = journeyCalls(
		callsQuery.data?.data,
		prefix,
		choice?.startedAt ?? null,
	);
	const decided =
		manifest && recipe
			? waitedWriteDecided(calls, installedActionName(manifest, recipe.waits))
			: null;
	const step: QuickstartStep = watching && decided ? "done" : preStep;
	const [selfApproved, setSelfApproved] = useState(false);

	useEffect(() => {
		if (step === "done" && choice && !choice.finishedAt)
			setChoice({ ...choice, finishedAt: new Date().toISOString() });
	}, [step, choice, setChoice]);
	const elapsedMs = useElapsed(
		choice?.startedAt ?? null,
		choice?.finishedAt ?? null,
	);

	const loading = integrationsQuery.isLoading || connectionsQuery.isLoading;
	if (loading) return <QuickstartSkeleton />;

	const completed = QUICKSTART_STEPS.filter((s) => isDone(step, s)).length;
	const name = integration?.name ?? "the provider";

	return (
		<article className="mx-auto w-full max-w-[46rem] pt-2 pb-24">
			<header>
				<div className="flex items-baseline justify-between gap-4 text-[13px] text-muted-foreground">
					<span>Get started</span>
					<span className="tabular-nums">
						{step === "done"
							? "Done"
							: `${completed} of ${QUICKSTART_STEPS.length}`}
						{elapsedMs !== null ? (
							<>
								<Dot />
								<span className="font-mono">{formatElapsed(elapsedMs)}</span>
							</>
						) : null}
					</span>
				</div>
				<StepProgress done={completed} total={QUICKSTART_STEPS.length} />
				<h2 className="mt-8 text-balance font-heading text-[2rem] leading-[1.1] tracking-[-0.02em]">
					Your agent, working in a tool you already use.
				</h2>
				<p className="mt-3 max-w-[38rem] text-pretty text-[15px] text-muted-foreground leading-relaxed">
					Connect one tool, give your agent its reads and two writes, then ask
					it to do something real. One write runs and comes back with a receipt.
					The other waits until you say yes. About two minutes.
				</p>
			</header>

			{integrationsQuery.error || connectionsQuery.error ? (
				<p aria-live="polite" className="mt-8 text-destructive text-sm">
					{describeError(integrationsQuery.error ?? connectionsQuery.error)}
				</p>
			) : null}

			<StepList>
				<QuickstartStepItem
					current={step}
					name={name}
					number={1}
					result={integration ? [integration.name] : []}
					step="pick"
				>
					<PickPanel
						connectedIds={(connectionsQuery.data ?? []).map(
							(s) => s.integrationId ?? s.connection?.integrationId ?? "",
						)}
						integrations={offered}
						onPick={(id) =>
							setChoice({
								integration: id,
								startedAt: new Date().toISOString(),
								finishedAt: null,
							})
						}
					/>
				</QuickstartStepItem>
				<QuickstartStepItem
					current={step}
					name={name}
					number={2}
					result={
						account ? [`connected as ${account.name}`, "key checked"] : []
					}
					step="connect"
				>
					{integration && workspaceId ? (
						<ConnectPanel integration={integration} workspaceId={workspaceId} />
					) : null}
				</QuickstartStepItem>
				<QuickstartStepItem
					current={step}
					name={name}
					number={3}
					result={
						view && recipe
							? [
									`${view.operations.filter((o) => o.kind === "read" && o.state === "on").length} reads`,
									`${recipe.runs} runs`,
									`${recipe.waits} waits for you`,
								]
							: []
					}
					step="tools"
				>
					{api && manifest && recipe && account ? (
						<ToolsPanel
							api={api}
							error={viewError}
							integrationName={name}
							manifest={manifest}
							onChanged={reload}
							recipe={recipe}
							secretName={account.name}
							view={view}
						/>
					) : null}
				</QuickstartStepItem>
				<QuickstartStepItem
					current={step}
					name={name}
					last
					number={4}
					result={decided ? ["your agent called", "you decided"] : []}
					step="agent"
				>
					{workspaceId && integration && recipe && view && manifest ? (
						<AgentPanel
							calls={calls}
							environmentId={environment?.id}
							environmentName={environment?.name ?? "the default environment"}
							integration={integration}
							manifest={manifest}
							onDecided={(self) => {
								setSelfApproved(Boolean(self));
								queryClient.invalidateQueries({
									queryKey: [
										...actionKeys.all,
										"quickstart-calls",
										workspaceId,
									],
								});
							}}
							recipe={recipe}
							view={view}
							workspaceId={workspaceId}
							workspaceName={workspaceName ?? "this workspace"}
						/>
					) : null}
				</QuickstartStepItem>
			</StepList>

			{step === "done" && integration && recipe && manifest && decided ? (
				<Outcome
					calls={calls}
					decided={decided}
					elapsedMs={elapsedMs}
					selfApproved={selfApproved}
					integration={integration}
					manifest={manifest}
					onAnother={() => setChoice(null)}
					recipe={recipe}
					workspaceId={workspaceId}
				/>
			) : (
				<p className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-muted-foreground">
					{integration ? (
						<button
							className="underline-offset-4 hover:text-foreground hover:underline"
							onClick={() => setChoice(null)}
							type="button"
						>
							Pick another tool
						</button>
					) : null}
					<Link
						className="underline-offset-4 hover:text-foreground hover:underline"
						search={{ tour: "sandbox" }}
						to="/get-started"
					>
						No key at hand? Try it in the sandbox
					</Link>
				</p>
			)}
		</article>
	);
}

function isDone(current: QuickstartStep, step: Step): boolean {
	if (current === "done") return true;
	return (
		QUICKSTART_STEPS.indexOf(step) < QUICKSTART_STEPS.indexOf(current as Step)
	);
}

function QuickstartStepItem({
	step,
	number,
	current,
	name,
	result,
	last,
	children,
}: {
	step: Step;
	number: number;
	current: QuickstartStep;
	name: string;
	result: string[];
	last?: boolean;
	children: ReactNode;
}) {
	const { title, line } = STEP_COPY[step];
	return (
		<StepItem
			last={last}
			line={line(name)}
			number={number}
			result={result}
			state={
				isDone(current, step) ? "done" : current === step ? "active" : "todo"
			}
			title={title}
		>
			{children}
		</StepItem>
	);
}

function PickPanel({
	integrations,
	connectedIds,
	onPick,
}: {
	integrations: ConnectionIntegration[];
	connectedIds: string[];
	onPick: (id: string) => void;
}) {
	if (integrations.length === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				No integration can be connected on this workspace yet.{" "}
				<Link
					className="underline underline-offset-4"
					search={{ tour: "sandbox" }}
					to="/get-started"
				>
					Try it in the sandbox
				</Link>
				.
			</p>
		);
	}
	return (
		<ul
			aria-label="Integrations"
			className="grid grid-cols-2 gap-2 sm:grid-cols-5"
		>
			{integrations.map((integration) => (
				<li key={integration.id}>
					<button
						className="flex w-full flex-col items-center gap-2 rounded-lg border bg-background px-2 py-3 text-[13px] transition-colors hover:border-foreground/30 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						onClick={() => onPick(integration.id)}
						type="button"
					>
						<IntegrationLogo
							className="size-9 rounded-md"
							id={integration.id}
							name={integration.name}
						/>
						<span className="font-medium">{integration.name}</span>
						{connectedIds.includes(integration.id) ? (
							<span className="text-[11px] text-muted-foreground">
								connected
							</span>
						) : null}
					</button>
				</li>
			))}
		</ul>
	);
}

function ConnectPanel({
	integration,
	workspaceId,
}: {
	integration: ConnectionIntegration;
	workspaceId: string;
}) {
	const keyId = useId();
	const connect = useConnectWithApiKey();
	const [apiKey, setApiKey] = useState("");
	const keyIsValid = /^[\x21-\x7e]{8,}$/.test(apiKey);
	const auth = connectionKeyAuth(integration);

	return (
		<form
			className="space-y-4"
			onSubmit={(event) => {
				event.preventDefault();
				if (!keyIsValid) return;
				connect.mutate(
					{
						workspaceId,
						integrationId: integration.id,
						secretName: defaultSecretName(integration.id),
						apiKey,
						description: "Connected from Get started",
					},
					{ onSuccess: () => setApiKey("") },
				);
			}}
		>
			{auth ? (
				<p className="text-pretty text-sm">
					<span className="text-muted-foreground">{auth.instructions}</span>{" "}
					<a
						className="whitespace-nowrap font-medium underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
						href={auth.instructionsUrl}
						rel="noreferrer noopener"
						target="_blank"
					>
						Create a key at {integration.name}
					</a>
				</p>
			) : null}
			<div className="space-y-1.5">
				<Label htmlFor={keyId}>{integration.name} key</Label>
				<div className="flex flex-col gap-2 sm:flex-row">
					<Input
						autoComplete="off"
						className="font-mono"
						id={keyId}
						onChange={(e) => setApiKey(e.target.value.trim())}
						spellCheck={false}
						type="password"
						value={apiKey}
					/>
					<Button disabled={!keyIsValid || connect.isPending} type="submit">
						{connect.isPending ? <Spinner className="size-4" /> : null}
						{connect.isPending ? "Checking…" : "Connect"}
					</Button>
				</div>
				<p className="text-[12.5px] text-muted-foreground">
					Stored as {defaultSecretName(integration.id)} and sent to{" "}
					{integration.hosts?.join(", ") ?? integration.name}, nowhere else.
					Nobody can read it back, including you.
				</p>
			</div>
			{connect.error ? (
				<p className="text-destructive text-sm" role="alert">
					{describeError(connect.error)}
				</p>
			) : null}
		</form>
	);
}

function ToolsPanel({
	api,
	integrationName,
	manifest,
	recipe,
	secretName,
	view,
	error,
	onChanged,
}: {
	api: OperationsApi;
	integrationName: string;
	manifest: Manifest;
	recipe: QuickstartRecipe;
	secretName: string;
	view: OperationsView | null;
	error: string | null;
	onChanged: () => Promise<void>;
}) {
	const [pending, setPending] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const formId = useId();
	const rows = view?.operations ?? [];
	const reads = rows.filter((o) => o.kind === "read");
	const writes = rows.filter((o) => o.kind === "write");
	const runs = rows.find((o) => o.name === recipe.runs);
	const waits = rows.find((o) => o.name === recipe.waits);
	const runsAction = manifest.actions.find((a) => a.name === recipe.runs);
	const runsReadsBack = Boolean(
		runsAction && "verify" in runsAction && runsAction.verify,
	);
	const parameters = [runs, waits]
		.flatMap((o) => o?.parameters ?? [])
		.filter((p, i, all) => all.findIndex((q) => q.name === p.name) === i);
	const [params, setParams] = useState<Record<string, string>>(() =>
		Object.fromEntries(parameters.map((p) => [p.name, p.default ?? ""])),
	);
	const paramsValid = parameters.every((p) => {
		const value = params[p.name] ?? p.default ?? "";
		return value !== "" && (!p.pattern || new RegExp(p.pattern).test(value));
	});

	if (error) {
		return (
			<p className="text-destructive text-sm" role="alert">
				{error}
			</p>
		);
	}
	if (!view) {
		return (
			<div aria-busy="true" className="space-y-2">
				<div className="h-10 rounded-lg bg-muted motion-safe:animate-pulse" />
				<div className="h-10 rounded-lg bg-muted motion-safe:animate-pulse" />
			</div>
		);
	}

	const turnOn = async () => {
		setPending(true);
		setFailure(null);
		try {
			const wanted = rows.filter(
				(o) =>
					o.state !== "on" &&
					(o.kind === "read" ||
						o.name === recipe.runs ||
						o.name === recipe.waits),
			);
			if (wanted.length > 0)
				await turnOperationsOn(api, manifest, wanted, secretName, params);
			const fresh = await readOperations(api, manifest);
			for (const policy of fresh.policies) {
				if (
					policy.actionName === recipe.waits &&
					policy.effect === "require_approval" &&
					policy.installed &&
					!policy.installed.enabled
				)
					await enablePolicy(api, manifest, policy);
			}
			await onChanged();
		} catch (e) {
			setFailure(describeError(e));
		} finally {
			setPending(false);
		}
	};

	return (
		<div className="space-y-4">
			<dl className="divide-y overflow-hidden rounded-lg border bg-background text-[13px]">
				<ToolRow
					label="Reads"
					note={`${reads
						.slice(0, 3)
						.map((r) => r.name)
						.join(
							", ",
						)}${reads.length > 3 ? ` and ${reads.length - 3} more` : ""}. They change nothing.`}
					value={`${reads.length} on`}
				/>
				<ToolRow
					label="Runs at once"
					mono={runs?.installedName}
					note={
						runsReadsBack
							? `Anlyon reads it back from ${integrationName} and gives a receipt that says it really happened.`
							: "Anlyon records the provider's answer as a receipt."
					}
					value="on"
				/>
				<ToolRow
					label="Waits for you"
					mono={waits?.installedName}
					note="Held until you approve it here. Deny it and nothing is sent."
					value="on, needs approval"
				/>
			</dl>
			<p className="text-[12.5px] text-muted-foreground">
				The other {Math.max(0, writes.length - 2)} writes stay off. Turn them
				on, or set a limit, under Integrations whenever you like.
			</p>

			{parameters.length > 0 ? (
				<fieldset className="space-y-3">
					<legend className="mb-2 text-sm">One setting to fill in</legend>
					{parameters.map((p) => (
						<div className="space-y-1" key={p.name}>
							<Label htmlFor={`${formId}-${p.name}`}>{p.name}</Label>
							<Input
								className="font-mono"
								id={`${formId}-${p.name}`}
								onChange={(e) =>
									setParams((current) => ({
										...current,
										[p.name]: e.target.value.trim(),
									}))
								}
								placeholder={p.default}
								value={params[p.name] ?? ""}
							/>
							<p className="text-[12px] text-muted-foreground">
								{p.description}
							</p>
						</div>
					))}
				</fieldset>
			) : null}

			<div className="flex items-center gap-3">
				<Button disabled={pending || !paramsValid} onClick={turnOn}>
					{pending ? <Spinner className="size-4" /> : null}
					Turn them on
				</Button>
				{failure ? (
					<p className="text-destructive text-sm" role="alert">
						{failure}
					</p>
				) : null}
			</div>
		</div>
	);
}

function ToolRow({
	label,
	value,
	note,
	mono,
}: {
	label: string;
	value: string;
	note: string;
	mono?: string;
}) {
	return (
		<div className="grid gap-1 px-3.5 py-3 sm:grid-cols-[8.5rem_minmax(0,1fr)_auto] sm:gap-4">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="min-w-0">
				{mono ? (
					<span
						className="block truncate font-mono text-[12.5px]"
						translate="no"
					>
						{mono}
					</span>
				) : null}
				<span className="block text-muted-foreground">{note}</span>
			</dd>
			<dd className="text-[12px] text-muted-foreground sm:text-right">
				{value}
			</dd>
		</div>
	);
}

function AgentPanel({
	workspaceId,
	workspaceName,
	environmentId,
	environmentName,
	integration,
	manifest,
	recipe,
	view,
	calls,
	onDecided,
}: {
	workspaceId: string;
	workspaceName: string;
	environmentId?: string;
	environmentName: string;
	integration: ConnectionIntegration;
	manifest: Manifest;
	recipe: QuickstartRecipe;
	view: OperationsView;
	calls: Invocation[];
	onDecided: (selfApproved?: boolean) => void;
}) {
	const { user } = useAuth();
	const fieldId = useId();
	const [values, setValues] = useState<Record<string, string>>({});
	const [copied, setCopied] = useState(false);
	const enabledTools = view.operations
		.filter((o) => o.state === "on")
		.map((o) => o.installedName);
	const fieldValue = (key: string) => {
		if (values[key] !== undefined) return values[key];
		const field = recipe.fields.find((f) => f.key === key);
		if (field?.fromUser === "email") return user?.email ?? "";
		return "";
	};
	const filled = fillPrompt(
		recipe,
		Object.fromEntries(recipe.fields.map((f) => [f.key, fieldValue(f.key)])),
	);

	return (
		<div className="space-y-8">
			<section aria-labelledby={`${fieldId}-a`} className="space-y-3">
				<SubHeading id={`${fieldId}-a`} number="1">
					Add Anlyon to your agent
				</SubHeading>
				<AgentStep
					environmentId={environmentId}
					environmentName={environmentName}
					integrationName={integration.name}
					toolNames={enabledTools}
					workspaceId={workspaceId}
					workspaceName={workspaceName}
				/>
			</section>

			<section aria-labelledby={`${fieldId}-b`} className="space-y-3">
				<SubHeading id={`${fieldId}-b`} number="2">
					Paste this into your agent
				</SubHeading>
				{recipe.fields.length > 0 ? (
					<div className="grid gap-3 sm:grid-cols-2">
						{recipe.fields
							.filter((f) => !f.fromParam)
							.map((field) => (
								<div className="space-y-1" key={field.key}>
									<Label htmlFor={`${fieldId}-${field.key}`}>
										{field.label}
									</Label>
									<Input
										className="font-mono"
										id={`${fieldId}-${field.key}`}
										onChange={(e) =>
											setValues((current) => ({
												...current,
												[field.key]: e.target.value,
											}))
										}
										placeholder={field.placeholder}
										value={fieldValue(field.key)}
									/>
								</div>
							))}
					</div>
				) : null}
				<div className="relative rounded-lg border bg-muted/50 p-4 pr-20">
					<p className="text-pretty text-[14px] leading-relaxed">{filled}</p>
					<Button
						className="absolute top-3 right-3"
						onClick={async () => {
							const result = await copyToClipboard(filled);
							if (result.success) {
								setCopied(true);
								setTimeout(() => setCopied(false), 1600);
							}
						}}
						size="sm"
						variant="outline"
					>
						{copied ? "Copied" : "Copy"}
					</Button>
				</div>
			</section>

			<section aria-labelledby={`${fieldId}-c`} className="space-y-3">
				<SubHeading id={`${fieldId}-c`} number="3">
					Watch it work
				</SubHeading>
				<LiveFeed
					calls={calls}
					integrationName={integration.name}
					manifest={manifest}
					onDecided={onDecided}
					recipe={recipe}
					view={view}
					workspaceId={workspaceId}
				/>
			</section>
		</div>
	);
}

function SubHeading({
	id,
	number,
	children,
}: {
	id: string;
	number: string;
	children: ReactNode;
}) {
	return (
		<h3 className="flex items-baseline gap-2.5 font-medium text-[14px]" id={id}>
			<span className="grid size-5 place-items-center rounded-full border font-mono text-[11px] text-muted-foreground">
				{number}
			</span>
			{children}
		</h3>
	);
}

const TONE: Record<ReturnType<typeof callLabel>["tone"], string> = {
	neutral: "text-muted-foreground",
	good: "text-emerald-700 dark:text-emerald-300",
	wait: "text-amber-700 dark:text-amber-300",
	bad: "text-destructive",
};

function LiveFeed({
	workspaceId,
	integrationName,
	manifest,
	recipe,
	view,
	calls,
	onDecided,
}: {
	workspaceId: string;
	integrationName: string;
	manifest: Manifest;
	recipe: QuickstartRecipe;
	view: OperationsView;
	calls: Invocation[];
	onDecided: (selfApproved?: boolean) => void;
}) {
	const decide = useDecideApproval();
	const kindOf = (installedName: string) =>
		view.operations.find((o) => o.installedName === installedName)?.kind ??
		"write";

	if (calls.length === 0) {
		return (
			<div
				aria-live="polite"
				className="flex items-center gap-3 rounded-lg border border-dashed px-4 py-4 text-[13.5px] text-muted-foreground"
				role="status"
			>
				<LiveDot />
				Waiting for your agent to call…
			</div>
		);
	}

	return (
		<ul
			aria-label="Your agent's calls"
			aria-live="polite"
			className="divide-y overflow-hidden rounded-lg border bg-background"
		>
			{calls.map((call) => {
				const label = callLabel(call);
				const waiting = call.status === "pending_approval" && call.approvalId;
				return (
					<li
						className={cn(
							"px-3.5 py-3 motion-safe:fade-in motion-safe:animate-in motion-safe:duration-500",
							waiting && "bg-amber-500/5",
						)}
						key={call.id}
					>
						<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
							<span
								className="min-w-0 truncate font-mono text-[12.5px]"
								translate="no"
							>
								{call.actionName}
							</span>
							<span className="flex items-baseline gap-2 text-[12px]">
								<span className="text-muted-foreground">
									{kindOf(call.actionName) === "read" ? "read" : "write"}
								</span>
								<span className={cn("font-medium", TONE[label.tone])}>
									{label.text}
								</span>
							</span>
						</div>
						{waiting ? (
							<div className="mt-2.5 flex flex-wrap items-center gap-2">
								<p className="mr-auto text-[13px] text-muted-foreground">
									Your agent is waiting. Nothing has been sent to{" "}
									{integrationName} yet.
								</p>
								<Button
									disabled={decide.isPending}
									onClick={() =>
										decide.mutate(
											{
												workspaceId,
												approvalId: call.approvalId as string,
												decision: "deny",
												note: "Get started",
											},
											{ onSettled: (data) => onDecided(data?.selfApproved) },
										)
									}
									size="sm"
									variant="outline"
								>
									Deny
								</Button>
								<Button
									disabled={decide.isPending}
									onClick={() =>
										decide.mutate(
											{
												workspaceId,
												approvalId: call.approvalId as string,
												decision: "approve",
												note: "Get started",
											},
											{ onSettled: (data) => onDecided(data?.selfApproved) },
										)
									}
									size="sm"
								>
									Approve
								</Button>
							</div>
						) : call.actionName ===
								installedActionName(manifest, recipe.runs) &&
							call.status === "succeeded" ? (
							<p className="mt-1 text-[12.5px] text-muted-foreground">
								Receipt recorded.{" "}
								<Link
									className="underline underline-offset-4"
									search={{ invocation: call.id, status: undefined }}
									to="/actions/invocations"
								>
									Open it
								</Link>
							</p>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

function Outcome({
	integration,
	manifest,
	recipe,
	calls,
	decided,
	elapsedMs,
	onAnother,
	selfApproved,
	workspaceId,
}: {
	integration: ConnectionIntegration;
	manifest: Manifest;
	recipe: QuickstartRecipe;
	calls: Invocation[];
	decided: Invocation;
	elapsedMs: number | null;
	onAnother: () => void;
	selfApproved: boolean;
	workspaceId?: string;
}) {
	const [, setHidden] = useFirstRunHidden(workspaceId);
	const runsName = installedActionName(manifest, recipe.runs);
	const reads = calls.filter(
		(c) =>
			c.actionName !== runsName &&
			c.actionName !== installedActionName(manifest, recipe.waits) &&
			c.status === "succeeded",
	).length;
	const ran = calls.find(
		(c) => c.actionName === runsName && c.status === "succeeded",
	);
	const approved = decided.status !== "failed";

	return (
		<section
			aria-labelledby="quickstart-outcome"
			className="mt-10 motion-safe:fade-in motion-safe:animate-in motion-safe:duration-700"
		>
			<h2
				className="text-balance font-semibold text-[1.625rem] leading-tight tracking-[-0.015em]"
				id="quickstart-outcome"
			>
				Your agent just worked in your {integration.name}, on your terms.
			</h2>
			<p className="mt-3 max-w-[38rem] text-[14px] text-muted-foreground">
				It never held the key. Every call went through Anlyon, and every one
				left a record.
			</p>

			<dl className="mt-6 divide-y overflow-hidden rounded-lg border bg-card text-[13.5px]">
				<OutcomeRow label="It read">
					{reads > 0
						? `${reads} ${reads === 1 ? "call" : "calls"} to ${integration.name}, nothing changed`
						: "No reads in this run"}
				</OutcomeRow>
				<OutcomeRow label="It ran">
					{ran ? (
						<>
							<span className="font-mono text-[12.5px]">{runsName}</span>, with
							a receipt
						</>
					) : (
						"The write that runs at once was not called"
					)}
				</OutcomeRow>
				<OutcomeRow label="It waited for you">
					<span className="font-mono text-[12.5px]">{decided.actionName}</span>,{" "}
					{approved
						? selfApproved
							? `${SELF_APPROVED_LABEL}, then sent`
							: "approved by you, then sent"
						: selfApproved
							? "denied by you (sole approver in this environment), never sent"
							: "denied by you, never sent"}
				</OutcomeRow>
			</dl>
			{elapsedMs !== null ? (
				<p className="mt-3 font-mono text-[12px] text-muted-foreground tabular-nums">
					finished in {formatElapsed(elapsedMs)}
				</p>
			) : null}

			<h3 className="mt-10 font-medium text-[15px]">Next</h3>
			<ul className="mt-3 divide-y border-y">
				<NextRow
					action={
						<Link
							className="whitespace-nowrap text-[13px] underline-offset-4 hover:underline"
							to="/integrations"
						>
							Open Integrations
						</Link>
					}
					body={`Turn on more of ${integration.name}'s writes, and choose which wait for a person.`}
					title="Give it more to do"
				/>
				<NextRow
					action={
						<Link
							className="whitespace-nowrap text-[13px] underline-offset-4 hover:underline"
							search={{ environmentId: undefined }}
							to="/actions/limits"
						>
							Open limits
						</Link>
					}
					body="Cap what your agents may do in a day, across every key and every agent."
					title="Set a limit"
				/>
				<NextRow
					action={
						<button
							className="whitespace-nowrap text-[13px] underline-offset-4 hover:underline"
							onClick={onAnother}
							type="button"
						>
							Pick a tool
						</button>
					}
					body="Stripe, GitHub, Notion, Intercom and more, each with reads and governed writes."
					title="Connect another tool"
				/>
			</ul>

			<p className="mt-8 text-[13px] text-muted-foreground">
				<button
					className="underline-offset-4 hover:text-foreground hover:underline"
					onClick={() => setHidden(true)}
					type="button"
				>
					Hide Get Started from the sidebar
				</button>
			</p>
		</section>
	);
}

function OutcomeRow({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
			<dt className="text-muted-foreground">{label}</dt>
			<dd>{children}</dd>
		</div>
	);
}

function NextRow({
	title,
	body,
	action,
}: {
	title: string;
	body: string;
	action: ReactNode;
}) {
	return (
		<li className="flex items-baseline justify-between gap-6 py-3.5">
			<div className="min-w-0">
				<p className="font-medium text-[14px]">{title}</p>
				<p className="mt-0.5 text-[13px] text-muted-foreground">{body}</p>
			</div>
			{action}
		</li>
	);
}

function QuickstartSkeleton() {
	return (
		<div
			aria-busy="true"
			className="mx-auto w-full max-w-[46rem] space-y-4 pt-2"
		>
			<div className="h-3 w-24 rounded bg-muted motion-safe:animate-pulse" />
			<div className="h-9 w-[28rem] max-w-full rounded bg-muted motion-safe:animate-pulse" />
			<div className="h-4 w-80 max-w-full rounded bg-muted motion-safe:animate-pulse" />
		</div>
	);
}
