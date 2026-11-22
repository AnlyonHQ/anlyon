import { formatExact, formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

export function RelativeTime({
	value,
	className,
}: {
	value: string | number | Date;
	className?: string;
}) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<time
						className={cn("tabular-nums", className)}
						dateTime={date.toISOString()}
					/>
				}
			>
				{formatRelative(date)}
			</TooltipTrigger>
			<TooltipContent>{formatExact(date)}</TooltipContent>
		</Tooltip>
	);
}
