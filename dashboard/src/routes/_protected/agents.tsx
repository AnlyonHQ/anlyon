"use client";

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { StatusDot } from "@/components/actions/detail-sheet";
import { EmptyRow } from "@/components/actions/empty-row";
import { ListFrame, Page, PageHeader } from "@/components/layout/page";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
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
import {
	useAgents,
	useCreateAgent,
	usePromoteAgent,
} from "@/hooks/api/use-agents";
import { useEnvironments } from "@/hooks/api/use-environments";
import { useCan } from "@/hooks/api/use-permissions";
import { requireFeature } from "@/lib/feature-flags";
import type { Agent } from "@/lib/types";

export const Route = createFileRoute("/_protected/agents")({
	beforeLoad: () => requireFeature("agents"),
	component: AgentsPage,
});

function CreateAgentDialog({ workspaceId }: { workspaceId?: string }) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [environmentId, setEnvironmentId] = useState("");
	const envQuery = useEnvironments(workspaceId);
	const environments = envQuery.data ?? [];
	const create = useCreateAgent(workspaceId);

	return (
		<Dialog>
			<DialogTrigger render={<Button size="sm">New agent</Button>} />
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>Create agent</DialogTitle>
					<DialogDescription>
						Name an agent you run, so its setup is versioned and its runs are
						grouped. It starts at version 1, and each edit makes a new version.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel className="space-y-4 py-2">
					<div className="space-y-1.5">
						<Label htmlFor="agent-name">Name</Label>
						<Input
							id="agent-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="support-triage"
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="agent-desc">Description</Label>
						<Input
							id="agent-desc"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="Triages inbound support tickets"
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="agent-env">Environment</Label>
						<NativeSelect
							id="agent-env"
							value={environmentId}
							onChange={(e) => setEnvironmentId(e.target.value)}
						>
							<NativeSelectOption value="">
								Select an environment…
							</NativeSelectOption>
							{environments.map((env) => (
								<NativeSelectOption key={env.id} value={env.id}>
									{env.name}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
				</DialogPanel>
				<DialogFooter>
					<DialogClose render={<Button variant="outline">Cancel</Button>} />
					<DialogClose
						render={
							<Button
								disabled={!name || !environmentId || create.isPending}
								onClick={() =>
									create.mutate({
										name,
										description: description || undefined,
										environmentId,
									})
								}
							>
								Create
							</Button>
						}
					/>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}

function PromoteAgentDialog({
	agent,
	workspaceId,
}: {
	agent: Agent;
	workspaceId?: string;
}) {
	const [targetId, setTargetId] = useState("");
	const [confirmed, setConfirmed] = useState(false);
	const envQuery = useEnvironments(workspaceId);
	const environments = envQuery.data ?? [];
	const targets = environments.filter((env) => env.id !== agent.environmentId);
	const target = targets.find((env) => env.id === targetId);
	const promote = usePromoteAgent(workspaceId);
	const needsConfirm = !!target?.isProtected;
	const current = environments.find((env) => env.id === agent.environmentId);
	const hasNoTargets = !envQuery.isLoading && targets.length === 0;

	return (
		<Dialog>
			<DialogTrigger
				render={
					<Button
						size="sm"
						variant="outline"
						disabled={agent.currentVersion === null}
					>
						Promote
					</Button>
				}
			/>
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>Promote “{agent.name}”</DialogTitle>
					<DialogDescription>
						Copies the published v{agent.currentVersion} config into the target
						environment as a new immutable version and publishes it. Every prior
						version is kept, so rolling back repoints the agent at an earlier
						version. It does not undo an action already dispatched. Secret
						values are never copied.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel className="space-y-4 py-2">
					{hasNoTargets ? (
						<p className="text-sm text-muted-foreground">
							There is no other environment to promote into.{" "}
							<span className="font-medium text-foreground">{agent.name}</span>{" "}
							already runs in{" "}
							{current ? `“${current.name}”` : "this workspace's environment"},
							and promoting copies a version between two environments. Create a
							second environment to promote between them.
						</p>
					) : (
						<div className="space-y-1.5">
							<Label htmlFor={`promote-env-${agent.id}`}>
								Target environment
							</Label>
							<NativeSelect
								id={`promote-env-${agent.id}`}
								value={targetId}
								onChange={(e) => {
									setTargetId(e.target.value);
									setConfirmed(false);
								}}
							>
								<NativeSelectOption value="">
									Select an environment…
								</NativeSelectOption>
								{targets.map((env) => (
									<NativeSelectOption key={env.id} value={env.id}>
										{env.name}
										{env.isProtected ? " (protected)" : ""}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</div>
					)}
					{needsConfirm && (
						<div className="flex items-start gap-2">
							<Checkbox
								id={`promote-confirm-${agent.id}`}
								checked={confirmed}
								onCheckedChange={(checked) => setConfirmed(checked === true)}
								aria-describedby={`promote-confirm-hint-${agent.id}`}
							/>
							<div className="space-y-0.5">
								<Label htmlFor={`promote-confirm-${agent.id}`}>
									Promote into protected “{target?.name}”
								</Label>
								<p
									id={`promote-confirm-hint-${agent.id}`}
									className="text-sm text-muted-foreground"
								>
									This environment is protected: the change publishes
									immediately to it.
								</p>
							</div>
						</div>
					)}
				</DialogPanel>
				<DialogFooter>
					<DialogClose
						render={
							<Button variant="outline">
								{hasNoTargets ? "Close" : "Cancel"}
							</Button>
						}
					/>
					{!hasNoTargets && (
						<DialogClose
							render={
								<Button
									disabled={
										!targetId ||
										(needsConfirm && !confirmed) ||
										promote.isPending
									}
									onClick={() =>
										promote.mutate({
											agentId: agent.id,
											targetEnvironmentId: targetId,
											confirmProtected: needsConfirm ? true : undefined,
										})
									}
								>
									Promote
								</Button>
							}
						/>
					)}
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}

export function AgentsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const query = useAgents(workspaceId);
	const agents = query.data ?? [];
	const environments = useEnvironments(workspaceId).data ?? [];
	const canManage = useCan(workspaceId)("agents.manage");
	const isEmpty = !query.isLoading && agents.length === 0;
	const environmentName = (id: string) =>
		environments.find((env) => env.id === id)?.name;

	return (
		<Page>
			<PageHeader
				actions={
					canManage && !isEmpty ? (
						<CreateAgentDialog workspaceId={workspaceId} />
					) : undefined
				}
				description="Each agent's configuration, such as the actions it uses. A change is a new version you can promote or roll back."
				title="Agents"
			/>
			{query.isLoading ? (
				<ListFrame aria-busy="true" className="space-y-2" padded>
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-9 w-full rounded-lg" />
					))}
				</ListFrame>
			) : agents.length === 0 ? (
				<ListFrame padded>
					<EmptyRow
						action={
							canManage ? (
								<CreateAgentDialog workspaceId={workspaceId} />
							) : undefined
						}
						title="No agents yet"
					>
						Create one to version its setup, such as the actions it uses. Its
						runs then report against it.
					</EmptyRow>
				</ListFrame>
			) : (
				<ListFrame
					footer={
						<span className="tabular-nums">
							{agents.length} {agents.length === 1 ? "agent" : "agents"}
						</span>
					}
				>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead className="hidden w-40 md:table-cell">
									Environment
								</TableHead>
								<TableHead className="w-24">Version</TableHead>
								<TableHead className="hidden w-28 sm:table-cell">
									Status
								</TableHead>
								<TableHead className="w-28 text-right">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{agents.map((agent) => (
								<TableRow key={agent.id}>
									<TableCell className="max-w-0 py-2.5">
										<span
											className="block truncate font-medium font-mono text-[13px]"
											translate="no"
										>
											{agent.name}
										</span>
										{agent.description ? (
											<span className="mt-0.5 block truncate text-muted-foreground text-xs">
												{agent.description}
											</span>
										) : null}
									</TableCell>
									<TableCell className="hidden max-w-0 truncate py-2.5 text-muted-foreground md:table-cell">
										{environmentName(agent.environmentId) ?? "—"}
									</TableCell>
									<TableCell className="py-2.5">
										{agent.currentVersion !== null ? (
											<Badge
												className="font-mono tabular-nums"
												variant="outline"
											>
												v{agent.currentVersion}
											</Badge>
										) : (
											<span className="text-muted-foreground">—</span>
										)}
									</TableCell>
									<TableCell className="hidden py-2.5 sm:table-cell">
										<span className="inline-flex items-center gap-2">
											<StatusDot
												className={
													agent.archived
														? "bg-muted-foreground/60"
														: "bg-success"
												}
											/>
											{agent.archived ? "Archived" : "Active"}
										</span>
									</TableCell>
									<TableCell className="py-2 text-right">
										{canManage && (
											<PromoteAgentDialog
												agent={agent}
												workspaceId={workspaceId}
											/>
										)}
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
