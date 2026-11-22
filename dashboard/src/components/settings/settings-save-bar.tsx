import { type ReactNode, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";

export function SettingsSaveBar({
	dirty,
	message,
	saving,
	disabled = false,
	onSave,
	onDiscard,
	saveLabel = "Save changes",
}: {
	dirty: boolean;
	message: ReactNode;
	saving: boolean;
	disabled?: boolean;
	onSave: () => void;
	onDiscard: () => void;
	saveLabel?: string;
}) {
	useEffect(() => {
		if (!dirty) return;
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
				event.preventDefault();
				onSave();
			}
		};
		const onLeave = (event: BeforeUnloadEvent) => {
			event.preventDefault();
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("beforeunload", onLeave);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("beforeunload", onLeave);
		};
	}, [dirty, onSave]);

	if (!dirty) return null;
	const isMac =
		typeof navigator !== "undefined" &&
		/Mac|iPhone|iPad/.test(navigator.platform);
	return (
		<div className="pointer-events-none sticky bottom-4 z-10 flex justify-center">
			<section
				aria-label="Unsaved changes"
				className="onboarding-rise pointer-events-auto flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border bg-popover/95 py-2 pr-2 pl-4 text-popover-foreground shadow-lg backdrop-blur supports-[backdrop-filter]:bg-popover/85"
			>
				<p
					aria-live="polite"
					className="flex min-w-0 items-center gap-2.5 text-[13px]"
				>
					<span
						aria-hidden="true"
						className="size-1.5 shrink-0 rounded-full bg-amber-500"
					/>
					<span className="min-w-0">{message}</span>
				</p>
				<div className="flex items-center gap-2">
					<Button onClick={onDiscard} size="sm" variant="ghost">
						Discard
					</Button>
					<Button
						aria-keyshortcuts={isMac ? "Meta+S" : "Control+S"}
						disabled={disabled}
						loading={saving}
						onClick={onSave}
						size="sm"
					>
						{saveLabel}
						<Kbd className="hidden sm:inline-flex">
							{isMac ? "⌘S" : "Ctrl S"}
						</Kbd>
					</Button>
				</div>
			</section>
		</div>
	);
}
