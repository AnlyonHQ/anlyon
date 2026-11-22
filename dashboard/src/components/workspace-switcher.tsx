import { ChevronsUpDown, GalleryVerticalEnd } from "lucide-react";
import * as React from "react";

import {
	Command,
	CommandCollection,
	CommandDialog,
	CommandDialogPopup,
	CommandDialogTrigger,
	CommandEmpty,
	CommandGroup,
	CommandGroupLabel,
	CommandInput,
	CommandItem,
	CommandList,
	CommandPanel,
} from "@/components/ui/command";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useWorkspace } from "@/contexts/workspace-context";
import { planName } from "@/lib/plans";
import { cn } from "@/lib/utils";
import { RAIL_ITEM } from "./shell/rail";
import { Badge } from "./ui/badge";

interface WorkspaceItem {
	value: string;
	label: string;
}

interface WorkspaceGroup {
	value: string;
	items: WorkspaceItem[];
}

function WorkspaceTile({
	name,
	className,
}: {
	name?: string;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary font-semibold text-[13px] text-primary-foreground shadow-xs",
				className,
			)}
		>
			{name?.trim().charAt(0).toUpperCase() || "W"}
		</span>
	);
}

export function WorkspaceSwitcher({
	variant = "row",
}: {
	variant?: "rail" | "row";
}) {
	const [open, setOpen] = React.useState(false);
	const { currentWorkspace, workspaces, switchWorkspace } = useWorkspace();

	if (!currentWorkspace) {
		return null;
	}

	const groupedItems: WorkspaceGroup[] = [
		{
			value: "Workspaces",
			items: workspaces.map((workspace) => ({
				value: workspace.id,
				label: workspace.name,
			})),
		},
	];

	function handleItemClick(item: WorkspaceItem) {
		switchWorkspace(item.value);
		setOpen(false);
	}

	const label = `Switch workspace (${currentWorkspace.name})`;

	return (
		<CommandDialog onOpenChange={setOpen} open={open}>
			{variant === "rail" ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<CommandDialogTrigger
								aria-label={label}
								className={cn(RAIL_ITEM, "cursor-pointer")}
							/>
						}
					>
						<WorkspaceTile
							className="size-7 rounded-md text-xs"
							name={currentWorkspace.name}
						/>
					</TooltipTrigger>
					<TooltipContent side="right">{currentWorkspace.name}</TooltipContent>
				</Tooltip>
			) : (
				<CommandDialogTrigger
					aria-label={label}
					className="flex h-10 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left outline-none transition-colors duration-150 ease-out hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
				>
					<WorkspaceTile className="size-7" name={currentWorkspace.name} />
					<span className="min-w-0 flex-1 truncate font-semibold text-sm">
						{currentWorkspace.name}
					</span>
					{currentWorkspace.plan && currentWorkspace.plan !== "free" ? (
						<Badge className="shrink-0" size="sm" variant="outline">
							{planName(currentWorkspace.plan)}
						</Badge>
					) : null}
					<ChevronsUpDown className="size-4 shrink-0 text-sidebar-muted-foreground" />
				</CommandDialogTrigger>
			)}
			<CommandDialogPopup>
				<Command items={groupedItems}>
					<CommandInput placeholder="Search workspaces" />
					<CommandPanel>
						<CommandEmpty>No workspaces found.</CommandEmpty>
						<CommandList>
							{(group: WorkspaceGroup) => (
								<CommandGroup items={group.items} key={group.value}>
									<CommandGroupLabel>{group.value}</CommandGroupLabel>
									<CommandCollection>
										{(item: WorkspaceItem) => (
											<CommandItem
												key={item.value}
												onClick={() => handleItemClick(item)}
												value={item.value}
											>
												<div className="flex size-6 items-center justify-center rounded-md border">
													<GalleryVerticalEnd className="size-3.5 shrink-0" />
												</div>
												<span className="flex-1">{item.label}</span>
												{item.value === currentWorkspace.id ? (
													<span className="text-muted-foreground text-xs">
														Current
													</span>
												) : null}
											</CommandItem>
										)}
									</CommandCollection>
								</CommandGroup>
							)}
						</CommandList>
					</CommandPanel>
				</Command>
			</CommandDialogPopup>
		</CommandDialog>
	);
}
