import { Copy, Eye, EyeOff } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export interface DisplayRegeneratedKeyDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	displayValue: string;
	showValue: boolean;
	onToggleShow: () => void;
	isCopied: boolean;
	onCopy: () => void;
	onClose: () => void;
	rollbackExpiresAt: string | null;
}

export function DisplayRegeneratedKeyDialog({
	open,
	onOpenChange,
	displayValue,
	showValue,
	onToggleShow,
	isCopied,
	onCopy,
	onClose,
	rollbackExpiresAt,
}: DisplayRegeneratedKeyDialogProps) {
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => (!o ? onClose() : onOpenChange(o))}
		>
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>API Key Regenerated</DialogTitle>
					<DialogDescription>
						Your new API key is ready. Make sure to copy it now!
					</DialogDescription>
				</DialogHeader>
				<DialogPanel>
					<Alert variant="warning" className="mb-4">
						<AlertTitle>Important</AlertTitle>
						<AlertDescription>
							Copy this key now! For security reasons, you won't be able to view
							it again.
							{rollbackExpiresAt ? (
								<p>
									You can roll back to the previous key until{" "}
									{new Date(rollbackExpiresAt).toLocaleString()}
								</p>
							) : null}
						</AlertDescription>
					</Alert>
					<Field>
						<FieldLabel>Your New API Key</FieldLabel>
						<div className="flex gap-2">
							<div className="relative w-full">
								<Input
									readOnly
									value={displayValue}
									className="w-full pr-10 font-mono text-sm"
								/>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
									onClick={onToggleShow}
								>
									{showValue ? (
										<EyeOff className="h-4 w-4 text-muted-foreground" />
									) : (
										<Eye className="h-4 w-4 text-muted-foreground" />
									)}
								</Button>
							</div>
							<Button size="icon" variant="outline" onClick={onCopy}>
								{isCopied ? (
									<span className="text-success text-xs font-medium">✓</span>
								) : (
									<Copy className="h-4 w-4" />
								)}
							</Button>
						</div>
						<p className="mt-2 text-xs text-muted-foreground">
							Use this key in the Authorization header:{" "}
							<code className="rounded bg-muted px-1">Bearer &lt;key&gt;</code>
						</p>
					</Field>
				</DialogPanel>
				<DialogFooter>
					<Button onClick={onClose}>I&apos;ve Saved My API Key</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
