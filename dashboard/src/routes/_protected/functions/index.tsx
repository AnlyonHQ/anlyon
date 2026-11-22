"use client";

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { SquareFunction } from "lucide-react";
import { CreateFunctionDialog } from "@/components/functions/create-function-dialog";
import { OpenRunById } from "@/components/functions/runs-panel";
import { ListFrame, Page, PageHeader } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { RelativeTime } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useWorkspace } from "@/contexts/workspace-context";
import { useFunctions } from "@/hooks/api/use-functions";
import { useCan } from "@/hooks/api/use-permissions";
import { FUNCTION_LANGUAGES } from "@/lib/functions";

export const Route = createFileRoute("/_protected/functions/")({
	component: FunctionsPage,
});

export function FunctionsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const navigate = useNavigate();
	const query = useFunctions(workspaceId);
	const functions = query.data ?? [];
	const canManage = useCan(workspaceId)("actions.manage");
	const isEmpty = !query.isLoading && !query.isError && functions.length === 0;
	const open = (name: string) =>
		navigate({ to: "/functions/$name", params: { name } });

	return (
		<Page>
			<PageHeader
				actions={
					<>
						<OpenRunById />
						{canManage && !isEmpty ? (
							<CreateFunctionDialog
								onCreated={(created) => open(created.name)}
								workspaceId={workspaceId}
							/>
						) : null}
					</>
				}
				description="Your own code that calls your actions, run with the network off. Reads go through as it runs; its writes become a plan someone approves before it is applied."
				title="Functions"
			/>
			{query.isError ? (
				<p className="text-destructive text-sm" role="alert">
					Functions could not be loaded: {(query.error as Error).message}
				</p>
			) : query.isLoading ? (
				<ListFrame padded>
					<div aria-busy="true" className="space-y-2">
						{[0, 1, 2].map((i) => (
							<Skeleton className="h-10 w-full rounded-lg" key={i} />
						))}
					</div>
				</ListFrame>
			) : functions.length === 0 ? (
				<ListFrame>
					<Empty className="py-16">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<SquareFunction />
							</EmptyMedia>
							<EmptyTitle>No functions yet</EmptyTitle>
							<EmptyDescription>
								Create a function, then write its source in the editor and
								publish it with the actions it may call.
							</EmptyDescription>
						</EmptyHeader>
						{canManage ? (
							<EmptyContent>
								<CreateFunctionDialog
									onCreated={(created) => open(created.name)}
									workspaceId={workspaceId}
								/>
							</EmptyContent>
						) : null}
					</Empty>
				</ListFrame>
			) : (
				<ListFrame
					footer={
						<span className="tabular-nums">
							{functions.length}{" "}
							{functions.length === 1 ? "function" : "functions"}
						</span>
					}
				>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead className="hidden md:table-cell">
									Description
								</TableHead>
								<TableHead className="w-28">Version</TableHead>
								<TableHead className="hidden w-28 sm:table-cell">
									Language
								</TableHead>
								<TableHead className="hidden w-32 lg:table-cell">
									Updated
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{functions.map((fn) => (
								<TableRow
									className="cursor-pointer"
									key={fn.id}
									onClick={() => open(fn.name)}
								>
									<TableCell className="max-w-0 py-3">
										<Link
											className="block truncate rounded-sm font-medium font-mono text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
											onClick={(event) => event.stopPropagation()}
											params={{ name: fn.name }}
											to="/functions/$name"
										>
											{fn.name}
										</Link>
									</TableCell>
									<TableCell className="hidden max-w-0 truncate py-3 text-muted-foreground md:table-cell">
										{fn.description ?? ""}
									</TableCell>
									<TableCell className="py-3">
										{fn.currentVersion ? (
											<Badge className="tabular-nums" variant="outline">
												v{fn.currentVersion.version}
											</Badge>
										) : (
											<span className="text-muted-foreground text-xs">
												Not published
											</span>
										)}
									</TableCell>
									<TableCell className="hidden py-3 sm:table-cell">
										{fn.currentVersion
											? FUNCTION_LANGUAGES.find(
													(language) =>
														language.value === fn.currentVersion?.language,
												)?.label
											: ""}
									</TableCell>
									<TableCell className="hidden py-3 text-muted-foreground lg:table-cell">
										<RelativeTime value={fn.updatedAt} />
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
