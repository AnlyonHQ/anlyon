import { cn } from "@/lib/utils";

export function FilterChips<T extends string>({
	label,
	options,
	value,
	onChange,
	className,
}: {
	label: string;
	options: readonly { value: T; label: string }[];
	value: T;
	onChange: (value: T) => void;
	className?: string;
}) {
	return (
		<fieldset className={cn("flex min-w-0 flex-wrap gap-1.5", className)}>
			<legend className="sr-only">{label}</legend>
			{options.map((option) => {
				const selected = option.value === value;
				return (
					<button
						aria-pressed={selected}
						className={cn(
							"inline-flex h-8 items-center rounded-full border px-3.5 font-medium text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
							selected
								? "border-transparent bg-foreground text-background"
								: "bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
						)}
						key={option.value}
						onClick={() => onChange(option.value)}
						type="button"
					>
						{option.label}
					</button>
				);
			})}
		</fieldset>
	);
}
