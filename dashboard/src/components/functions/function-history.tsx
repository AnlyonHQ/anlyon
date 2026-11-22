import { Link, useNavigate } from "@tanstack/react-router";
import { Check, Code2, Copy, FilePenLine } from "lucide-react";
import { useState } from "react";
import { ListFrame, PropertyList } from "@/components/layout/page";
import { ActingFor } from "@/components/shared/acting-for";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverPopup,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/ui/popover";
import { RelativeTime } from "@/components/ui/relative-time";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	useFunctionRuns,
	useFunctionVersion,
	useFunctionVersions,
} from "@/hooks/api/use-functions";
import {
	BUDGET_LABEL,
	BUDGETS,
	FUNCTION_LANGUAGES,
	RUN_MODE_LABEL,
	saveDraft,
} from "@/lib/functions";
import type { FunctionVersion, HostedFunction } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CodeEditor } from "./code-editor";
import { RunStatus } from "./run-detail";
import { OpenRunById } from "./runs-panel";
import { NameBadges, VersionReview } from "./version-summary";

export const languageLabel = (value: string) =>
	FUNCTION_LANGUAGES.find((language) => language.value === value)?.label ??
	value;

export function FunctionRunsList({
	fn,
	workspaceId,
}: {
	fn: HostedFunction;
	workspaceId?: string;
}) {
	const navigate = useNavigate();
	const query = useFunctionRuns(workspaceId, fn.name);
	const runs = query.data ?? [];
	const open = (runId: string) =>
		navigate({ to: "/functions/runs/$runId", params: { runId } });

	return (
		<div className="flex flex-col gap-3">
			<div className="flex justify-end">
				<OpenRunById />
			</div>
			{query.isError ? (
				<p className="text-destructive text-sm" role="alert">
					Runs could not be loaded: {(query.error as Error).message}
				</p>
			) : query.isLoading ? (
				<ListFrame padded>
					<div aria-busy="true" className="space-y-2">
						{[0, 1, 2].map((i) => (
							<Skeleton className="h-8 w-full" key={i} />
						))}
					</div>
				</ListFrame>
			) : runs.length === 0 ? (
				<ListFrame padded>
					<p className="text-muted-foreground text-sm">
						No runs yet. Start a plan run from the Code tab, or call the
						function from your app.
					</p>
				</ListFrame>
			) : (
				<ListFrame
					footer={
						<span className="tabular-nums">
							{runs.length === 1 ? "1 run" : `${runs.length} runs`}
							{runs.length >= 50 ? ", the latest 50" : ""}
						</span>
					}
				>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Run</TableHead>
								<TableHead className="w-40">Status</TableHead>
								<TableHead className="hidden w-32 sm:table-cell">
									Mode
								</TableHead>
								<TableHead className="hidden w-20 md:table-cell">
									Version
								</TableHead>
								<TableHead className="hidden w-20 text-right md:table-cell">
									Calls
								</TableHead>
								<TableHead className="hidden w-24 text-right lg:table-cell">
									Duration
								</TableHead>
								<TableHead className="w-32 text-right">Started</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{runs.map((run) => (
								<TableRow
									className="cursor-pointer"
									key={run.id}
									onClick={() => open(run.id)}
								>
									<TableCell className="max-w-0 py-2.5">
										<Link
											className="block truncate rounded-sm font-mono text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
											onClick={(event) => event.stopPropagation()}
											params={{ runId: run.id }}
											to="/functions/runs/$runId"
										>
											{run.id}
										</Link>
										<ActingFor endUserId={run.endUserId} />
									</TableCell>
									<TableCell className="py-2.5">
										<RunStatus status={run.status} />
									</TableCell>
									<TableCell className="hidden py-2.5 text-muted-foreground sm:table-cell">
										{RUN_MODE_LABEL[run.mode]}
									</TableCell>
									<TableCell className="hidden py-2.5 tabular-nums md:table-cell">
										v{run.version}
									</TableCell>
									<TableCell className="hidden py-2.5 text-right tabular-nums md:table-cell">
										{run.actionCalls}
									</TableCell>
									<TableCell className="hidden py-2.5 text-right text-muted-foreground tabular-nums lg:table-cell">
										{run.durationMs === null ? "" : `${run.durationMs} ms`}
									</TableCell>
									<TableCell className="py-2.5 text-right text-muted-foreground">
										<RelativeTime value={run.createdAt} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</ListFrame>
			)}
		</div>
	);
}

export function FunctionVersions({
	fn,
	workspaceId,
	selected,
	onSelect,
	canManage,
}: {
	fn: HostedFunction;
	workspaceId?: string;
	selected?: number;
	onSelect: (version: number | undefined) => void;
	canManage: boolean;
}) {
	const navigate = useNavigate();
	const list = useFunctionVersions(workspaceId, fn.name);
	const versions = list.data ?? [];
	const shown =
		versions.find((version) => version.version === selected) ??
		versions.find((version) => version.current) ??
		versions[0];
	const detail = useFunctionVersion(
		workspaceId,
		fn.name,
		shown?.version ?? 0,
		!!shown,
	);

	if (!fn.currentVersion) {
		return (
			<ListFrame padded>
				<p className="text-muted-foreground text-sm">
					Nothing published yet. Each publish adds a version here, and earlier
					ones are kept.
				</p>
			</ListFrame>
		);
	}
	if (list.isError) {
		return (
			<p className="text-destructive text-sm" role="alert">
				Versions could not be loaded: {(list.error as Error).message}
			</p>
		);
	}
	if (list.isLoading || !shown) {
		return (
			<div aria-busy="true" className="space-y-3">
				<Skeleton className="h-32 w-full rounded-lg" />
				<Skeleton className="h-64 w-full rounded-lg" />
			</div>
		);
	}

	const source =
		detail.data?.version === shown.version ? detail.data.source : null;
	const openInEditor = () => {
		if (!workspaceId || source === null) return;
		saveDraft(workspaceId, fn.name, {
			language: shown.language,
			source,
			baseVersion: fn.currentVersion?.version ?? null,
		});
		navigate({
			to: "/functions/$name",
			params: { name: fn.name },
			search: {},
		});
	};

	return (
		<div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_17rem] xl:gap-10">
			<div className="flex min-w-0 flex-col gap-6">
				<ListFrame>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Version</TableHead>
								<TableHead className="hidden sm:table-cell">Language</TableHead>
								<TableHead className="hidden md:table-cell">Digest</TableHead>
								<TableHead className="w-32 text-right">Published</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{versions.map((version) => {
								const active = version.version === shown.version;
								return (
									<TableRow
										aria-selected={active}
										className={cn("cursor-pointer", active && "bg-muted/50")}
										key={version.id}
										onClick={() =>
											onSelect(version.current ? undefined : version.version)
										}
									>
										<TableCell className="py-2.5">
											<button
												aria-pressed={active}
												className="inline-flex items-center gap-2 rounded-sm font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
												onClick={(event) => {
													event.stopPropagation();
													onSelect(
														version.current ? undefined : version.version,
													);
												}}
												type="button"
											>
												v{version.version}
												{version.current ? (
													<Badge size="sm" variant="success">
														Current
													</Badge>
												) : null}
											</button>
										</TableCell>
										<TableCell className="hidden py-2.5 text-muted-foreground sm:table-cell">
											{languageLabel(version.language)}
										</TableCell>
										<TableCell className="hidden max-w-0 truncate py-2.5 font-mono text-muted-foreground text-xs md:table-cell">
											{version.digest}
										</TableCell>
										<TableCell className="py-2.5 text-right text-muted-foreground">
											<RelativeTime value={version.createdAt} />
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</ListFrame>

				<section
					aria-label={`Source of v${shown.version}`}
					className="overflow-hidden rounded-lg border bg-card"
				>
					<div className="flex min-h-10 flex-wrap items-center gap-2 border-b px-2.5 py-1">
						<span className="font-medium text-sm tabular-nums">
							v{shown.version}
						</span>
						<span className="text-muted-foreground text-xs">
							{languageLabel(shown.language)}, read-only
						</span>
						{canManage ? (
							<Button
								className="ms-auto"
								disabled={source === null}
								onClick={openInEditor}
								size="xs"
								variant="outline"
							>
								<FilePenLine aria-hidden="true" />
								{shown.current ? "Open in editor" : "Restore in editor"}
							</Button>
						) : null}
					</div>
					<div className="h-[28rem]">
						{detail.isError ? (
							<p className="p-4 text-destructive text-sm" role="alert">
								The source could not be loaded:{" "}
								{(detail.error as Error).message}
							</p>
						) : source === null ? (
							<div aria-busy="true" className="space-y-2 p-5">
								{[64, 48, 72, 40].map((width) => (
									<Skeleton
										className="h-4"
										key={width}
										style={{ width: `${width}%` }}
									/>
								))}
							</div>
						) : (
							<CodeEditor
								label={`Source of v${shown.version}`}
								language={shown.language}
								onChange={() => {}}
								readOnly
								value={source}
							/>
						)}
					</div>
				</section>

				<VersionReview review={shown.review} />
			</div>

			<aside className="min-w-0 lg:border-l lg:ps-8">
				<div className="flex flex-col gap-6 lg:sticky lg:top-20">
					<VersionFacts version={shown} />
				</div>
			</aside>
		</div>
	);
}

export function VersionFacts({ version }: { version: FunctionVersion }) {
	return (
		<PropertyList
			items={[
				{
					label: "Published",
					value: <RelativeTime value={version.createdAt} />,
				},
				{ label: "Language", value: languageLabel(version.language) },
				{
					label: "Allowed actions",
					value: <NameBadges names={version.allowedActions} />,
				},
				{
					label: "Budgets per run",
					value: (
						<ul className="space-y-0.5">
							{BUDGETS.map((budget) => (
								<li className="flex justify-between gap-3" key={budget.name}>
									<span className="text-muted-foreground">
										{BUDGET_LABEL[budget.name]}
									</span>
									<span className="tabular-nums">
										{version.budgets[budget.name]}
										{budget.name === "maxCpuMs" || budget.name === "timeoutMs"
											? " ms"
											: ""}
									</span>
								</li>
							))}
						</ul>
					),
				},
				{
					label: "Straight through",
					value: version.straightThrough ? (
						<span className="flex flex-col gap-1">
							<NameBadges names={version.straightThrough.actions} />
							<span className="text-muted-foreground text-xs">
								up to {version.straightThrough.maxWrites}{" "}
								{version.straightThrough.maxWrites === 1 ? "write" : "writes"} a
								run
							</span>
						</span>
					) : (
						<span className="text-muted-foreground">Off</span>
					),
				},
				{
					label: "Source digest",
					value: (
						<span className="block break-all font-mono text-xs">
							{version.digest}
						</span>
					),
				},
			]}
			title={`Version ${version.version}`}
		/>
	);
}

type Snippet = "typescript" | "python" | "curl";

export function UseInCode({ name }: { name: string }) {
	const [language, setLanguage] = useState<Snippet>("typescript");
	const [copied, setCopied] = useState(false);
	const snippets: Record<Snippet, string> = {
		typescript: `const { data: run } = await anlyon.functions.run(${JSON.stringify(name)}, {
  input: { id: "rec_123" },
});
// run.status: "succeeded", or "awaiting_approval" with run.plan`,
		python: `run = anlyon.functions.run(${JSON.stringify(name)}, {"id": "rec_123"}).data
# run["status"]: "succeeded", or "awaiting_approval" with run["plan"]`,
		curl: `curl -X POST https://api.anlyon.com/api/v2/functions/${encodeURIComponent(name)}/runs \\
  -H "Authorization: Bearer $ANLYON_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"input": {"id": "rec_123"}}'`,
	};
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(snippets[language]);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
		}
	};
	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button size="sm" variant="outline">
						<Code2 aria-hidden="true" />
						Use in code
					</Button>
				}
			/>
			<PopoverPopup align="end" className="w-[min(34rem,calc(100vw-2rem))]">
				<div className="flex flex-col gap-2.5">
					<PopoverTitle className="font-semibold text-[13px]">
						Run it from your app
					</PopoverTitle>
					<div className="overflow-hidden rounded-md border">
						<div className="flex h-9 items-center justify-between gap-2 border-b bg-muted/40 ps-1 pe-1">
							<SegmentedControl
								className="flex items-center gap-0.5"
								label="Language"
								onChange={(value) => {
									setLanguage(value);
									setCopied(false);
								}}
								options={[
									{ value: "typescript", label: "TypeScript" },
									{ value: "python", label: "Python" },
									{ value: "curl", label: "HTTP" },
								]}
								segmentClassName={(_option, on) =>
									cn(
										"h-7 rounded-[5px] px-2 font-medium text-xs transition-colors",
										on
											? "bg-background text-foreground shadow-xs ring-1 ring-border/60"
											: "text-muted-foreground hover:text-foreground",
									)
								}
								value={language}
							/>
							<Button onClick={copy} size="xs" variant="ghost">
								{copied ? (
									<Check aria-hidden="true" />
								) : (
									<Copy aria-hidden="true" />
								)}
								{copied ? "Copied" : "Copy"}
							</Button>
						</div>
						<pre className="overflow-x-auto bg-card p-3 font-mono text-[12px] leading-5">
							{snippets[language]}
						</pre>
					</div>
					<p className="text-muted-foreground text-xs leading-relaxed">
						A run is a plan by default: reads go through, writes wait for an
						approval, then run it again with mode "apply" and the plan's run id.
					</p>
				</div>
			</PopoverPopup>
		</Popover>
	);
}
