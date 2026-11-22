"use client";

import { isFeatureEnabled } from "@anlyon/feature-flags";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { ApprovalInbox } from "@/components/approvals/approval-inbox";
import { UserDecidedApprovals } from "@/components/approvals/user-decided-list";
import { ApprovalsDefaultsHint } from "@/components/defaults/defaults-hint";
import { EndUserFilter } from "@/components/end-users/end-user-filter";
import {
	Page,
	PageHeader,
	PageTabsView,
	PageToolbar,
} from "@/components/layout/page";
import {
	type ActingForFilter,
	ActingForSwitch,
	parseActingFor,
} from "@/components/shared/acting-for";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/contexts/workspace-context";
import { useApprovalDetail, useApprovals } from "@/hooks/api/use-approvals";
import { requireFeature } from "@/lib/feature-flags";

export type ApprovalsSearch = {
	id?: string;
	endUser?: string;
	tab?: "users";
	actingFor?: ActingForFilter;
};

export const Route = createFileRoute("/_protected/approvals")({
	beforeLoad: () => requireFeature("approvals"),
	validateSearch: (search: Record<string, unknown>): ApprovalsSearch => ({
		id: typeof search.id === "string" ? search.id : undefined,
		endUser:
			typeof search.endUser === "string" && search.endUser
				? search.endUser
				: undefined,
		tab: search.tab === "users" ? "users" : undefined,
		actingFor: parseActingFor(search.actingFor),
	}),
	component: ApprovalsRoute,
});

function ApprovalsRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<ApprovalsPage
			onSearch={(patch, replace) =>
				navigate({
					to: "/approvals",
					search: (previous) => ({ ...previous, ...patch }),
					replace,
				})
			}
			search={search}
		/>
	);
}

export function ApprovalsPage({
	search,
	onSearch,
}: {
	search: ApprovalsSearch;
	onSearch: (patch: Partial<ApprovalsSearch>, replace?: boolean) => void;
}) {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const { id, endUser, tab, actingFor } = search;
	const onUsers = tab === "users";

	const recent = useApprovals(workspaceId, { limit: 25, endUserId: endUser });
	const teamWaiting = useApprovals(workspaceId, {
		status: "pending",
		limit: 1,
		endUserId: endUser,
	}).data?.pagination?.total;
	const usersWaiting = useApprovals(workspaceId, {
		status: "pending",
		decider: "end_user",
		limit: 1,
		endUserId: endUser,
	}).data?.pagination?.total;

	const linked = useApprovalDetail(workspaceId, onUsers ? undefined : id).data;
	useEffect(() => {
		if (linked?.decider === "end_user") onSearch({ tab: "users" }, true);
	}, [linked?.decider, onSearch]);

	const tabSearch = (next: ApprovalsSearch["tab"]): ApprovalsSearch => ({
		endUser,
		tab: next,
		...(next ? {} : { actingFor }),
	});

	return (
		<Page className="min-h-[34rem] grow basis-0 gap-5">
			<PageHeader
				actions={
					isFeatureEnabled("approval-policies") ? (
						<Button
							render={<Link search={{}} to="/approval-policies" />}
							size="sm"
							variant="outline"
						>
							Policies
						</Button>
					) : undefined
				}
				description="Calls your policies hold for a decision. Your agent waits on each one until it is decided or expires."
				title="Approvals"
			/>
			{onUsers ? null : (
				<ApprovalsDefaultsHint
					approvals={recent.data?.data ?? []}
					workspaceId={workspaceId}
				/>
			)}
			<div className="flex flex-col gap-3">
				<PageTabsView
					isActive={(item) =>
						(item.search as ApprovalsSearch).tab ===
						(onUsers ? "users" : undefined)
					}
					items={[
						{
							label: "For your team",
							to: "/approvals",
							search: tabSearch(undefined),
							count: teamWaiting || undefined,
						},
						{
							label: "Waiting on your users",
							to: "/approvals",
							search: tabSearch("users"),
							count: usersWaiting || undefined,
						},
					]}
					label="Who decides"
				/>
				<PageToolbar>
					{onUsers ? null : (
						<ActingForSwitch
							onChange={(next) => onSearch({ actingFor: next, id: undefined })}
							value={actingFor}
						/>
					)}
					<EndUserFilter
						onChange={(next) => onSearch({ endUser: next, id: undefined })}
						value={endUser}
					/>
				</PageToolbar>
				{onUsers ? (
					<p className="text-muted-foreground text-sm">
						Your users decide these in your app. This list is read-only.
					</p>
				) : null}
			</div>
			{onUsers ? (
				<UserDecidedApprovals
					endUserId={endUser}
					highlightId={id}
					workspaceId={workspaceId}
				/>
			) : (
				<ApprovalInbox
					actingFor={actingFor}
					deepLinkId={id}
					endUserId={endUser}
					workspaceId={workspaceId}
				/>
			)}
		</Page>
	);
}
