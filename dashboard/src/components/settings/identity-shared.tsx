import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { toast } from "@/components/ui/toast";
import { PROVISIONABLE_ROLE_OPTIONS } from "@/hooks/api/use-identity";
import { copyToClipboard } from "@/lib/utils";

export function CopyValue({ label, value }: { label: string; value: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex flex-col gap-1">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			<div className="flex min-w-0 items-center gap-2">
				<code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
					{value}
				</code>
				<Button
					type="button"
					size="icon"
					variant="outline"
					aria-label={`Copy ${label}`}
					onClick={async () => {
						const result = await copyToClipboard(value);
						if (!result.success) {
							toast.error(result.error || "Copy failed");
							return;
						}
						setCopied(true);
						setTimeout(() => setCopied(false), 2000);
					}}
				>
					{copied ? (
						<Check className="h-4 w-4" />
					) : (
						<Copy className="h-4 w-4" />
					)}
				</Button>
			</div>
		</div>
	);
}

export function RoleSelect({
	id,
	value,
	onChange,
	disabled,
}: {
	id?: string;
	value: string;
	onChange: (role: string) => void;
	disabled?: boolean;
}) {
	return (
		<NativeSelect
			id={id}
			value={value}
			disabled={disabled}
			onChange={(event) => onChange(event.target.value)}
		>
			{PROVISIONABLE_ROLE_OPTIONS.map((option) => (
				<NativeSelectOption key={option.value} value={option.value}>
					{option.label}
				</NativeSelectOption>
			))}
		</NativeSelect>
	);
}

export function ConfirmAction({
	trigger,
	title,
	description,
	confirmLabel,
	pending,
	onConfirm,
}: {
	trigger: (open: () => void) => ReactNode;
	title: string;
	description: ReactNode;
	confirmLabel: string;
	pending?: boolean;
	onConfirm: () => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			{trigger(() => setOpen(true))}
			<AlertDialog open={open} onOpenChange={setOpen}>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle>{title}</AlertDialogTitle>
						<AlertDialogDescription>{description}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose render={<Button variant="ghost" />}>
							Cancel
						</AlertDialogClose>
						<AlertDialogClose
							render={<Button variant="destructive" loading={pending} />}
							onClick={onConfirm}
						>
							{confirmLabel}
						</AlertDialogClose>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</>
	);
}

export function EnterpriseOnly({ feature }: { feature: string }) {
	return (
		<p className="text-sm text-muted-foreground">
			{feature} is part of the Enterprise edition and is not available on this
			deployment.
		</p>
	);
}
