import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function useCopy(value: string) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
		}
	};
	return { copied, copy };
}

export function CopyValue({
	value,
	label,
	className,
}: {
	value: string;
	label: string;
	className?: string;
}) {
	const { copied, copy } = useCopy(value);
	return (
		<div
			className={cn(
				"flex min-w-0 items-center gap-2 rounded-md border bg-muted/40 py-1 ps-2.5 pe-1",
				className,
			)}
		>
			<code
				className="min-w-0 flex-1 break-all font-mono text-xs"
				translate="no"
			>
				{value}
			</code>
			<Button
				aria-label={`Copy ${label}`}
				onClick={copy}
				size="xs"
				variant="ghost"
			>
				{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
				{copied ? "Copied" : "Copy"}
			</Button>
		</div>
	);
}

export function CopyInline({ value, label }: { value: string; label: string }) {
	const { copied, copy } = useCopy(value);
	return (
		<span className="flex items-start gap-1">
			<code
				className="min-w-0 flex-1 break-all font-mono text-[12px] leading-5"
				translate="no"
			>
				{value}
			</code>
			<Button
				aria-label={`Copy ${label}`}
				className="-mt-0.5"
				onClick={copy}
				size="icon-xs"
				title={`Copy ${label}`}
				variant="ghost"
			>
				{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
			</Button>
		</span>
	);
}
