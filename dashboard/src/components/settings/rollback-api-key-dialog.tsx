import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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

export interface RollbackApiKeyDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	apiKeyName: string;
	onConfirm: () => void;
	isPending: boolean;
	onClose: () => void;
}

export function RollbackApiKeyDialog({
	open,
	onOpenChange,
	apiKeyName,
	onConfirm,
	isPending,
	onClose,
}: RollbackApiKeyDialogProps) {
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) onClose();
				onOpenChange(o);
			}}
		>
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>Rollback API Key?</DialogTitle>
					<DialogDescription>
						This will restore the previous version of &quot;{apiKeyName}&quot;
						and invalidate the current key.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel>
					<Alert variant="warning">
						<AlertTitle>Warning</AlertTitle>
						<AlertDescription>
							The current API key will be immediately invalidated. Update your
							application with the restored key.
						</AlertDescription>
					</Alert>
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
						{isPending ? "Rolling back..." : "Rollback Key"}
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
