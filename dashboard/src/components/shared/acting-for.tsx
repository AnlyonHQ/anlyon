import { Link } from "@tanstack/react-router";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";

export type ActingForFilter = "workspace" | "end_users";

export function parseActingFor(value: unknown): ActingForFilter | undefined {
	return value === "workspace" || value === "end_users" ? value : undefined;
}

const ERASED_PREFIX = "erased~";

export function ActingFor({
	endUserId,
	environmentId,
	className,
	link = true,
}: {
	endUserId: string | null | undefined;
	environmentId?: string;
	className?: string;
	link?: boolean;
}) {
	if (!endUserId) {
		return (
			<span
				className={cn("text-muted-foreground text-xs", className)}
				data-slot="acting-for"
				title="Your workspace's own accounts"
			>
				Workspace
			</span>
		);
	}
	if (endUserId.startsWith(ERASED_PREFIX)) {
		return (
			<span
				className={cn("text-muted-foreground text-xs", className)}
				data-slot="acting-for"
				title="This user was erased. The id is kept as a one-way hash."
			>
				Erased user
			</span>
		);
	}
	if (!link) {
		return (
			<span
				className={cn(
					"block max-w-full truncate font-mono text-muted-foreground text-xs",
					className,
				)}
				data-slot="acting-for"
				title={`User ${endUserId}`}
				translate="no"
			>
				{endUserId}
			</span>
		);
	}
	return (
		<Link
			className={cn(
				"relative z-[1] block max-w-full truncate rounded-sm font-mono text-muted-foreground text-xs outline-none hover:text-foreground hover:underline hover:underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring",
				className,
			)}
			data-slot="acting-for"
			onClick={(event) => event.stopPropagation()}
			params={{ endUserId }}
			search={{ environmentId }}
			title={`User ${endUserId}`}
			to="/users/$endUserId"
			translate="no"
		>
			{endUserId}
		</Link>
	);
}

const OPTIONS = [
	{ value: "all", label: "All" },
	{ value: "workspace", label: "Your workspace" },
	{ value: "end_users", label: "Your users" },
] as const;

export function ActingForSwitch({
	value,
	onChange,
}: {
	value: ActingForFilter | undefined;
	onChange: (next: ActingForFilter | undefined) => void;
}) {
	return (
		<SegmentedControl
			label="Whose accounts"
			onChange={(next) => onChange(next === "all" ? undefined : next)}
			options={OPTIONS}
			value={value ?? "all"}
		/>
	);
}
