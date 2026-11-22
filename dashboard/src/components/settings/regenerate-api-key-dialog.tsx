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

export interface RegenerateApiKeyDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	apiKeyName: string;
	onConfirm: () => void;
	isPending: boolean;
	onClose: () => void;
}

export function RegenerateApiKeyDialog({
	open,
	onOpenChange,
	apiKeyName,
	onConfirm,
	isPending,
	onClose,
}: RegenerateApiKeyDialogProps) {
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
					<DialogTitle>Regenerate API Key</DialogTitle>
					<DialogDescription>
						This will create a new API key for &quot;{apiKeyName}&quot; while
						preserving the previous key for rollback.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel>
					<Alert variant="info" className="mb-4">
						<AlertTitle>Rollback Available</AlertTitle>
						<AlertDescription>
							After regenerating, you can roll back to the previous key within
							the rollback window if needed.
						</AlertDescription>
					</Alert>
					<p className="text-sm text-muted-foreground">
						Make sure to update your application with the new key immediately
						after regenerating.
					</p>
				</DialogPanel>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>
						Cancel
					</DialogClose>
					<Button onClick={onConfirm} disabled={isPending}>
						{isPending ? "Regenerating..." : "Regenerate Key"}
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
