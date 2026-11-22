import { Check, X } from "lucide-react";
import { useState } from "react";
import { AGENT_CLIENTS } from "@/components/icons/agent-clients";
import { toast } from "@/components/ui/toast";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn, copyToClipboard } from "@/lib/utils";

const PROMPT =
	"Fetch and execute the appropriate instructions to set me up for Anlyon from https://docs.anlyon.com/agents/prompt.md";

const DISMISS_KEY = "anlyon.banner.dismissed.onboard-agent-pill";

function isDismissed(): boolean {
	try {
		return localStorage.getItem(DISMISS_KEY) === "1";
	} catch {
		return false;
	}
}

export function OnboardAgentPill({ className }: { className?: string }) {
	const [dismissed, setDismissed] = useState(isDismissed);
	const [copied, setCopied] = useState(false);

	if (dismissed) return null;

	const handleCopy = async () => {
		const result = await copyToClipboard(PROMPT);
		if (result.success) {
			setCopied(true);
			toast.success("Prompt copied. Paste it into your coding agent.");
			setTimeout(() => setCopied(false), 2000);
		} else {
			toast.error(result.error || "Couldn't copy. Select the prompt manually.");
		}
	};

	const handleDismiss = () => {
		try {
			localStorage.setItem(DISMISS_KEY, "1");
		} catch {
		}
		setDismissed(true);
	};

	return (
		<div className={cn("flex items-center gap-1", className)}>
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								onClick={handleCopy}
								aria-label="Copy the prompt to onboard your coding agent to Anlyon"
								className="inline-flex touch-manipulation items-center gap-2.5 rounded-full border bg-background px-3.5 py-1.5 font-medium text-sm shadow-xs outline-none transition-[background-color,border-color,transform] duration-150 ease-out hover:border-foreground/15 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.98]"
							>
								<span className="inline-flex items-center gap-1.5 whitespace-nowrap">
									{copied ? (
										<>
											<Check className="size-3.5" aria-hidden="true" />
											Prompt copied
										</>
									) : (
										"Onboard your agent to Anlyon"
									)}
								</span>
								<span
									aria-hidden="true"
									className="hidden h-4 w-px bg-border sm:block"
								/>
								<span className="hidden items-center gap-1.5 text-muted-foreground sm:inline-flex">
									{AGENT_CLIENTS.map(({ name, Icon }) => (
										<Icon key={name} className="size-4" />
									))}
								</span>
							</button>
						}
					/>
					<TooltipContent className="max-w-xs">{PROMPT}</TooltipContent>
				</Tooltip>
			</TooltipProvider>
			<button
				type="button"
				aria-label="Dismiss"
				onClick={handleDismiss}
				className="shrink-0 rounded-full p-1.5 text-muted-foreground outline-none transition-colors duration-150 ease-out hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			>
				<X className="size-3.5" aria-hidden="true" />
			</button>
		</div>
	);
}
