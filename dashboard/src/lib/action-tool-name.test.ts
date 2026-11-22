import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { actionToolName, sha256Hex } from "./action-tool-name";
import { agentSnippet } from "./agent-snippets";
import { mcpToolName } from "./mcp-servers";

const fromTheServer = (actionName: string) => {
	const safe = actionName.replace(/[^a-zA-Z0-9_-]/g, "_");
	const whole = `action_${safe}`;
	if (safe === actionName && whole.length <= 51) return whole;
	const hash = createHash("sha256")
		.update(actionName)
		.digest("hex")
		.slice(0, 8);
	return `${whole.slice(0, 51 - hash.length - 1)}-${hash}`;
};

describe("sha256Hex", () => {
	it("is SHA-256", () => {
		const lengths = [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000];
		for (const length of lengths) {
			const text = "a".repeat(length);
			expect(sha256Hex(text), `${length}`).toBe(
				createHash("sha256").update(text).digest("hex"),
			);
		}
		expect(sha256Hex("é✓")).toBe(
			createHash("sha256").update("é✓").digest("hex"),
		);
	});
});

describe("actionToolName", () => {
	it("keeps a name that fits", () => {
		expect(actionToolName("github-get_issue")).toBe("action_github-get_issue");
		const longest = "a".repeat(44);
		expect(actionToolName(longest)).toBe(`action_${longest}`);
	});

	it("shortens a name that does not fit, as the MCP server does", () => {
		for (const name of [
			"a".repeat(45),
			"a-very-long-upstream-name-for-a-server-run_a_long_tool_name",
			"b".repeat(100),
			"has.a.dot",
		]) {
			const shortened = actionToolName(name);
			expect(shortened, name).toBe(fromTheServer(name));
			expect(shortened.length, name).toBeLessThanOrEqual(51);
		}
	});

	it("still states the MCP server's own rule", () => {
		const source = readFileSync(
			join(
				__dirname,
				"../../../sdks/typescript/mcp-server/src/tools/dynamic-actions.ts",
			),
			"utf8",
		);
		expect(source).toContain("MAX_TOOL_NAME_LENGTH = 51");
		expect(source).toContain("ACTION_TOOL_PREFIX = 'action_'");
		expect(source).toContain(
			"${whole.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}-${hash}",
		);
		expect(source).toContain(".digest('hex').slice(0, 8)");
	});

	it("is what the console's MCP page and snippets show", () => {
		const long = "a".repeat(60);
		expect(mcpToolName(long)).toBe(fromTheServer(long));
		const snippet = agentSnippet("claude-code", {
			workspaceName: "w",
			environmentName: "e",
			toolNames: [long],
		} as never);
		expect(JSON.stringify(snippet)).toContain(fromTheServer(long));
	});
});
