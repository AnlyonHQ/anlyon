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
} from "@/components/ui/dialog";

export interface DeleteIntegrationDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	integrationName: string;
	onConfirm: () => void;
	isPending: boolean;
}

export function DeleteIntegrationDialog({
	open,
	onOpenChange,
	integrationName,
	onConfirm,
	isPending,
}: DeleteIntegrationDialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>Delete Integration</DialogTitle>
					<DialogDescription>
						Are you sure you want to delete &quot;{integrationName}&quot;? This
						action cannot be undone.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel>
					<p className="text-sm text-muted-foreground">
						You will stop receiving notifications through this integration
						immediately.
					</p>
				</DialogPanel>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>
						Cancel
					</DialogClose>
					<Button
						variant="destructive"
						onClick={onConfirm}
						disabled={isPending}
					>
						{isPending ? "Deleting..." : "Delete Integration"}
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
