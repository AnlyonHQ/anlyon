import { X } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isEndUserId } from "@/lib/end-users";
import { cn } from "@/lib/utils";

export function EndUserFilter({
	value,
	onChange,
	className,
}: {
	value: string | undefined;
	onChange: (endUserId: string | undefined) => void;
	className?: string;
}) {
	const id = useId();
	const [draft, setDraft] = useState(value ?? "");
	const [problem, setProblem] = useState<string | null>(null);
	useEffect(() => setDraft(value ?? ""), [value]);

	const apply = (event: FormEvent) => {
		event.preventDefault();
		const next = draft.trim();
		if (!next) {
			setProblem(null);
			onChange(undefined);
			return;
		}
		if (!isEndUserId(next)) {
			setProblem("Not a user id.");
			return;
		}
		setProblem(null);
		onChange(next);
	};

	return (
		<form
			className={cn("flex min-w-0 items-center gap-1.5", className)}
			noValidate
			onSubmit={apply}
		>
			<Label className="sr-only" htmlFor={id}>
				User
			</Label>
			<Input
				aria-describedby={problem ? `${id}-problem` : undefined}
				aria-invalid={problem ? true : undefined}
				autoComplete="off"
				className="w-48 font-mono"
				id={id}
				onChange={(event) => {
					setDraft(event.target.value);
					setProblem(null);
				}}
				placeholder="User id"
				size="sm"
				spellCheck={false}
				translate="no"
				value={draft}
			/>
			{value ? (
				<Button
					aria-label={`Clear the user filter (${value})`}
					onClick={() => {
						setDraft("");
						onChange(undefined);
					}}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<X aria-hidden="true" className="size-4" />
				</Button>
			) : null}
			{problem ? (
				<span
					className="text-destructive text-xs"
					id={`${id}-problem`}
					role="alert"
				>
					{problem}
				</span>
			) : null}
		</form>
	);
}
