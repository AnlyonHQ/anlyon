import type { EditorView } from "@codemirror/view";
import { Link } from "@tanstack/react-router";
import {
	ArrowUpRight,
	CircleAlert,
	FileCode2,
	Info,
	LayoutTemplate,
	Play,
	TriangleAlert,
	Undo2,
	Upload,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { RelativeTime } from "@/components/ui/relative-time";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useActions } from "@/hooks/api/use-actions";
import {
	useAnalyzeFunctionSource,
	useFunctionVersion,
	usePublishFunctionVersion,
	useStartFunctionRun,
} from "@/hooks/api/use-functions";
import {
	BUDGETS,
	CALL_STATE_LABEL,
	clearDraft,
	EMPTY_BUDGETS,
	FUNCTION_LANGUAGES,
	FUNCTION_TEMPLATES,
	loadDraft,
	needsManualAllowList,
	type PublishDraft,
	parseNameList,
	parseRunInput,
	publishBody,
	RUN_MODE_LABEL,
	runStatusNote,
	SOURCE_FILE,
	saveDraft,
	sourceWarnings,
} from "@/lib/functions";
import type {
	FunctionLanguage,
	FunctionRun,
	FunctionSourceFindings,
	HostedFunction,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { CodeEditor } from "./code-editor";
import { RunStatus } from "./run-detail";
import { NameBadges } from "./version-summary";

const isMac =
	typeof navigator !== "undefined" &&
	/Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";

type Config = Omit<PublishDraft, "language" | "source">;

export function configFrom(fn: HostedFunction): Config {
	const version = fn.currentVersion;
	const listed =
		!!version?.review?.ast && needsManualAllowList(version.review.ast);
	return {
		allowedActions: listed ? version.allowedActions.join(", ") : "",
		budgets: version
			? {
					maxActionCalls: String(version.budgets.maxActionCalls),
					maxCpuMs: String(version.budgets.maxCpuMs),
					maxSubrequests: String(version.budgets.maxSubrequests),
					timeoutMs: String(version.budgets.timeoutMs),
				}
			: { ...EMPTY_BUDGETS },
		straightThrough: {
			enabled: !!version?.straightThrough,
			actions: version?.straightThrough?.actions.join(", ") ?? "",
			maxWrites: version?.straightThrough
				? String(version.straightThrough.maxWrites)
				: "1",
		},
	};
}

export function FunctionWorkspace({
	fn,
	workspaceId,
	canManage,
	canInvoke,
}: {
	fn: HostedFunction;
	workspaceId?: string;
	canManage: boolean;
	canInvoke: boolean;
}) {
	const published = fn.currentVersion;
	const current = useFunctionVersion(
		workspaceId,
		fn.name,
		"current",
		!!published,
	);
	const ready = !published || current.data?.version === published.version;

	if (published && current.isError) {
		return (
			<div
				className="flex min-h-[20rem] flex-col items-center justify-center gap-3 rounded-lg border bg-card p-6 text-center"
				role="alert"
			>
				<CircleAlert aria-hidden="true" className="size-5 text-destructive" />
				<div className="space-y-1">
					<p className="font-medium text-sm">
						The source of v{published.version} could not be loaded
					</p>
					<p className="text-[13px] text-muted-foreground">
						{(current.error as Error).message}
					</p>
				</div>
				<Button
					loading={current.isFetching}
					onClick={() => current.refetch()}
					size="sm"
					variant="outline"
				>
					Try again
				</Button>
			</div>
		);
	}

	if (!ready) {
		return (
			<div
				aria-busy="true"
				className="overflow-hidden rounded-lg border bg-card"
			>
				<div className="h-10 border-b" />
				<div className="space-y-2 p-4">
					{[72, 56, 64, 40, 68, 52].map((width) => (
						<Skeleton
							className="h-4"
							key={width}
							style={{ width: `${width}%` }}
						/>
					))}
				</div>
			</div>
		);
	}

	return (
		<Workspace
			canInvoke={canInvoke}
			canManage={canManage}
			fn={fn}
			key={`${fn.id}-${published?.version ?? 0}`}
			publishedSource={current.data?.source ?? null}
			workspaceId={workspaceId}
		/>
	);
}

function Workspace({
	fn,
	workspaceId,
	canManage,
	canInvoke,
	publishedSource,
}: {
	fn: HostedFunction;
	workspaceId?: string;
	canManage: boolean;
	canInvoke: boolean;
	publishedSource: string | null;
}) {
	const published = fn.currentVersion;
	const [initial] = useState(() => {
		const stored = workspaceId ? loadDraft(workspaceId, fn.name) : null;
		if (stored) return { ...stored, restored: true };
		if (published && publishedSource !== null) {
			return {
				language: published.language,
				source: publishedSource,
				baseVersion: published.version,
				restored: false,
			};
		}
		const template = FUNCTION_TEMPLATES[0];
		return {
			language: "javascript" as FunctionLanguage,
			source: published ? "" : (template?.source.javascript ?? ""),
			baseVersion: published?.version ?? null,
			restored: false,
		};
	});
	const [language, setLanguage] = useState<FunctionLanguage>(initial.language);
	const [source, setSource] = useState(initial.source);
	const [config, setConfig] = useState<Config>(() => configFrom(fn));
	const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
	const [side, setSide] = useState<"test" | "config">("test");
	const [findings, setFindings] = useState<FunctionSourceFindings | null>(null);
	const [analysisError, setAnalysisError] = useState<string | null>(null);
	const [lastRun, setLastRun] = useState<FunctionRun | null>(null);
	const [inputText, setInputText] = useState("{}");
	const [inputError, setInputError] = useState<string | null>(null);
	const viewRef = useRef<EditorView | null>(null);

	const analyze = useAnalyzeFunctionSource(workspaceId, { quiet: true });
	const publish = usePublishFunctionVersion(workspaceId);
	const start = useStartFunctionRun(workspaceId);
	const actions = useActions(workspaceId);
	const actionList = useMemo(
		() =>
			(actions.data ?? [])
				.filter((action) => action.enabled)
				.map((action) => ({
					name: action.name,
					method: action.method,
					description: action.description,
				})),
		[actions.data],
	);

	const sourceChanged = published
		? source !== (publishedSource ?? "") || language !== published.language
		: source.trim() !== "";
	const baseline = useMemo(() => configFrom(fn), [fn]);
	const configChanged = JSON.stringify(config) !== JSON.stringify(baseline);
	const changed = sourceChanged || configChanged || !published;

	useEffect(() => {
		if (!workspaceId) return;
		if (sourceChanged) {
			saveDraft(workspaceId, fn.name, {
				language,
				source,
				baseVersion: published?.version ?? null,
			});
		} else {
			clearDraft(workspaceId, fn.name);
		}
	}, [workspaceId, fn.name, language, source, sourceChanged, published]);

	const { mutate: runAnalysis } = analyze;
	useEffect(() => {
		if (!canManage || !source.trim()) {
			setFindings(null);
			return;
		}
		const timer = setTimeout(() => {
			runAnalysis(
				{ language, source },
				{
					onSuccess: (result) => {
						setFindings(result);
						setAnalysisError(null);
					},
					onError: (error) => setAnalysisError(error.message),
				},
			);
		}, 900);
		return () => clearTimeout(timer);
	}, [canManage, language, source, runAnalysis]);

	const allowList = parseNameList(config.allowedActions);
	const manualNeeded = findings !== null && needsManualAllowList(findings);

	const publishNow = useCallback(() => {
		if (!canManage || publish.isPending) return;
		const result = publishBody({ ...config, language, source });
		if (!result.ok) {
			setErrors(result.errors);
			if (!result.errors.source) setSide("config");
			return;
		}
		if (manualNeeded && allowList.length === 0) {
			setErrors({
				allowedActions:
					"The source computes an action name or could not be read. List the actions it calls.",
			});
			setSide("config");
			return;
		}
		setErrors({});
		publish.mutate(
			{ name: fn.name, body: result.body },
			{
				onSuccess: () => {
					if (workspaceId) clearDraft(workspaceId, fn.name);
				},
			},
		);
	}, [
		canManage,
		publish,
		config,
		language,
		source,
		manualNeeded,
		allowList.length,
		fn.name,
		workspaceId,
	]);

	const runNow = useCallback(() => {
		if (!canInvoke || !published || start.isPending) return;
		const parsed = parseRunInput(inputText);
		if (!parsed.ok) {
			setInputError(parsed.error);
			setSide("test");
			return;
		}
		setSide("test");
		start.mutate(
			{ name: fn.name, mode: "plan", input: parsed.value },
			{ onSuccess: (run) => setLastRun(run) },
		);
	}, [canInvoke, published, start, inputText, fn.name]);

	const discard = () => {
		if (!published) return;
		setSource(publishedSource ?? "");
		setLanguage(published.language);
		setConfig(configFrom(fn));
		setErrors({});
	};

	const switchLanguage = (next: FunctionLanguage) => {
		const template = FUNCTION_TEMPLATES.find(
			(item) => item.source[language] === source,
		);
		if (template) setSource(template.source[next]);
		setLanguage(next);
	};

	const reveal = (line: number | null) => {
		const view = viewRef.current;
		if (!view || line === null) return;
		const target = view.state.doc.line(
			Math.min(Math.max(line, 1), view.state.doc.lines),
		);
		view.dispatch({
			selection: { anchor: target.from, head: target.to },
			scrollIntoView: true,
		});
		view.focus();
	};

	const warnings = findings ? sourceWarnings(findings) : [];
	const problemCount =
		warnings.length + (analysisError ? 1 : 0) + (errors.source ? 1 : 0);

	return (
		<div className="flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card">
			<div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-2.5 py-1">
				<div className="flex min-w-0 items-center gap-2 text-[13px]">
					<FileCode2
						aria-hidden="true"
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<span className="font-mono text-[13px]" translate="no">
						{SOURCE_FILE[language]}
					</span>
					{sourceChanged ? (
						<span
							className="inline-flex items-center gap-1.5 text-muted-foreground text-xs"
							title="Saved in this browser until you publish or discard it"
						>
							<span
								aria-hidden="true"
								className="size-1.5 rounded-full bg-warning"
							/>
							{published ? "Unpublished changes" : "Draft"}
						</span>
					) : null}
				</div>
				<div className="ms-auto flex flex-wrap items-center gap-2">
					{canManage && !published ? (
						<Menu>
							<MenuTrigger
								render={
									<Button size="xs" variant="ghost">
										<LayoutTemplate aria-hidden="true" />
										Templates
									</Button>
								}
							/>
							<MenuPopup align="end" className="w-80">
								{FUNCTION_TEMPLATES.map((template) => (
									<MenuItem
										className="flex-col items-start gap-0.5 py-2"
										key={template.id}
										onClick={() => setSource(template.source[language])}
									>
										<span className="font-medium text-sm">
											{template.label}
										</span>
										<span className="text-muted-foreground text-xs">
											{template.description}
										</span>
									</MenuItem>
								))}
							</MenuPopup>
						</Menu>
					) : null}
					{canManage ? (
						<SegmentedControl
							label="Language"
							onChange={switchLanguage}
							options={FUNCTION_LANGUAGES}
							value={language}
						/>
					) : null}
					{canManage && published && changed ? (
						<Button onClick={discard} size="xs" variant="ghost">
							<Undo2 aria-hidden="true" />
							Discard changes
						</Button>
					) : null}
					{canManage ? (
						<Button
							disabled={!changed}
							loading={publish.isPending}
							onClick={publishNow}
							size="xs"
						>
							<Upload aria-hidden="true" />
							Publish version
							<Kbd>{MOD} S</Kbd>
						</Button>
					) : (
						<p className="text-muted-foreground text-xs">
							Publishing a version needs permission to manage actions.
						</p>
					)}
				</div>
			</div>

			<div className="grid min-h-[36rem] min-w-0 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
				<div className="flex min-h-0 min-w-0 flex-col">
					{initial.restored && sourceChanged ? (
						<p className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-muted-foreground text-xs">
							<Info aria-hidden="true" className="size-3.5 shrink-0" />
							<span>
								Your unpublished draft was restored from this browser.
								{published &&
								initial.baseVersion !== null &&
								initial.baseVersion !== published.version
									? ` It was started from v${initial.baseVersion}; v${published.version} is current now.`
									: null}
							</span>
						</p>
					) : null}
					<div className="relative min-h-[24rem] flex-1">
						<CodeEditor
							actions={actionList}
							className="absolute inset-0 overflow-auto"
							label="Source"
							language={language}
							onChange={(value) => {
								setSource(value);
								setErrors((previous) =>
									previous.source
										? { ...previous, source: undefined }
										: previous,
								);
							}}
							onReady={(view) => {
								viewRef.current = view;
							}}
							onRun={runNow}
							onSave={publishNow}
							placeholder="export default async function run(input, anlyon) { … }"
							readOnly={!canManage}
							value={source}
						/>
					</div>
					<ProblemsStrip
						analysisError={analysisError}
						checking={analyze.isPending}
						count={problemCount}
						findings={findings}
						onReveal={reveal}
						sourceError={errors.source ?? null}
						warnings={warnings}
					/>
				</div>

				<aside className="flex min-h-0 min-w-0 flex-col border-t lg:border-t-0 lg:border-l">
					<Tabs
						className="flex min-h-0 flex-1 flex-col"
						onValueChange={(value) => setSide(value as "test" | "config")}
						value={side}
					>
						<div className="border-b px-2">
							<TabsList className="h-9" variant="underline">
								<TabsTab value="test">
									<Play aria-hidden="true" />
									Test
								</TabsTab>
								<TabsTab value="config">
									Config
									{errors.allowedActions ||
									BUDGETS.some((budget) => errors[budget.name]) ||
									errors.straightThroughActions ||
									errors.straightThroughMaxWrites ? (
										<span className="size-1.5 rounded-full bg-destructive">
											<span className="sr-only">, has problems</span>
										</span>
									) : null}
								</TabsTab>
							</TabsList>
						</div>
						<TabsPanel className="min-h-0 overflow-y-auto" value="test">
							<TestPanel
								canInvoke={canInvoke}
								error={inputError}
								input={inputText}
								lastRun={lastRun}
								onInput={(value) => {
									setInputText(value);
									setInputError(null);
								}}
								onRun={runNow}
								published={published?.version ?? null}
								running={start.isPending}
								sourceChanged={sourceChanged}
							/>
						</TabsPanel>
						<TabsPanel className="min-h-0 overflow-y-auto" value="config">
							<ConfigPanel
								actionNames={actionList.map((action) => action.name)}
								config={config}
								disabled={!canManage}
								errors={errors}
								findings={findings}
								manualNeeded={manualNeeded}
								onChange={(patch) => {
									setConfig((previous) => ({ ...previous, ...patch }));
									setErrors({});
								}}
							/>
						</TabsPanel>
					</Tabs>
				</aside>
			</div>

			<div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-1 border-t bg-muted/30 px-3 py-1 text-muted-foreground text-xs">
				{published ? (
					<>
						<span className="tabular-nums">
							v{published.version} is current
						</span>
						<span>
							published <RelativeTime value={published.createdAt} />
						</span>
						<span
							className="hidden font-mono md:inline"
							title={published.digest}
						>
							{published.digest.slice(0, 19)}…
						</span>
					</>
				) : (
					<span>Not published yet. Publishing makes this v1.</span>
				)}
				<span className="ms-auto hidden items-center gap-1.5 sm:inline-flex">
					<Kbd>{MOD} S</Kbd> publish
					<Kbd className="ms-2">{MOD} ↵</Kbd> plan run
				</span>
			</div>
		</div>
	);
}

function ProblemsStrip({
	findings,
	warnings,
	analysisError,
	sourceError,
	checking,
	count,
	onReveal,
}: {
	findings: FunctionSourceFindings | null;
	warnings: ReturnType<typeof sourceWarnings>;
	analysisError: string | null;
	sourceError: string | null;
	checking: boolean;
	count: number;
	onReveal: (line: number | null) => void;
}) {
	const calls = findings?.calls ?? [];
	return (
		<section
			aria-label="What the source calls"
			className="max-h-44 shrink-0 overflow-y-auto border-t text-xs"
		>
			<div className="sticky top-0 flex items-center gap-2 border-b bg-card px-3 py-1 font-medium text-muted-foreground">
				<span className="text-foreground">Problems</span>
				<span className="rounded-full bg-muted px-1.5 tabular-nums">
					{count}
				</span>
				<span className="ms-3 text-foreground">Calls</span>
				<span className="rounded-full bg-muted px-1.5 tabular-nums">
					{calls.length}
				</span>
				<span className="ms-auto font-normal">
					{checking ? "Checking…" : findings ? "Checked as you type" : ""}
				</span>
			</div>
			<ul className="divide-y">
				{sourceError ? (
					<ProblemRow
						icon="error"
						line={null}
						message={sourceError}
						onReveal={onReveal}
					/>
				) : null}
				{analysisError ? (
					<ProblemRow
						icon="error"
						line={null}
						message={`The source could not be checked: ${analysisError}`}
						onReveal={onReveal}
					/>
				) : null}
				{warnings.map((warning) => (
					<ProblemRow
						icon={warning.kind === "parse" ? "error" : "warning"}
						key={`${warning.kind}-${warning.line}-${warning.message}`}
						line={warning.line}
						message={warning.message}
						onReveal={onReveal}
					/>
				))}
				{calls.map((call) => (
					<ProblemRow
						icon="info"
						key={`call-${call.line}-${call.action}-${call.kind}`}
						line={call.line}
						message={
							<>
								<span className="font-mono text-foreground">
									anlyon.{call.kind}("{call.action}")
								</span>{" "}
								<span className="text-muted-foreground">
									{call.kind === "read"
										? "reads: sent in a plan run"
										: "writes: recorded in a plan run, sent once approved"}
								</span>
							</>
						}
						onReveal={onReveal}
					/>
				))}
				{!sourceError &&
				!analysisError &&
				warnings.length === 0 &&
				calls.length === 0 ? (
					<li className="px-3 py-1.5 text-muted-foreground">
						{findings
							? 'No action calls yet. Type anlyon.read(" or anlyon.invoke(" to pick one of your actions.'
							: "What the source calls shows here as you type."}
					</li>
				) : null}
			</ul>
		</section>
	);
}

function ProblemRow({
	icon,
	line,
	message,
	onReveal,
}: {
	icon: "error" | "warning" | "info";
	line: number | null;
	message: React.ReactNode;
	onReveal: (line: number | null) => void;
}) {
	const Icon =
		icon === "error" ? CircleAlert : icon === "warning" ? TriangleAlert : Info;
	return (
		<li>
			<button
				className="flex w-full items-start gap-2.5 px-3 py-1 text-left outline-none hover:bg-muted/50 focus-visible:bg-muted/50 disabled:cursor-default disabled:hover:bg-transparent"
				disabled={line === null}
				onClick={() => onReveal(line)}
				type="button"
			>
				<Icon
					aria-hidden="true"
					className={cn(
						"mt-px size-3.5 shrink-0",
						icon === "error"
							? "text-destructive"
							: icon === "warning"
								? "text-warning"
								: "text-muted-foreground",
					)}
				/>
				<span className="min-w-0 flex-1 leading-5">{message}</span>
				{line !== null ? (
					<span className="shrink-0 text-muted-foreground tabular-nums">
						line {line}
					</span>
				) : null}
			</button>
		</li>
	);
}

function TestPanel({
	canInvoke,
	published,
	sourceChanged,
	input,
	error,
	onInput,
	onRun,
	running,
	lastRun,
}: {
	canInvoke: boolean;
	published: number | null;
	sourceChanged: boolean;
	input: string;
	error: string | null;
	onInput: (value: string) => void;
	onRun: () => void;
	running: boolean;
	lastRun: FunctionRun | null;
}) {
	const id = useId();
	if (!canInvoke) {
		return (
			<p className="p-3.5 text-[13px] text-muted-foreground">
				Starting a run needs permission to invoke actions.
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-3 p-3.5">
			<div className="space-y-2">
				<Label htmlFor={`${id}-input`}>Input (JSON)</Label>
				<Textarea
					aria-describedby={`${id}-input-hint`}
					aria-invalid={error ? true : undefined}
					autoCapitalize="none"
					className="font-mono text-xs"
					id={`${id}-input`}
					onChange={(e) => onInput(e.target.value)}
					onKeyDown={(event) => {
						if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
							event.preventDefault();
							onRun();
						}
					}}
					placeholder='{"id": "rec_123"}'
					rows={5}
					spellCheck={false}
					value={input}
				/>
				<p
					className={
						error ? "text-destructive text-xs" : "text-muted-foreground text-xs"
					}
					id={`${id}-input-hint`}
				>
					{error ??
						(published === null
							? "Publish a version before starting a run."
							: sourceChanged
								? `Runs v${published}, the published version. Publish to run your changes.`
								: "Reads are sent; writes are recorded as a plan for approval.")}
				</p>
			</div>
			<Button
				className="self-start"
				disabled={published === null}
				loading={running}
				onClick={onRun}
				size="sm"
			>
				<Play aria-hidden="true" />
				Start plan run
			</Button>
			{lastRun ? <RunResult run={lastRun} /> : null}
		</div>
	);
}

function RunResult({ run }: { run: FunctionRun }) {
	const writes = run.plan?.writes ?? [];
	return (
		<section
			aria-label="Last run"
			className="space-y-3 border-t pt-3 text-[13px]"
		>
			<div className="flex flex-wrap items-center gap-2">
				<RunStatus status={run.status} />
				<Badge variant="outline">{RUN_MODE_LABEL[run.mode]}</Badge>
				{run.durationMs !== null ? (
					<span className="text-muted-foreground text-xs tabular-nums">
						{run.durationMs} ms
					</span>
				) : null}
				<Link
					className="ms-auto inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
					params={{ runId: run.id }}
					to="/functions/runs/$runId"
				>
					Open run
					<ArrowUpRight aria-hidden="true" className="size-3" />
				</Link>
			</div>
			<p className="text-muted-foreground text-xs leading-relaxed">
				{runStatusNote(run)}
			</p>
			{writes.length > 0 ? (
				<div className="space-y-1.5">
					<p className="font-medium text-xs">Planned writes</p>
					<ol className="space-y-1.5">
						{writes.map((write) => (
							<li className="rounded-md bg-muted/50 p-2" key={write.sequence}>
								<p className="font-mono text-xs">{write.action}</p>
								<pre className="mt-1 overflow-x-auto font-mono text-[11px] text-muted-foreground leading-5">
									{JSON.stringify(write.input, null, 2)}
								</pre>
							</li>
						))}
					</ol>
					{run.plan?.approval ? (
						<Link
							className="inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
							search={{ id: run.plan.approval.id }}
							to="/approvals"
						>
							Open the approval
							<ArrowUpRight aria-hidden="true" className="size-3" />
						</Link>
					) : null}
				</div>
			) : null}
			<OutputBlock label="Output" value={run.output} />
			{run.logs.length > 0 ? (
				<div className="space-y-1">
					<p className="font-medium text-xs">Logs</p>
					<pre className="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-5">
						{run.logs.join("\n")}
					</pre>
				</div>
			) : null}
			{run.calls.length > 0 ? (
				<div className="space-y-1">
					<p className="font-medium text-xs">Calls</p>
					<ol className="divide-y rounded-md border text-xs">
						{run.calls.map((call) => (
							<li
								className="flex items-center gap-2 px-2 py-1.5"
								key={call.sequence}
							>
								<span className="w-4 text-muted-foreground tabular-nums">
									{call.sequence}
								</span>
								<span className="min-w-0 flex-1 truncate font-mono">
									{call.action}
								</span>
								<span className="text-muted-foreground">
									{call.kind === "read" ? "Read" : "Write"}
								</span>
								<span
									className={cn(
										call.state === "refused" || call.state === "failed"
											? "text-destructive"
											: "text-foreground",
									)}
								>
									{call.refusal ?? CALL_STATE_LABEL[call.state]}
								</span>
							</li>
						))}
					</ol>
				</div>
			) : null}
		</section>
	);
}

function OutputBlock({ label, value }: { label: string; value: unknown }) {
	if (value === null || value === undefined) return null;
	return (
		<div className="space-y-1">
			<p className="font-medium text-xs">{label}</p>
			<pre className="max-h-64 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-5">
				{JSON.stringify(value, null, 2)}
			</pre>
		</div>
	);
}

function ConfigPanel({
	config,
	errors,
	findings,
	manualNeeded,
	actionNames,
	disabled,
	onChange,
}: {
	config: Config;
	errors: Partial<Record<string, string>>;
	findings: FunctionSourceFindings | null;
	manualNeeded: boolean;
	actionNames: string[];
	disabled: boolean;
	onChange: (patch: Partial<Config>) => void;
}) {
	const id = useId();
	const listed = config.allowedActions.trim() !== "" || manualNeeded;
	const proposed = findings?.proposedAllowedActions ?? [];
	return (
		<div className="flex flex-col gap-5 p-3.5">
			<fieldset className="space-y-2.5" disabled={disabled}>
				<legend className="font-medium text-[13px]">Allowed actions</legend>
				<p className="text-muted-foreground text-xs leading-relaxed">
					The actions a run may call. A call to any other is refused where the
					function runs and again by the API.
				</p>
				<SegmentedControl
					label="Where the allow-list comes from"
					onChange={(mode) =>
						onChange({
							allowedActions:
								mode === "source"
									? ""
									: config.allowedActions || proposed.join(", "),
						})
					}
					options={[
						{ value: "source", label: "From the source" },
						{ value: "listed", label: "Listed" },
					]}
					value={listed ? "listed" : "source"}
				/>
				{listed ? (
					<div className="space-y-1.5">
						<Label className="sr-only" htmlFor={`${id}-allowed`}>
							Allowed actions
						</Label>
						<Input
							aria-describedby={`${id}-allowed-hint`}
							aria-invalid={errors.allowedActions ? true : undefined}
							autoCapitalize="none"
							className="font-mono text-xs"
							id={`${id}-allowed`}
							list={`${id}-action-names`}
							onChange={(e) => onChange({ allowedActions: e.target.value })}
							placeholder="get-record, update-record"
							spellCheck={false}
							value={config.allowedActions}
						/>
						<datalist id={`${id}-action-names`}>
							{actionNames.map((name) => (
								<option key={name} value={name} />
							))}
						</datalist>
						<p
							className={
								errors.allowedActions
									? "text-destructive text-xs"
									: "text-muted-foreground text-xs"
							}
							id={`${id}-allowed-hint`}
						>
							{errors.allowedActions ??
								(manualNeeded
									? "The source computes an action name, so list every action it calls."
									: "Comma-separated. Each must exist and be enabled.")}
						</p>
					</div>
				) : (
					<div className="space-y-1.5 text-xs">
						{proposed.length > 0 ? (
							<NameBadges names={proposed} />
						) : (
							<p className="text-muted-foreground">
								{findings
									? "The source calls no actions yet."
									: "Read from the source's literal calls when you publish."}
							</p>
						)}
						{errors.allowedActions ? (
							<p className="text-destructive">{errors.allowedActions}</p>
						) : null}
					</div>
				)}
			</fieldset>

			<fieldset className="space-y-3" disabled={disabled}>
				<legend className="font-medium text-[13px]">Budgets per run</legend>
				<p className="text-muted-foreground text-xs">
					When one runs out, the run ends as budget exceeded. Left empty, the
					default applies.
				</p>
				<div className="grid grid-cols-2 gap-3">
					{BUDGETS.map((budget) => (
						<div className="space-y-1" key={budget.name}>
							<Label className="text-xs" htmlFor={`${id}-${budget.name}`}>
								{budget.label}
							</Label>
							<Input
								aria-describedby={`${id}-${budget.name}-hint`}
								aria-invalid={errors[budget.name] ? true : undefined}
								className="tabular-nums"
								id={`${id}-${budget.name}`}
								inputMode="numeric"
								onChange={(e) =>
									onChange({
										budgets: {
											...config.budgets,
											[budget.name]: e.target.value,
										},
									})
								}
								placeholder={String(budget.defaultValue)}
								value={config.budgets[budget.name]}
							/>
							{errors[budget.name] ? (
								<p
									className="text-destructive text-xs"
									id={`${id}-${budget.name}-hint`}
								>
									{errors[budget.name]}
								</p>
							) : (
								<p className="sr-only" id={`${id}-${budget.name}-hint`}>
									{budget.hint}
								</p>
							)}
						</div>
					))}
				</div>
			</fieldset>

			<fieldset className="space-y-3" disabled={disabled}>
				<legend className="font-medium text-[13px]">Straight through</legend>
				<div className="flex items-start gap-2">
					<Checkbox
						checked={config.straightThrough.enabled}
						id={`${id}-st`}
						onCheckedChange={(checked) =>
							onChange({
								straightThrough: {
									...config.straightThrough,
									enabled: checked === true,
								},
							})
						}
					/>
					<div className="space-y-0.5">
						<Label htmlFor={`${id}-st`}>Let some writes skip the plan</Label>
						<p className="text-muted-foreground text-xs leading-relaxed">
							A straight-through run may write to these actions, up to the
							limit, without a plan or its approval. Every write is still
							governed and receipted.
						</p>
					</div>
				</div>
				{config.straightThrough.enabled ? (
					<div className="grid grid-cols-[1fr_6rem] gap-3">
						<div className="space-y-1">
							<Label className="text-xs" htmlFor={`${id}-st-actions`}>
								Actions
							</Label>
							<Input
								aria-invalid={errors.straightThroughActions ? true : undefined}
								autoCapitalize="none"
								className="font-mono text-xs"
								id={`${id}-st-actions`}
								list={`${id}-action-names`}
								onChange={(e) =>
									onChange({
										straightThrough: {
											...config.straightThrough,
											actions: e.target.value,
										},
									})
								}
								placeholder="send-receipt"
								spellCheck={false}
								value={config.straightThrough.actions}
							/>
						</div>
						<div className="space-y-1">
							<Label className="text-xs" htmlFor={`${id}-st-max`}>
								Writes a run
							</Label>
							<Input
								aria-invalid={
									errors.straightThroughMaxWrites ? true : undefined
								}
								className="tabular-nums"
								id={`${id}-st-max`}
								inputMode="numeric"
								onChange={(e) =>
									onChange({
										straightThrough: {
											...config.straightThrough,
											maxWrites: e.target.value,
										},
									})
								}
								value={config.straightThrough.maxWrites}
							/>
						</div>
						{errors.straightThroughActions ||
						errors.straightThroughMaxWrites ? (
							<p className="col-span-2 text-destructive text-xs">
								{errors.straightThroughActions ??
									errors.straightThroughMaxWrites}
							</p>
						) : null}
					</div>
				) : null}
			</fieldset>
		</div>
	);
}
