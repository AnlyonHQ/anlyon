import { describe, expect, it } from "vitest";
import { claudeCodePermissions, claudeCodeToolName, scanTools } from "../src/index.ts";
import { tools } from "./helpers.ts";

describe("claudeCodePermissions", () => {
  it("allows reads, asks for writes and irreversible tools, and denies destructive ones", async () => {
    const result = await scanTools(tools("slack"));
    expect(claudeCodePermissions("slack", result)).toEqual({
      permissions: {
        allow: [
          "mcp__slack__slack_list_channels",
          "mcp__slack__slack_get_channel_history",
          "mcp__slack__slack_get_thread_replies",
          "mcp__slack__slack_get_users",
          "mcp__slack__slack_get_user_profile",
        ],
        ask: ["mcp__slack__slack_post_message", "mcp__slack__slack_reply_to_thread", "mcp__slack__slack_add_reaction"],
        deny: ["mcp__slack__slack_archive_channel"],
      },
    });
  });

  it("puts every tool in exactly one list", async () => {
    const result = await scanTools(tools("github"));
    const { allow, ask, deny } = claudeCodePermissions("github", result).permissions;
    expect(allow.length + ask.length + deny.length).toBe(result.tools.length);
    expect(deny).toEqual(["mcp__github__delete_file"]);
    expect(ask).toContain("mcp__github__merge_pull_request");
  });

  it("writes names the way Claude Code does: anything but letters, digits, _ and - becomes _", () => {
    expect(claudeCodeToolName("my server.io", "get.thing")).toBe("mcp__my_server_io__get_thing");
    expect(claudeCodeToolName("context7", "resolve-library-id")).toBe("mcp__context7__resolve-library-id");
  });

  it("gives one rule per Claude Code name, at the strictest class", async () => {
    const result = await scanTools([{ name: "get.x" }, { name: "get_x", annotations: { destructiveHint: true } }]);
    expect(claudeCodePermissions("s", result).permissions).toEqual({ allow: [], ask: [], deny: ["mcp__s__get_x"] });
  });

  it("needs a server name", async () => {
    const result = await scanTools([]);
    expect(() => claudeCodePermissions("  ", result)).toThrow(TypeError);
  });
});
