import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { ListEmpty } from "@/components/governance/list-empty";
import { CodeSample } from "@/components/integrations/code-sample";
import { ListFrame, PageSection } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useActions } from "@/hooks/api/use-actions";
import type {
	McpAdoptedTool,
	McpUpstream,
} from "@/hooks/api/use-mcp-upstreams";
import { API_BASE_URL } from "@/lib/constants";
import { curlSnippet, mcpToolName } from "@/lib/mcp-servers";

function StateBadge({ tool }: { tool: McpAdoptedTool }) {
	if (tool.state === "changed") return <Badge variant="warning">Changed</Badge>;
	if (tool.state === "missing")
		return <Badge variant="error">No longer listed</Badge>;
	if (!tool.enabled) return <Badge variant="outline">Disabled</Badge>;
	return <Badge variant="success">Live</Badge>;
}

export function UseItTab({
	server,
	workspaceId,
}: {
	server: McpUpstream;
	workspaceId?: string;
}) {
	const id = useId();
	const actions = useActions(workspaceId).data ?? [];
	const [picked, setPicked] = useState<string | null>(null);
	const adopted = server.adopted;
	const current = adopted.find((tool) => tool.action === picked) ?? adopted[0];

	if (!current) {
		return (
			<ListFrame>
				<ListEmpty
					action={
						<Link
							className="text-[13px] underline underline-offset-2"
							params={{ name: server.name }}
							to="/mcp-servers/$name"
						>
							Choose tools
						</Link>
					}
					description="Once you adopt a tool, its action and how to call it show up here."
					title="Nothing adopted yet"
				/>
			</ListFrame>
		);
	}

	const schema = server.tools.find((tool) => tool.name === current.tool)
		?.definition.inputSchema;

	return (
		<div className="flex flex-col gap-6">
			<ListFrame>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Action</TableHead>
							<TableHead className="hidden w-32 sm:table-cell">
								Approval
							</TableHead>
							<TableHead className="w-36">State</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{adopted.map((tool) => {
							const action = actions.find((item) => item.id === tool.actionId);
							return (
								<TableRow key={tool.actionId}>
									<TableCell className="max-w-0 py-2.5">
										<Link
											className="block truncate font-medium font-mono text-[13px] underline-offset-2 hover:underline"
											search={{ action: tool.actionId }}
											to="/actions"
											translate="no"
										>
											{tool.action}
										</Link>
									</TableCell>
									<TableCell className="hidden py-2.5 sm:table-cell">
										{action
											? action.requiresApproval
												? "Every call"
												: "None"
											: ""}
									</TableCell>
									<TableCell className="py-2.5">
										<StateBadge tool={tool} />
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</ListFrame>

			<PageSection
				description={
					<>
						Your agent calls an adopted tool like any other action, with an{" "}
						<Link
							className="underline underline-offset-2"
							to="/settings/api-keys"
						>
							API key
						</Link>{" "}
						and never this server's credential.
					</>
				}
				title="How to call it"
			>
				{adopted.length > 1 ? (
					<div className="space-y-1.5">
						<Label htmlFor={`${id}-action`}>Action</Label>
						<NativeSelect
							className="w-full font-mono sm:max-w-sm"
							id={`${id}-action`}
							onChange={(event) => setPicked(event.target.value)}
							value={current.action}
						>
							{adopted.map((tool) => (
								<NativeSelectOption key={tool.actionId} value={tool.action}>
									{tool.action}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
				) : null}
				<CodeSample
					label="Call"
					snippets={{ curl: curlSnippet(API_BASE_URL, current.action, schema) }}
				/>
				<ul className="flex max-w-[44rem] flex-col gap-1.5 text-[13px] text-muted-foreground">
					<li>
						<code className="font-mono text-foreground">Anlyon-End-User</code>{" "}
						{server.oauth
							? "says who the call is for, and it carries that person's own token, so they must have connected on the People tab. Left out, the call acts as your own account."
							: "says who the call is for, so that person's approvals and receipts apply. Leave it out for a call made for no one in particular."}
					</li>
					<li>
						Over Anlyon's MCP server, an agent sees this as{" "}
						<code className="font-mono text-foreground" translate="no">
							{mcpToolName(current.action)}
						</code>
						.
					</li>
				</ul>
			</PageSection>
		</div>
	);
}
