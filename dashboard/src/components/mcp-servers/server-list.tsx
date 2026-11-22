import { Link, useNavigate } from "@tanstack/react-router";
import { ListFrame } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { RelativeTime } from "@/components/ui/relative-time";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { McpUpstream } from "@/hooks/api/use-mcp-upstreams";
import {
	checkWarning,
	hostOf,
	lastCheckedCell,
	type StatusTone,
	serverStatus,
	signInLabel,
} from "@/lib/mcp-servers";

export const TONE_VARIANT: Record<
	StatusTone,
	"secondary" | "info" | "success" | "warning" | "error"
> = {
	neutral: "secondary",
	info: "info",
	success: "success",
	warning: "warning",
	error: "error",
};

export function ServerTable({ servers }: { servers: readonly McpUpstream[] }) {
	const navigate = useNavigate();
	return (
		<ListFrame
			footer={
				<span className="tabular-nums">
					{servers.length} {servers.length === 1 ? "server" : "servers"}
				</span>
			}
		>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Server</TableHead>
						<TableHead className="w-36">Status</TableHead>
						<TableHead className="hidden w-32 sm:table-cell">
							Tools adopted
						</TableHead>
						<TableHead className="hidden w-36 md:table-cell">Sign-in</TableHead>
						<TableHead className="hidden w-32 lg:table-cell">
							Last checked
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{servers.map((server) => {
						const status = serverStatus(server);
						const checked = lastCheckedCell(server);
						const warning = checkWarning(server);
						const added =
							server.changes?.filter((c) => c.kind === "added").length ?? 0;
						return (
							<TableRow
								className="cursor-pointer"
								key={server.id}
								onClick={() =>
									navigate({
										to: "/mcp-servers/$name",
										params: { name: server.name },
									})
								}
							>
								<TableCell className="max-w-0 py-2.5">
									<Link
										className="block truncate rounded-sm font-medium font-mono text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
										onClick={(event) => event.stopPropagation()}
										params={{ name: server.name }}
										to="/mcp-servers/$name"
										translate="no"
									>
										{server.name}
									</Link>
									<span
										className="block truncate text-muted-foreground text-xs"
										translate="no"
									>
										{hostOf(server.url)}
									</span>
									{warning ? (
										<span className="block truncate text-warning-foreground text-xs">
											{warning}
										</span>
									) : null}
								</TableCell>
								<TableCell className="py-2.5">
									<Badge variant={TONE_VARIANT[status.tone]}>
										{status.label}
									</Badge>
								</TableCell>
								<TableCell className="hidden py-2.5 tabular-nums sm:table-cell">
									{server.listedAt ? (
										`${server.adopted.length} of ${server.tools.length}`
									) : (
										<span className="text-muted-foreground">Not listed</span>
									)}
								</TableCell>
								<TableCell className="hidden py-2.5 md:table-cell">
									{signInLabel(server)}
								</TableCell>
								<TableCell className="hidden py-2.5 text-muted-foreground lg:table-cell">
									{checked.prefix ? `${checked.prefix} ` : null}
									{checked.at ? (
										<RelativeTime value={checked.at} />
									) : (
										checked.text
									)}
									{added > 0 ? (
										<span className="block text-xs">
											{added} new {added === 1 ? "tool" : "tools"}
										</span>
									) : null}
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</ListFrame>
	);
}
