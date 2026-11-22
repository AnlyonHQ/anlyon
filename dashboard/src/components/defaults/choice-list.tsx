import type { ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

export interface Choice<T extends string> {
	value: T;
	label: string;
	consequence: ReactNode;
	note?: ReactNode;
	recommended?: boolean;
}

export type ChoiceListVariant = "bordered" | "flush";

const listClass: Record<ChoiceListVariant, string> = {
	bordered: "overflow-hidden rounded-lg border divide-y divide-border/70",
	flush: "divide-y divide-border/70 border-t border-border/70",
};

const rowClass = (variant: ChoiceListVariant) =>
	cn(
		"group/choice relative flex min-h-11 items-start gap-3 py-3 outline-none",
		"transition-colors duration-150 ease-out",
		variant === "bordered" ? "px-3.5" : "px-5",
	);

const interactiveRow =
	"cursor-pointer hover:bg-muted/40 has-data-checked:bg-muted/55 has-focus-visible:bg-muted/50 has-data-disabled:cursor-default has-data-disabled:hover:bg-transparent has-data-disabled:has-data-checked:bg-muted/40 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-foreground before:opacity-0 before:transition-opacity before:duration-150 has-data-checked:before:opacity-100";

export function RecommendedMark({
	children = "Recommended",
}: {
	children?: ReactNode;
}) {
	return (
		<span className="inline-flex h-[18px] shrink-0 items-center rounded-[4px] bg-brand/10 px-1.5 font-medium text-[11px] text-brand leading-none">
			{children}
		</span>
	);
}

function RowText({
	label,
	consequence,
	note,
	mark,
}: {
	label: ReactNode;
	consequence: ReactNode;
	note?: ReactNode;
	mark?: ReactNode;
}) {
	return (
		<span className="flex min-w-0 flex-1 flex-col gap-0.5">
			<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span className="text-[13.5px] text-foreground leading-5 group-has-data-checked/choice:font-medium">
					{label}
				</span>
				{mark}
			</span>
			<span className="text-pretty text-[12.5px] text-muted-foreground leading-[1.15rem]">
				{consequence}
			</span>
			{note ? (
				<span className="mt-1 text-pretty text-[12.5px] text-muted-foreground leading-[1.15rem]">
					{note}
				</span>
			) : null}
		</span>
	);
}

export function ChoiceList<T extends string>({
	labelledBy,
	value,
	onChange,
	choices,
	disabled = false,
	variant = "bordered",
	className,
}: {
	labelledBy: string;
	value: T;
	onChange: (value: T) => void;
	choices: readonly Choice<T>[];
	disabled?: boolean;
	variant?: ChoiceListVariant;
	className?: string;
}) {
	return (
		<RadioGroup
			aria-labelledby={labelledBy}
			className={cn("gap-0", listClass[variant], className)}
			disabled={disabled}
			onValueChange={(next) => onChange(next as T)}
			value={value}
		>
			{choices.map((choice) => (
				// biome-ignore lint/a11y/noLabelWithoutControl: the Radio inside is the control.
				<label
					className={cn(rowClass(variant), interactiveRow)}
					data-choice={choice.value}
					key={choice.value}
				>
					<Radio className="mt-0.5" value={choice.value} />
					<RowText
						consequence={choice.consequence}
						label={choice.label}
						mark={choice.recommended ? <RecommendedMark /> : null}
						note={choice.note}
					/>
				</label>
			))}
		</RadioGroup>
	);
}

export function ToggleRow({
	label,
	consequence,
	checked,
	onChange,
	disabled = false,
	variant = "bordered",
	mark,
	trailing,
}: {
	label: string;
	consequence: ReactNode;
	checked: boolean;
	onChange: (checked: boolean) => void;
	disabled?: boolean;
	variant?: ChoiceListVariant;
	mark?: ReactNode;
	trailing?: ReactNode;
}) {
	return (
		<div
			className={cn(
				rowClass(variant),
				!disabled && interactiveRow,
				"items-center",
			)}
		>
			{/* biome-ignore lint/a11y/noLabelWithoutControl: the Checkbox inside is the control. */}
			<label
				className={cn(
					"flex min-w-0 flex-1 items-start gap-3",
					!disabled && "cursor-pointer",
				)}
			>
				<Checkbox
					checked={checked}
					className="mt-0.5"
					disabled={disabled}
					onCheckedChange={(next) => onChange(next === true)}
				/>
				<RowText consequence={consequence} label={label} mark={mark} />
			</label>
			{trailing ? <span className="shrink-0">{trailing}</span> : null}
		</div>
	);
}

export function FixedRow({
	icon,
	label,
	consequence,
	variant = "bordered",
}: {
	icon: ReactNode;
	label: ReactNode;
	consequence: ReactNode;
	variant?: ChoiceListVariant;
}) {
	return (
		<div className={cn(rowClass(variant))}>
			<span
				aria-hidden="true"
				className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4"
			>
				{icon}
			</span>
			<RowText consequence={consequence} label={label} />
		</div>
	);
}
