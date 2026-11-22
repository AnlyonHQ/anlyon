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

export interface DisplayApiKeyDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	displayValue: string;
	showValue: boolean;
	onToggleShow: () => void;
	isCopied: boolean;
	onCopy: () => void;
	onClose: () => void;
}

export function DisplayApiKeyDialog({
	open,
	onOpenChange,
	displayValue,
	showValue,
	onToggleShow,
	isCopied,
	onCopy,
	onClose,
}: DisplayApiKeyDialogProps) {
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => (!o ? onClose() : onOpenChange(o))}
		>
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>API Key Created</DialogTitle>
					<DialogDescription>
						Make sure to copy your API key now. You won't be able to see it
						again!
					</DialogDescription>
				</DialogHeader>
				<DialogPanel>
					<Alert variant="warning" className="mb-4">
						<AlertTitle>Important</AlertTitle>
						<AlertDescription>
							Copy this key now. For security reasons, you won't be able to view
							it again.
						</AlertDescription>
					</Alert>
					<Field>
						<FieldLabel>Your API Key</FieldLabel>
						<div className="flex gap-2">
							<div className="relative flex-1">
								<Input
									readOnly
									value={displayValue}
									className="pr-10 font-mono text-sm"
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
					<Button onClick={onClose}>I've Saved My API Key</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
