import { Trash2 } from "lucide-react";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useDeleteFunction } from "@/hooks/api/use-functions";

export function DeleteFunctionButton({
	name,
	workspaceId,
	onDeleted,
}: {
	name: string;
	workspaceId?: string;
	onDeleted: () => void;
}) {
	const remove = useDeleteFunction(workspaceId);
	return (
		<AlertDialog>
			<AlertDialogTrigger
				render={
					<Button
						aria-label={`Delete function ${name}`}
						disabled={!workspaceId || remove.isPending}
						size="icon-sm"
						title="Delete function"
						variant="ghost"
					>
						<Trash2 />
					</Button>
				}
			/>
			<AlertDialogPopup>
				<AlertDialogHeader>
					<AlertDialogTitle>
						Delete <span translate="no">{name}</span>?
					</AlertDialogTitle>
					<AlertDialogDescription>
						It leaves the list and nothing can run it again. Its versions and
						runs stay as the record of what it did, and the name is free to use
						again.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogClose
						render={<Button variant="outline">Cancel</Button>}
					/>
					<Button
						loading={remove.isPending}
						onClick={() => remove.mutate(name, { onSuccess: onDeleted })}
						variant="destructive"
					>
						Delete function
					</Button>
				</AlertDialogFooter>
			</AlertDialogPopup>
		</AlertDialog>
	);
}
