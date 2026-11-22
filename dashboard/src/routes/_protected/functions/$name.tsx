"use client";

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DeleteFunctionButton } from "@/components/functions/delete-function-button";
import {
	FunctionRunsList,
	FunctionVersions,
	languageLabel,
	UseInCode,
} from "@/components/functions/function-history";
import { FunctionWorkspace } from "@/components/functions/function-workspace";
import {
	Page,
	PageHeader,
	type PageTab,
	PageTabsView,
} from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/contexts/workspace-context";
import { useFunctions } from "@/hooks/api/use-functions";
import { useCan } from "@/hooks/api/use-permissions";

export type FunctionTab = "code" | "runs" | "versions";

interface FunctionSearch {
	tab?: Exclude<FunctionTab, "code">;
	version?: number;
}

export const Route = createFileRoute("/_protected/functions/$name")({
	validateSearch: (search: Record<string, unknown>): FunctionSearch => {
		const tab =
			search.tab === "runs" || search.tab === "versions"
				? search.tab
				: undefined;
		const version = Number(search.version);
		return {
			tab,
			version:
				tab === "versions" && Number.isInteger(version) && version > 0
					? version
					: undefined,
		};
	},
	component: FunctionRoute,
});

function FunctionRoute() {
	const { name } = Route.useParams();
	const { tab, version } = Route.useSearch();
	return <FunctionPage name={name} tab={tab ?? "code"} version={version} />;
}

export function FunctionPage({
	name,
	tab = "code",
	version,
}: {
	name: string;
	tab?: FunctionTab;
	version?: number;
}) {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const navigate = useNavigate();
	const query = useFunctions(workspaceId);
	const can = useCan(workspaceId);
	const canManage = can("actions.manage");
	const canInvoke = can("actions.invoke");
	const fn = query.data?.find((item) => item.name === name);

	if (query.isLoading) {
		return (
			<Page aria-busy="true">
				<Skeleton className="mt-2 h-8 w-64" />
				<Skeleton className="h-10 w-full" />
				<Skeleton className="h-[34rem] w-full rounded-lg" />
			</Page>
		);
	}
	if (query.isError) {
		return (
			<p className="text-destructive text-sm" role="alert">
				Functions could not be loaded: {(query.error as Error).message}
			</p>
		);
	}
	if (!fn) {
		return (
			<Empty className="py-16">
				<EmptyHeader>
					<EmptyTitle>No function named “{name}”</EmptyTitle>
					<EmptyDescription>
						It is not in this environment. Pick one from the list.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button render={<Link to="/functions" />} size="sm" variant="outline">
						View functions
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	const current = fn.currentVersion;
	const tabs: Array<PageTab & { tab: FunctionTab }> = [
		{ tab: "code", label: "Code", to: "/functions/$name", params: { name } },
		{
			tab: "runs",
			label: "Runs",
			to: "/functions/$name",
			params: { name },
			search: { tab: "runs" },
		},
		{
			tab: "versions",
			label: "Versions",
			to: "/functions/$name",
			params: { name },
			search: { tab: "versions" },
			count: current?.version,
		},
	];

	return (
		<Page>
			<PageHeader
				actions={
					<>
						<UseInCode name={fn.name} />
						{canManage ? (
							<DeleteFunctionButton
								name={fn.name}
								onDeleted={() => navigate({ to: "/functions" })}
								workspaceId={workspaceId}
							/>
						) : null}
					</>
				}
				description={
					fn.description ??
					"Your code that calls your actions with the network off. Reads go through; writes become a plan someone approves."
				}
				eyebrow="Function"
				meta={
					current ? (
						<>
							<Badge className="tabular-nums" variant="outline">
								v{current.version}
							</Badge>
							<Badge variant="secondary">
								{languageLabel(current.language)}
							</Badge>
						</>
					) : (
						<Badge variant="outline">Not published</Badge>
					)
				}
				mono
				title={<span translate="no">{fn.name}</span>}
			/>
			<PageTabsView
				isActive={(item) => (item as (typeof tabs)[number]).tab === tab}
				items={tabs}
				label="Function"
			/>
			{tab === "runs" ? (
				<FunctionRunsList fn={fn} workspaceId={workspaceId} />
			) : tab === "versions" ? (
				<FunctionVersions
					canManage={canManage}
					fn={fn}
					onSelect={(next) =>
						navigate({
							to: "/functions/$name",
							params: { name },
							search: { tab: "versions", version: next },
							replace: true,
						})
					}
					selected={version}
					workspaceId={workspaceId}
				/>
			) : (
				<FunctionWorkspace
					canInvoke={canInvoke}
					canManage={canManage}
					fn={fn}
					workspaceId={workspaceId}
				/>
			)}
		</Page>
	);
}
