import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import { useState } from "react";
import { PlanAction } from "@/components/extension-slots";
import {
	SettingsPage,
	SettingsRow,
	SettingsSection,
} from "@/components/settings/settings-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { toast } from "@/components/ui/toast";
import { useWorkspace } from "@/contexts/workspace-context";
import { useCan } from "@/hooks/api/use-permissions";
import {
	useDeleteWorkspace,
	useUpdateWorkspace,
} from "@/hooks/api/use-workspaces";
import { copyToClipboard } from "@/lib/utils";

export const Route = createFileRoute("/_protected/settings/general")({
	component: GeneralSettingsPage,
});

function CopyableValue({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
			<span className="text-sm text-muted-foreground">{label}</span>
			<button
				type="button"
				className="group/copy inline-flex max-w-[60%] items-center gap-2 rounded-lg border bg-muted/50 px-2.5 py-1 font-mono text-xs transition-[background-color,border-color,transform] duration-150 ease-out hover:border-foreground/15 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
				onClick={async () => {
					const result = await copyToClipboard(value);
					if (result.success) toast.success(`${label} copied`);
					else toast.error(result.error || "Copy failed");
				}}
				title={`Copy ${label}`}
			>
				<span className="truncate">{value}</span>
				<Copy
					aria-hidden="true"
					className="size-3 shrink-0 text-muted-foreground transition-colors duration-150 group-hover/copy:text-foreground"
				/>
			</button>
		</div>
	);
}

function DeleteWorkspaceDialog({
	name,
	onConfirm,
	isPending,
}: {
	name: string;
	onConfirm: () => void;
	isPending: boolean;
}) {
	const [typed, setTyped] = useState("");
	return (
		<Dialog>
			<DialogTrigger
				render={<Button variant="destructive">Delete workspace</Button>}
			/>
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>Delete “{name}”?</DialogTitle>
					<DialogDescription>
						This permanently deletes the workspace and every resource in it
						environments, keys, actions, runs, approvals, everything. This
						cannot be undone.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel className="space-y-1.5 py-2">
					<Label htmlFor="delete-confirm">
						Type <span className="font-mono font-medium">{name}</span> to
						confirm
					</Label>
					<Input
						id="delete-confirm"
						value={typed}
						onChange={(e) => setTyped(e.target.value)}
						placeholder={name}
						autoComplete="off"
					/>
				</DialogPanel>
				<DialogFooter>
					<DialogClose render={<Button variant="outline">Cancel</Button>} />
					<Button
						variant="destructive"
						disabled={typed !== name || isPending}
						onClick={onConfirm}
					>
						{isPending ? "Deleting…" : "I understand, delete it"}
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}

function GeneralSettingsPage() {
	const navigate = useNavigate();
	const { currentWorkspace } = useWorkspace();
	const update = useUpdateWorkspace();
	const deleteWorkspace = useDeleteWorkspace();
	const [name, setName] = useState(currentWorkspace?.name ?? "");
	const can = useCan(currentWorkspace?.id);
	const canRename = can("workspace.update");
	const canDelete = can("workspace.delete");

	if (!currentWorkspace) return null;
	const dirty = name.trim() !== currentWorkspace.name && name.trim().length > 0;

	return (
		<SettingsPage
			title="General"
			description="Your workspace's name and details, and where to delete it."
		>
			<SettingsSection
				title="Workspace name"
				description="Shown across the dashboard and in invitations."
				footer={
					<Button
						size="sm"
						disabled={!canRename || !dirty || update.isPending}
						onClick={() =>
							update.mutate({
								workspaceId: currentWorkspace.id,
								data: { name: name.trim() },
							})
						}
					>
						{update.isPending ? "Saving…" : "Save"}
					</Button>
				}
			>
				<Input
					value={name}
					onChange={(e) => setName(e.target.value)}
					className="max-w-sm"
					aria-label="Workspace name"
					readOnly={!canRename}
					maxLength={100}
				/>
			</SettingsSection>

			<SettingsSection
				title="Workspace details"
				description="Identifiers you'll need when talking to the API or to support. Click to copy."
			>
				<div className="divide-y divide-border/70">
					<CopyableValue label="Workspace ID" value={currentWorkspace.id} />
					<CopyableValue label="Slug" value={currentWorkspace.slug} />
					<div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
						<span className="text-sm text-muted-foreground">Plan</span>
						<span className="flex items-center gap-2">
							<Badge variant="outline" className="capitalize">
								{currentWorkspace.plan}
							</Badge>
							<PlanAction site="workspace-plan" />
						</span>
					</div>
				</div>
			</SettingsSection>

			<SettingsSection variant="danger" title="Danger zone">
				<SettingsRow
					label="Delete this workspace"
					description="Destroys all of its data across every environment. There is no recovery."
				>
					{canDelete ? (
						<DeleteWorkspaceDialog
							name={currentWorkspace.name}
							isPending={deleteWorkspace.isPending}
							onConfirm={async () => {
								await deleteWorkspace.mutateAsync(currentWorkspace.id);
								navigate({ to: "/workspaces/select" });
							}}
						/>
					) : (
						<span className="text-muted-foreground text-xs">
							Requires the admin role.
						</span>
					)}
				</SettingsRow>
			</SettingsSection>
		</SettingsPage>
	);
}
