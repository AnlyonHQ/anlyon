import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { McpAdoptChoice } from "@/hooks/api/use-mcp-upstreams";
import {
	LOOSE_CHECK_TEXT,
	looselyChecked,
	RISK_LABEL,
	type ToolRow as Row,
	suggestsApproval,
	type ToolState,
	toolInputs,
} from "@/lib/mcp-servers";
import { cn } from "@/lib/utils";
import {
	ServerDescription,
	summaryOf,
	ToolInputList,
} from "./server-description";

const STATE_BADGE: Partial<
	Record<
		ToolState,
		{ label: string; variant: "success" | "warning" | "error" | "outline" }
	>
> = {
	live: { label: "Live", variant: "success" },
	disabled: { label: "Disabled", variant: "outline" },
	changed: { label: "Changed", variant: "warning" },
	missing: { label: "No longer listed", variant: "error" },
};

export function ServerText({ label, text }: { label: string; text: string }) {
	return (
		<div>
			<p className="mb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
				{label}
			</p>
			<pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words border-warning/50 border-l-2 bg-muted/50 py-1.5 ps-2.5 pe-2 font-mono text-[12px] leading-5">
				{text}
			</pre>
		</div>
	);
}

function Heading({ children }: { children: React.ReactNode }) {
	return (
		<p className="mb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
			{children}
		</p>
	);
}

export function ToolRow({
	row,
	choice,
	canManage,
	onToggle,
	onChoice,
}: {
	row: Row;
	choice: McpAdoptChoice | undefined;
	canManage: boolean;
	onToggle: (row: Row, on: boolean) => void;
	onChoice: (name: string, choice: McpAdoptChoice) => void;
}) {
	const id = useId();
	const [open, setOpen] = useState(row.state === "changed");
	const selectable =
		canManage && (row.state === "available" || row.state === "changed");
	const selected = choice !== undefined;
	const badge = STATE_BADGE[row.state];
	const description = row.tool?.definition.description ?? "";
	const inputs = toolInputs(row.tool?.definition.inputSchema);
	const suggested = suggestsApproval(row.risk);
	const loose = looselyChecked(row);

	return (
		<li
			className={cn("border-b last:border-b-0", selected && "bg-accent/40")}
			data-state={row.state}
		>
			<div className="flex items-start gap-3 px-3.5 py-2.5">
				<span className="flex size-4 shrink-0 items-center pt-0.5">
					{selectable ? (
						<Checkbox
							aria-label={
								row.state === "changed"
									? `Re-adopt ${row.name}`
									: `Adopt ${row.name}`
							}
							checked={selected}
							onCheckedChange={(on) => onToggle(row, on === true)}
						/>
					) : null}
				</span>
				<button
					aria-controls={`${id}-detail`}
					aria-expanded={open}
					className="group flex min-w-0 flex-1 cursor-pointer items-start gap-1.5 rounded-sm text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onClick={() => setOpen(!open)}
					type="button"
				>
					<ChevronRight
						aria-hidden="true"
						className={cn(
							"mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
							open && "rotate-90",
						)}
					/>
					<span className="min-w-0 flex-1">
						<span
							className="block truncate font-medium font-mono text-[13px]"
							translate="no"
						>
							{row.name}
						</span>
						{description ? (
							<span className="block truncate text-muted-foreground text-xs">
								{summaryOf(description)}
							</span>
						) : null}
					</span>
				</button>
				{loose ? (
					<Badge
						className="shrink-0"
						title={LOOSE_CHECK_TEXT}
						variant="outline"
					>
						Loosely checked
					</Badge>
				) : null}
				{badge ? (
					<Badge className="shrink-0" variant={badge.variant}>
						{badge.label}
					</Badge>
				) : null}
			</div>

			{selected && row.state === "available" ? (
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 pe-3.5 ps-[3.25rem] pb-2.5">
					<Checkbox
						checked={!!choice.requiresApproval}
						id={`${id}-approval`}
						onCheckedChange={(on) =>
							onChoice(row.name, { ...choice, requiresApproval: on === true })
						}
					/>
					<Label className="font-normal text-xs" htmlFor={`${id}-approval`}>
						Require approval on every call
					</Label>
					{suggested && row.risk ? (
						<span className="text-muted-foreground text-xs">
							Suggested for {RISK_LABEL[row.risk].toLowerCase()} tools. Untick
							it if you disagree.
						</span>
					) : loose ? (
						<span className="text-muted-foreground text-xs">
							Suggested for loosely checked tools. Untick it if you disagree.
						</span>
					) : null}
				</div>
			) : null}
			{selected && row.state === "changed" ? (
				<p className="pe-3.5 ps-[3.25rem] pb-2.5 text-muted-foreground text-xs">
					Re-adopting moves its action to this definition. Its approval setting
					stays as it is.
				</p>
			) : null}

			{open ? (
				<div
					className="flex flex-col gap-3 pe-3.5 ps-[3.25rem] pb-3.5"
					id={`${id}-detail`}
				>
					{row.state === "changed" ? (
						<p className="text-[13px] text-warning-foreground">
							The server changed this tool after you adopted it, so Anlyon
							refuses calls to it. Read what it says now, then re-adopt it if
							you still trust it.
						</p>
					) : null}
					{row.state === "missing" ? (
						<p className="text-[13px] text-muted-foreground">
							The server no longer lists this tool, so Anlyon refuses calls to
							it. If it comes back unchanged, it works again. If it is gone for
							good, delete its action.
						</p>
					) : null}
					{loose ? (
						<div>
							<Heading>Loosely checked</Heading>
							<p className="text-muted-foreground text-xs">
								{LOOSE_CHECK_TEXT}
							</p>
						</div>
					) : null}
					{row.tool ? (
						<>
							<ServerDescription
								label="What the server says, not checked by Anlyon"
								text={description}
							/>
							{inputs.length > 0 ? (
								<ToolInputList inputs={inputs} label="What it takes" />
							) : null}
							{row.tool.reasons.length > 0 ? (
								<div>
									<Heading>Why Anlyon rated it this way</Heading>
									<ul className="list-disc space-y-0.5 ps-4 text-muted-foreground text-xs">
										{row.tool.reasons.map((reason) => (
											<li key={reason}>{reason}</li>
										))}
									</ul>
								</div>
							) : null}
							<p className="text-muted-foreground text-xs">
								Pinned to definition{" "}
								<code
									className="font-mono text-[11.5px]"
									title={row.tool.hash}
									translate="no"
								>
									{row.tool.hash.replace(/^(sha256:)?(.{12}).*$/, "$1$2…")}
								</code>
								. If the server changes it, calls are refused until someone
								re-adopts it.
							</p>
						</>
					) : null}
					{row.state === "changed" && canManage ? (
						<Button
							className="self-start"
							onClick={() => onToggle(row, !selected)}
							size="sm"
							variant="outline"
						>
							{selected ? "Keep refusing it" : "Re-adopt this tool"}
						</Button>
					) : null}
					{selected && row.state === "available" ? (
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-description`}>
								What your agent reads about this tool
							</Label>
							<Textarea
								className="min-h-16 text-xs"
								id={`${id}-description`}
								maxLength={1000}
								onChange={(event) =>
									onChoice(row.name, {
										...choice,
										description: event.target.value,
									})
								}
								value={choice.description ?? description.slice(0, 1000)}
							/>
							<p className="text-muted-foreground text-xs">
								This starts as the server's own text. Change anything you would
								not want an agent to read as an instruction.
							</p>
						</div>
					) : null}
					{row.adopted ? (
						<p className="text-xs">
							<Link
								className="underline underline-offset-2"
								search={{ action: row.adopted.actionId }}
								to="/actions"
							>
								Open its action
							</Link>{" "}
							<code className="font-mono text-muted-foreground" translate="no">
								{row.adopted.action}
							</code>
						</p>
					) : null}
				</div>
			) : null}
		</li>
	);
}
