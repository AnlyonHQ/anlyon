import { actionToolName } from "./action-tool-name";

export const HOSTED_MCP_URL = "https://api.anlyon.com/mcp";

export const AGENT_KEY_SCOPES = [
	"actions:invoke",
	"actions:read",
	"approvals:read",
] as const;

export type AgentClient =
	| "claude-code"
	| "cursor"
	| "codex"
	| "ai-sdk"
	| "langchain"
	| "curl";

export interface AgentSnippetContext {
	toolNames: string[];
	workspaceName: string;
	environmentName: string;
}

export interface AgentSnippetBlock {
	language: "bash" | "json" | "toml" | "typescript" | "python";
	docLines: string[];
	code: string;
}

export interface AgentSnippet {
	client: AgentClient;
	label: string;
	signsIn: boolean;
	blocks: AgentSnippetBlock[];
	toolHint: string;
}

export const AGENT_CLIENTS: { id: AgentClient; label: string }[] = [
	{ id: "claude-code", label: "Claude Code" },
	{ id: "cursor", label: "Cursor" },
	{ id: "codex", label: "Codex" },
	{ id: "ai-sdk", label: "AI SDK" },
	{ id: "langchain", label: "LangChain" },
	{ id: "curl", label: "curl" },
];

function block(
	language: AgentSnippetBlock["language"],
	docLines: string[],
	extra: { before?: string[]; after?: string[] } = {},
): AgentSnippetBlock {
	return {
		language,
		docLines,
		code: [...(extra.before ?? []), ...docLines, ...(extra.after ?? [])].join(
			"\n",
		),
	};
}

const mcpToolNames = (names: string[]) =>
	names.map((n) => actionToolName(n)).join(", ");

export function agentSnippet(
	client: AgentClient,
	ctx: AgentSnippetContext,
): AgentSnippet {
	const where = `Workspace ${ctx.workspaceName}, environment ${ctx.environmentName}`;
	const tools = ctx.toolNames;
	switch (client) {
		case "claude-code":
			return {
				client,
				label: "Claude Code",
				signsIn: true,
				blocks: [
					block(
						"bash",
						[
							"claude mcp add --transport http anlyon https://api.anlyon.com/mcp",
						],
						{
							before: [`# ${where}: choose them when you sign in with /mcp.`],
						},
					),
				],
				toolHint: `Run /mcp, select anlyon and sign in. The tools appear as ${mcpToolNames(tools)}.`,
			};
		case "cursor":
			return {
				client,
				label: "Cursor",
				signsIn: true,
				blocks: [
					block("json", [
						"{",
						'  "mcpServers": {',
						'    "anlyon": {',
						'      "url": "https://api.anlyon.com/mcp"',
						"    }",
						"  }",
						"}",
					]),
				],
				toolHint: `Put this in .cursor/mcp.json, sign in when Cursor asks, and choose ${where.toLowerCase()}. The tools appear as ${mcpToolNames(tools)}.`,
			};
		case "codex":
			return {
				client,
				label: "Codex",
				signsIn: true,
				blocks: [
					block("toml", [
						"[mcp_servers.anlyon]",
						'url = "https://api.anlyon.com/mcp"',
					]),
					block("bash", ["codex mcp login anlyon"]),
				],
				toolHint: `Add the block to ~/.codex/config.toml, then sign in and choose ${where.toLowerCase()}. The tools appear as ${mcpToolNames(tools)}.`,
			};
		case "ai-sdk":
			return {
				client,
				label: "AI SDK",
				signsIn: false,
				blocks: [
					block("bash", ["npm install @anlyonhq/ai-sdk @anlyonhq/sdk ai"]),
					block(
						"typescript",
						[
							"import { Client } from '@anlyonhq/sdk';",
							"import { createAnlyonTools } from '@anlyonhq/ai-sdk';",
							"",
							"const client = new Client({ apiKey: process.env.ANLYON_API_KEY! });",
							"const tools = createAnlyonTools(client);",
						],
						{
							after: [
								`// invokeAction runs ${tools.map((t) => `"${t}"`).join(", ")} by name.`,
							],
						},
					),
				],
				toolHint: `Set ANLYON_API_KEY to an agent key for ${where.toLowerCase()}, and pass tools to streamText or generateText.`,
			};
		case "langchain":
			return {
				client,
				label: "LangChain",
				signsIn: false,
				blocks: [
					block(
						"python",
						[
							"from anlyon import Client",
							"from anlyon_langchain import action_tools",
						],
						{
							before: ["import os", ""],
							after: [
								"",
								'client = Client(api_key=os.environ["ANLYON_API_KEY"])',
								`tools = action_tools(client, names=[${tools.map((t) => `"${t}"`).join(", ")}])`,
							],
						},
					),
				],
				toolHint: `Set ANLYON_API_KEY to an agent key for ${where.toLowerCase()}, then bind the tools with model.bind_tools(tools).`,
			};
		case "curl":
			return {
				client,
				label: "curl",
				signsIn: false,
				blocks: [
					block(
						"bash",
						[
							'  -H "Authorization: Bearer $ANLYON_AGENT_KEY" \\',
							'  -H "Content-Type: application/json" \\',
						],
						{
							before: [
								`curl --fail-with-body -X POST https://api.anlyon.com/api/v2/actions/${tools[0] ?? "<action>"}/invoke \\`,
							],
							after: ["  -d '{ \"input\": { } }'"],
						},
					),
				],
				toolHint: `Set ANLYON_AGENT_KEY to an agent key for ${where.toLowerCase()}. The input is the action's input schema.`,
			};
	}
}

export const CURL_INVOKE_PREFIX =
	"curl --fail-with-body -X POST https://api.anlyon.com/api/v2/actions/";
