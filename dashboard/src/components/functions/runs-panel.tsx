import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useState } from "react";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

export function OpenRunById({ className }: { className?: string }) {
	const [runId, setRunId] = useState("");
	const navigate = useNavigate();
	return (
		<form
			className={cn("w-full sm:w-64", className)}
			onSubmit={(event) => {
				event.preventDefault();
				const trimmed = runId.trim();
				if (!trimmed) return;
				navigate({ to: "/functions/runs/$runId", params: { runId: trimmed } });
			}}
		>
			<InputGroup>
				<InputGroupAddon>
					<Search aria-hidden="true" />
				</InputGroupAddon>
				<InputGroupInput
					aria-label="Open a run by id"
					autoCapitalize="none"
					className="font-mono"
					enterKeyHint="go"
					onChange={(e) => setRunId(e.target.value)}
					placeholder="Go to run frn_…"
					spellCheck={false}
					value={runId}
				/>
			</InputGroup>
		</form>
	);
}
