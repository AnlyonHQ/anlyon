import { Search } from "lucide-react";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

export function ListSearch({
	label,
	value,
	onChange,
	placeholder,
	id,
	className,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	id?: string;
	className?: string;
}) {
	return (
		<InputGroup className={cn("w-full sm:w-72", className)}>
			<InputGroupAddon>
				<Search aria-hidden="true" />
			</InputGroupAddon>
			<InputGroupInput
				aria-label={label}
				autoComplete="off"
				id={id}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder ?? `${label}…`}
				spellCheck={false}
				type="search"
				value={value}
			/>
		</InputGroup>
	);
}
