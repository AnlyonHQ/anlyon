"use client";

import { createFileRoute, Link } from "@tanstack/react-router";
import { ListEmpty, ListLoading } from "@/components/governance/list-empty";
import {
	ListFrame,
	Page,
	PageHeader,
	PageToolbar,
} from "@/components/layout/page";
import { SignOffStatusBadge } from "@/components/sign-offs/sign-off-review";
import { RelativeTime } from "@/components/ui/relative-time";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useWorkspace } from "@/contexts/workspace-context";
import { useActorNames } from "@/hooks/api/use-actor-names";
import { useSignOffs } from "@/hooks/api/use-sign-offs";
import {
	describeRequester,
	parseSignOffFilter,
	SIGN_OFF_FILTERS,
	SIGN_OFF_STATUS_LABEL,
	type SignOffFilter,
} from "@/lib/sign-offs";

type SignOffsSearch = {
	status?: Exclude<SignOffFilter, "pending">;
};

export const Route = createFileRoute("/_protected/sign-offs/")({
	validateSearch: (search: Record<string, unknown>): SignOffsSearch => {
		const status = parseSignOffFilter(search.status);
		return { status: status === "pending" ? undefined : status };
	},
	component: SignOffsRoute,
});

function SignOffsRoute() {
	const { status } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<SignOffsPage
			filter={status ?? "pending"}
			onFilter={(next) =>
				navigate({
					to: "/sign-offs",
					search: { status: next === "pending" ? undefined : next },
					replace: true,
				})
			}
		/>
	);
}

const FILTER_OPTIONS = SIGN_OFF_FILTERS.map((value) => ({
	value,
	label: value === "all" ? "All" : SIGN_OFF_STATUS_LABEL[value],
}));

export function SignOffsPage({
	filter,
	onFilter,
}: {
	filter: SignOffFilter;
	onFilter: (next: SignOffFilter) => void;
}) {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const query = useSignOffs(workspaceId, filter === "all" ? undefined : filter);
	const nameOf = useActorNames(workspaceId);
	const rows = query.data ?? [];

	return (
		<Page>
			<PageHeader
				description="Changes your agents asked for that loosen their own guardrails, such as a higher limit or a new write action. A person in this workspace approves or rejects each one."
				title="Sign-offs"
			/>
			<PageToolbar>
				<SegmentedControl
					label="Status"
					onChange={onFilter}
					options={FILTER_OPTIONS}
					value={filter}
				/>
			</PageToolbar>

			{query.isError ? (
				<ListFrame padded>
					<p className="text-destructive text-sm" role="alert">
						Sign-offs could not be loaded: {(query.error as Error).message}
					</p>
				</ListFrame>
			) : query.isLoading || !workspaceId ? (
				<ListFrame>
					<ListLoading rows={3} />
				</ListFrame>
			) : rows.length === 0 ? (
				<ListFrame>
					<ListEmpty
						description={
							filter === "pending"
								? "When an agent asks to loosen a limit, a policy or an action, the request waits here, and the agent gets a link to give you."
								: undefined
						}
						role="status"
						title={
							filter === "pending"
								? "Nothing is waiting for a sign-off."
								: filter === "all"
									? "No sign-off requests yet."
									: `No ${SIGN_OFF_STATUS_LABEL[filter].toLowerCase()} requests.`
						}
					/>
				</ListFrame>
			) : (
				<ListFrame
					footer={
						<span className="tabular-nums">
							{rows.length} {rows.length === 1 ? "request" : "requests"}
						</span>
					}
				>
					<Table aria-busy={query.isFetching}>
						<TableHeader>
							<TableRow>
								<TableHead>Request</TableHead>
								<TableHead className="hidden w-56 md:table-cell">
									Asked by
								</TableHead>
								<TableHead className="w-28">Status</TableHead>
								<TableHead className="hidden w-32 text-right sm:table-cell">
									Asked
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((signOff) => (
								<TableRow className="group/row relative" key={signOff.id}>
									<TableCell className="max-w-0 py-3">
										<Link
											className="block truncate rounded-sm font-medium text-sm outline-none after:absolute after:inset-0 focus-visible:ring-2 focus-visible:ring-ring group-hover/row:underline group-hover/row:underline-offset-2"
											params={{ signOffId: signOff.id }}
											title={signOff.summary}
											to="/sign-offs/$signOffId"
										>
											{signOff.summary}
										</Link>
										<span
											className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground"
											translate="no"
										>
											{signOff.operation}
										</span>
									</TableCell>
									<TableCell className="hidden max-w-0 truncate text-muted-foreground md:table-cell">
										{describeRequester(signOff.requestedBy, nameOf).text}
									</TableCell>
									<TableCell>
										<SignOffStatusBadge status={signOff.status} />
									</TableCell>
									<TableCell className="hidden text-right text-muted-foreground sm:table-cell">
										<RelativeTime value={signOff.createdAt} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</ListFrame>
			)}
		</Page>
	);
}
