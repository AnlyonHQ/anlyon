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

export interface DisplaySecretDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	displayValue: string;
	showValue: boolean;
	onToggleShow: () => void;
	isCopied: boolean;
	onCopy: () => void;
	onClose: () => void;
}

const VERIFY_EXAMPLE = `import { Receiver } from '@anlyonhq/sdk';

const receiver = new Receiver({
  signingSecret: process.env.ANLYON_SIGNING_SECRET,
});

const valid = receiver.verify({
  signature: req.headers['anlyon-signature'],
  body: rawBody, // the raw request body, as a string
});`;

export function DisplaySecretDialog({
	open,
	onOpenChange,
	displayValue,
	showValue,
	onToggleShow,
	isCopied,
	onCopy,
	onClose,
}: DisplaySecretDialogProps) {
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => (!o ? onClose() : onOpenChange(o))}
		>
			<DialogPopup className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Webhook Signing Secret</DialogTitle>
					<DialogDescription>
						Copy your signing secret now. You won't be able to see it again!
					</DialogDescription>
				</DialogHeader>
				<DialogPanel>
					<div className="flex flex-col gap-4">
						<Alert variant="warning">
							<AlertTitle>Important</AlertTitle>
							<AlertDescription>
								Copy this secret now. For security reasons, you won't be able to
								view it again.
							</AlertDescription>
						</Alert>
						<Field>
							<FieldLabel>Your Signing Secret</FieldLabel>
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
								Store this secret in your environment variables. You'll use it
								to verify webhook signatures.
							</p>
						</Field>
						<div className="rounded-lg bg-muted p-3">
							<div className="mb-2 text-xs font-medium">
								Verify with the SDK Receiver (Node.js):
							</div>
							<pre className="overflow-x-auto text-xs text-muted-foreground">
								{VERIFY_EXAMPLE}
							</pre>
						</div>
					</div>
				</DialogPanel>
				<DialogFooter>
					<Button onClick={onClose}>I've Saved My Signing Secret</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
