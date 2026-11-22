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

export interface RegenerateSecretDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
	isPending: boolean;
}

export function RegenerateSecretDialog({
	open,
	onOpenChange,
	onConfirm,
	isPending,
}: RegenerateSecretDialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>Regenerate Signing Secret?</DialogTitle>
					<DialogDescription>
						This creates a new signing secret. For 5 minutes, each delivery
						carries a signature from the new secret and one from the old secret.
						After that, only the new secret signs.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel>
					<p className="text-sm text-muted-foreground">
						Make sure to update your application with the new secret immediately
						after regenerating.
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
						{isPending ? "Regenerating..." : "Regenerate Secret"}
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
