import { Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { RelativeTime } from "@/components/ui/relative-time";
import type { McpToolChange, McpUpstream } from "@/hooks/api/use-mcp-upstreams";
import { checkSummary, RISK_LABEL, RISK_VARIANT } from "@/lib/mcp-servers";
import { ServerDescription } from "./server-description";
import { ServerText } from "./tool-row";

const KIND: Record<
	McpToolChange["kind"],
	{ label: string; variant: "warning" | "error" | "info"; line: string }
> = {
	changed: {
		label: "Changed",
		variant: "warning",
		line: "Calls are refused until someone reviews it and re-adopts it.",
	},
	removed: {
		label: "Removed",
		variant: "error",
		line: "The server no longer lists it, so calls are refused.",
	},
	added: {
		label: "New",
		variant: "info",
		line: "Not adopted, so no agent can reach it.",
	},
};

function Before({ change }: { change: McpToolChange }) {
	if (change.kind === "added") return null;
	if (!change.before) {
		return (
			<p className="text-muted-foreground text-xs">
				What it said when it was adopted was not kept.
			</p>
		);
	}
	const { description, inputSchema } = change.before as {
		description?: unknown;
		inputSchema?: unknown;
	};
	return (
		<details className="group min-w-0 text-xs">
			<summary className="cursor-pointer text-muted-foreground underline-offset-2 hover:underline">
				What it said when it was adopted
			</summary>
			<div className="mt-2 flex flex-col gap-2">
				<ServerDescription
					empty="The server gave no description."
					label="Its description then, from the server, not checked by Anlyon"
					text={typeof description === "string" ? description : ""}
				/>
				{inputSchema ? (
					<ServerText
						label="Its inputs then, from the server, not checked by Anlyon"
						text={JSON.stringify(inputSchema, null, 2)}
					/>
				) : null}
			</div>
		</details>
	);
}

export function ToolChanges({ server }: { server: McpUpstream }) {
	const changes = server.changes ?? [];
	if (changes.length === 0) return null;
	const blocked = changes.some((change) => change.kind !== "added");
	return (
		<section aria-label="What changed" className="rounded-lg border">
			<header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b bg-muted/50 px-3.5 py-2">
				<h3 className="font-medium text-[13px]">What changed on the server</h3>
				{blocked ? (
					<Link
						className="text-xs underline underline-offset-2"
						params={{ name: server.name }}
						search={{ filter: "review" }}
						to="/mcp-servers/$name"
					>
						Review and re-adopt
					</Link>
				) : null}
			</header>
			<ul>
				{changes.map((change) => (
					<li
						className="flex flex-col gap-1.5 border-b px-3.5 py-2.5 last:border-b-0"
						key={`${change.kind}:${change.tool}`}
					>
						<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
							<Badge variant={KIND[change.kind].variant}>
								{KIND[change.kind].label}
							</Badge>
							<code
								className="min-w-0 break-all font-medium font-mono text-[13px]"
								translate="no"
							>
								{change.tool}
							</code>
							{change.kind === "added" && change.suggestedClass ? (
								<Badge size="sm" variant={RISK_VARIANT[change.suggestedClass]}>
									{RISK_LABEL[change.suggestedClass]}
								</Badge>
							) : null}
							<span className="ms-auto text-muted-foreground text-xs">
								Found <RelativeTime value={change.detectedAt} />
							</span>
						</div>
						<p className="text-muted-foreground text-xs">
							{KIND[change.kind].line}
						</p>
						<Before change={change} />
					</li>
				))}
			</ul>
		</section>
	);
}

export function CheckLine({ server }: { server: McpUpstream }) {
	const summary = checkSummary(server);
	if (!summary) return null;
	return (
		<p
			className="text-pretty text-[13px] text-muted-foreground leading-relaxed"
			data-check={summary.kind}
		>
			{summary.lead}
			{summary.at ? (
				<>
					{" "}
					<RelativeTime value={summary.at} />
				</>
			) : null}
			{summary.tail ? `. ${summary.tail}` : "."}
		</p>
	);
}
