import { CheckIcon, CopyIcon, XIcon } from "lucide-react";
import type * as React from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
	Sheet,
	SheetDescription,
	SheetHeader,
	SheetPanel,
	SheetPopup,
	SheetTitle,
} from "@/components/ui/sheet";
import { cn, copyToClipboard } from "@/lib/utils";

export const DETAIL_PANE_SLOT_ID = "detail-pane-slot";

const DOCK_QUERY = "(min-width: 1280px)";

function useDocked() {
	const [docked, setDocked] = useState(false);
	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const query = window.matchMedia(DOCK_QUERY);
		const sync = () => setDocked(query.matches);
		sync();
		query.addEventListener("change", sync);
		return () => query.removeEventListener("change", sync);
	}, []);
	return docked;
}

export function DetailSheet({
	open,
	onClose,
	title,
	description,
	descriptionIsText = false,
	children,
}: {
	open: boolean;
	onClose: () => void;
	title: React.ReactNode;
	description?: React.ReactNode;
	descriptionIsText?: boolean;
	children: React.ReactNode;
}) {
	const docked = useDocked();
	const slot = docked ? document.getElementById(DETAIL_PANE_SLOT_ID) : null;
	if (slot) {
		return open
			? createPortal(
					<DetailPane
						description={description}
						descriptionIsText={descriptionIsText}
						onClose={onClose}
						title={title}
					>
						{children}
					</DetailPane>,
					slot,
				)
			: null;
	}
	return (
		<Sheet
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
			open={open}
		>
			<SheetPopup className="w-full max-w-none sm:max-w-xl" inset side="right">
				<SheetHeader className="border-b pe-14">
					<SheetTitle className="truncate text-base">{title}</SheetTitle>
					{description ? (
						<SheetDescription
							className={
								descriptionIsText ? "text-sm" : "truncate font-mono text-xs"
							}
						>
							{description}
						</SheetDescription>
					) : null}
				</SheetHeader>
				<SheetPanel className="space-y-5 pt-5">{children}</SheetPanel>
			</SheetPopup>
		</Sheet>
	);
}

function DetailPane({
	title,
	description,
	descriptionIsText,
	onClose,
	children,
}: {
	title: React.ReactNode;
	description?: React.ReactNode;
	descriptionIsText: boolean;
	onClose: () => void;
	children: React.ReactNode;
}) {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			const target = event.target as HTMLElement | null;
			if (
				target?.closest(
					"input, textarea, select, [contenteditable=true], [role=dialog], [role=menu], [role=listbox]",
				)
			)
				return;
			onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<aside
			aria-label={typeof title === "string" ? title : "Details"}
			className="flex min-h-0 w-[26rem] shrink-0 flex-col border-l bg-panel 2xl:w-[30rem]"
			data-slot="detail-pane"
		>
			<div className="flex h-11 shrink-0 items-center gap-2 border-b ps-4 pe-2">
				<div className="min-w-0 flex-1">
					<h2 className="truncate font-semibold text-[13px] leading-5">
						{title}
					</h2>
					{description ? (
						<p
							className={
								descriptionIsText
									? "truncate text-muted-foreground text-xs"
									: "truncate font-mono text-[11px] text-muted-foreground"
							}
						>
							{description}
						</p>
					) : null}
				</div>
				<Button
					aria-label="Close details"
					onClick={onClose}
					size="icon-sm"
					title="Close (Esc)"
					variant="ghost"
				>
					<XIcon />
				</Button>
			</div>
			<div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
				{children}
			</div>
		</aside>
	);
}

export function DetailField({
	label,
	children,
	className,
}: {
	label: string;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("space-y-1", className)}>
			<div className="font-medium text-muted-foreground text-xs">{label}</div>
			<div className="text-sm">{children}</div>
		</div>
	);
}

export function DetailCode({ children }: { children: React.ReactNode }) {
	return (
		<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/50 p-3 font-mono text-xs">
			{children}
		</pre>
	);
}

export function StatusDot({ className }: { className: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn("size-2 shrink-0 rounded-full", className)}
		/>
	);
}

export function IdValue({
	value,
	label,
	className,
}: {
	value: string;
	label?: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);
	return (
		<span
			className={cn(
				"group/id inline-flex max-w-full items-start gap-1 align-top",
				className,
			)}
		>
			<Kbd className="pointer-events-auto inline-block h-auto min-w-0 select-all whitespace-normal break-all px-1.5 py-0.5 text-left font-mono font-normal text-[11.5px] text-foreground/85 leading-[1.45]">
				{value}
			</Kbd>
			<button
				aria-label={copied ? "Copied" : `Copy ${label ?? "value"}`}
				className="mt-px flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-70 outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring sm:opacity-0 sm:group-hover/id:opacity-100"
				onClick={async () => {
					const { success } = await copyToClipboard(value);
					if (!success) return;
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1400);
				}}
				type="button"
			>
				{copied ? (
					<CheckIcon aria-hidden="true" className="size-3" />
				) : (
					<CopyIcon aria-hidden="true" className="size-3" />
				)}
			</button>
		</span>
	);
}

export function DetailSection({
	title,
	description,
	action,
	children,
	className,
}: {
	title: string;
	description?: React.ReactNode;
	action?: React.ReactNode;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<section
			aria-label={title}
			className={cn(
				"space-y-3 border-t pt-6 first:border-t-0 first:pt-0",
				className,
			)}
		>
			<div className="flex items-end justify-between gap-3">
				<div className="space-y-0.5">
					<h3 className="font-medium text-sm">{title}</h3>
					{description ? (
						<p className="text-muted-foreground text-xs">{description}</p>
					) : null}
				</div>
				{action}
			</div>
			{children}
		</section>
	);
}

export function DetailList({ children }: { children: React.ReactNode }) {
	return (
		<dl className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
			{children}
		</dl>
	);
}

export function DetailRow({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="grid gap-1 px-3.5 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
			<dt className="text-muted-foreground text-xs leading-6">{label}</dt>
			<dd className="min-w-0 text-sm leading-6">{children}</dd>
		</div>
	);
}
