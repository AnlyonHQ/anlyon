"use client";

import { createFileRoute, Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { EnvironmentSelect } from "@/components/effects/environment-select";
import { ListEmpty, ListLoading } from "@/components/governance/list-empty";
import {
	ListFrame,
	Page,
	PageHeader,
	PageToolbar,
} from "@/components/layout/page";
import { LearnMore } from "@/components/settings/settings-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useWorkspace } from "@/contexts/workspace-context";
import { useEndUsers } from "@/hooks/api/use-end-users";
import { isEndUserId } from "@/lib/end-users";
import { requireFeature } from "@/lib/feature-flags";

type UsersSearch = {
	environmentId?: string;
	cursor?: string;
	q?: string;
};

export const Route = createFileRoute("/_protected/users/")({
	beforeLoad: () => requireFeature("connected-accounts"),
	validateSearch: (search: Record<string, unknown>): UsersSearch => ({
		environmentId:
			typeof search.environmentId === "string"
				? search.environmentId
				: undefined,
		cursor: typeof search.cursor === "string" ? search.cursor : undefined,
		q: typeof search.q === "string" && search.q ? search.q : undefined,
	}),
	component: UsersRoute,
});

function UsersRoute() {
	const navigate = Route.useNavigate();
	const { environmentId, cursor, q } = Route.useSearch();
	return (
		<UsersPage
			cursor={cursor}
			environmentId={environmentId}
			onNavigate={(next) => navigate({ to: "/users", search: next })}
			query={q}
		/>
	);
}

const count = (value: number) => value.toLocaleString();

export function UsersPage({
	environmentId,
	cursor,
	query: searched,
	onNavigate,
}: {
	environmentId: string | undefined;
	cursor: string | undefined;
	query: string | undefined;
	onNavigate: (search: UsersSearch) => void;
}) {
	const searchId = useId();
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const query = useEndUsers(workspaceId, environmentId, cursor, searched);
	const rows = query.data?.data ?? [];
	const nextCursor = query.data?.pagination?.nextCursor ?? null;
	const [lookup, setLookup] = useState(searched ?? "");
	const [lookupError, setLookupError] = useState<string | null>(null);

	const find = (event: FormEvent) => {
		event.preventDefault();
		const id = lookup.trim();
		if (id && !isEndUserId(id)) {
			setLookupError(
				"An id is 1 to 128 letters, digits and . _ : @ - characters.",
			);
			return;
		}
		setLookupError(null);
		onNavigate({ environmentId, q: id || undefined });
	};

	return (
		<Page>
			<PageHeader
				actions={
					<EnvironmentSelect
						onChange={(next) =>
							onNavigate({ environmentId: next, q: searched })
						}
						value={environmentId}
						workspaceId={workspaceId}
					/>
				}
				description={
					<>
						People who use your product, and the accounts your agent acts in for
						them. Your server names each one with your own id, sent in the{" "}
						<code
							className="whitespace-nowrap font-mono text-xs"
							translate="no"
						>
							Anlyon-End-User
						</code>{" "}
						header (
						<code className="font-mono text-xs" translate="no">
							endUserId
						</code>{" "}
						in the API).{" "}
						<LearnMore href="https://docs.anlyon.com/guides/act-for-your-users" />
					</>
				}
				title="Users"
			/>

			<PageToolbar>
				<form
					className="flex w-full flex-wrap items-center gap-2"
					noValidate
					onSubmit={find}
				>
					<Label className="sr-only" htmlFor={searchId}>
						Search users by id
					</Label>
					<div className="relative min-w-0 flex-1 basis-56 sm:max-w-sm">
						<Search
							aria-hidden="true"
							className="pointer-events-none absolute start-3 top-1/2 z-[1] size-4 -translate-y-1/2 text-muted-foreground"
						/>
						<Input
							aria-describedby={lookupError ? `${searchId}-error` : undefined}
							aria-invalid={lookupError ? true : undefined}
							autoComplete="off"
							className="w-full font-mono [&_input]:ps-9"
							id={searchId}
							onChange={(event) => {
								setLookup(event.target.value);
								setLookupError(null);
							}}
							placeholder="Search by id, such as user_42"
							spellCheck={false}
							translate="no"
							type="search"
							value={lookup}
						/>
					</div>
					<Button type="submit" variant="outline">
						Search
					</Button>
					{lookupError ? (
						<p
							className="w-full text-destructive text-xs"
							id={`${searchId}-error`}
							role="alert"
						>
							{lookupError}
						</p>
					) : null}
				</form>
			</PageToolbar>

			{query.isError ? (
				<ListFrame padded>
					<p className="text-destructive text-sm" role="alert">
						Users could not be loaded: {(query.error as Error).message}
					</p>
				</ListFrame>
			) : query.isLoading ? (
				<ListFrame>
					<ListLoading rows={4} />
				</ListFrame>
			) : rows.length === 0 && !cursor && searched ? (
				<ListFrame>
					<ListEmpty
						action={
							<Button
								onClick={() => {
									setLookup("");
									onNavigate({ environmentId });
								}}
								size="sm"
								variant="outline"
							>
								Clear search
							</Button>
						}
						role="status"
						title={<>No user id starts with “{searched}”.</>}
					/>
				</ListFrame>
			) : rows.length === 0 && !cursor ? (
				<ListFrame>
					<ListEmpty
						action={
							<Button
								render={
									<Link
										search={{ environmentId }}
										to="/integrations/settings"
									/>
								}
								size="sm"
							>
								Set up Connect settings
							</Button>
						}
						description="A user appears here once they connect an account through a connect link, or once your server makes a call for them with the Anlyon-End-User header."
						title="No users yet"
					/>
				</ListFrame>
			) : (
				<ListFrame
					footer={
						<>
							<span className="tabular-nums">
								{rows.length} {rows.length === 1 ? "user" : "users"} on this
								page
							</span>
							<nav aria-label="User pages" className="flex gap-2">
								{cursor ? (
									<Button
										onClick={() => onNavigate({ environmentId, q: searched })}
										size="xs"
										variant="outline"
									>
										Back to the start
									</Button>
								) : null}
								{nextCursor ? (
									<Button
										disabled={query.isFetching}
										onClick={() =>
											onNavigate({
												environmentId,
												q: searched,
												cursor: nextCursor,
											})
										}
										size="xs"
										variant="outline"
									>
										Next page
									</Button>
								) : null}
							</nav>
						</>
					}
				>
					{rows.length === 0 ? (
						<ListEmpty title="No more users." />
					) : (
						<Table aria-busy={query.isFetching}>
							<TableHeader>
								<TableRow>
									<TableHead>User</TableHead>
									<TableHead className="w-28 text-right">Connections</TableHead>
									<TableHead className="hidden w-28 text-right sm:table-cell">
										Invocations
									</TableHead>
									<TableHead className="hidden w-40 text-right sm:table-cell">
										Pending approvals
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((endUser) => (
									<TableRow
										className="group/row relative"
										key={endUser.endUserId}
									>
										<TableCell className="max-w-0 py-3">
											<Link
												className="block truncate rounded-sm font-medium font-mono text-sm outline-none after:absolute after:inset-0 focus-visible:ring-2 focus-visible:ring-ring group-hover/row:underline group-hover/row:underline-offset-2"
												params={{ endUserId: endUser.endUserId }}
												search={{ environmentId }}
												to="/users/$endUserId"
												translate="no"
											>
												{endUser.endUserId}
											</Link>
										</TableCell>
										<TableCell className="py-3 text-right tabular-nums">
											{count(endUser.connections)}
										</TableCell>
										<TableCell className="hidden py-3 text-right text-muted-foreground tabular-nums sm:table-cell">
											{count(endUser.invocations)}
										</TableCell>
										<TableCell className="hidden py-3 text-right tabular-nums sm:table-cell">
											{endUser.pendingApprovals > 0 ? (
												<Link
													aria-label={`${count(endUser.pendingApprovals)} pending for ${endUser.endUserId}`}
													className="relative z-[1] inline-flex items-center gap-1.5 rounded-sm font-medium outline-none hover:underline hover:underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring"
													hash="approvals"
													params={{ endUserId: endUser.endUserId }}
													search={{ environmentId }}
													to="/users/$endUserId"
												>
													<span
														aria-hidden="true"
														className="size-1.5 rounded-full bg-warning"
													/>
													{count(endUser.pendingApprovals)}
												</Link>
											) : (
												<span className="text-muted-foreground">0</span>
											)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</ListFrame>
			)}
		</Page>
	);
}
