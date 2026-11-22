import type { Tone } from "@/lib/instance-onboarding";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<Tone, string> = {
	ok: "bg-success",
	warn: "bg-warning",
	idle: "bg-muted-foreground/40",
};

export function StatusDot({
	tone,
	pending = false,
	className,
}: {
	tone: Tone;
	pending?: boolean;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-block size-1.5 shrink-0 rounded-full transition-colors duration-300",
				TONE_CLASS[tone],
				pending &&
					"motion-safe:animate-[status-breathe_1.6s_ease-in-out_infinite]",
				className,
			)}
			data-tone={tone}
		/>
	);
}
