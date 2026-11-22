import { describe, expect, it } from "vitest";
import {
  type CapabilityTag,
  capabilityTags,
  claudeCodePermissions,
  exfilPaths,
  type McpTool,
  permissionTags,
  scanTools,
  toolPermission,
  withTags,
} from "../src/index.ts";
import { one, tools } from "./helpers.ts";

const obj = (properties: Record<string, unknown>) => ({ type: "object", properties });
const str = { type: "string" };

async function tagsOf(tool: McpTool): Promise<CapabilityTag[]> {
  return (await one(tool)).tags.map((t) => t.tag);
}

async function reasons(tool: McpTool, tag: CapabilityTag): Promise<string[]> {
  return (await one(tool)).tags.find((t) => t.tag === tag)?.reasons ?? [];
}

describe("private-data", () => {
  it("is set by a read of files, mail, messages, databases, secrets, calendars and repositories", async () => {
    for (const name of [
      "read_file",
      "list_emails",
      "get_messages",
      "list_tables",
      "get_secret",
      "list_calendar_events",
      "list_commits",
      "search_documents",
    ]) {
      expect(await tagsOf({ name }), name).toContain("private-data");
    }
  });

  it("says which words set it", async () => {
    expect(await reasons({ name: "read_text_file" }, "private-data")).toEqual([
      'The name "read_text_file" says "read" and "file": it reads files.',
    ]);
    expect(await reasons({ name: "slack_get_channel_history", description: "Get recent messages from a channel." }, "private-data")).toEqual([
      'The description\'s first sentence says "get" and "message": it reads messages.',
    ]);
  });

  it("reads a repository named in the input, and a statement a run verb runs", async () => {
    expect(await reasons({ name: "list_issues", inputSchema: obj({ owner: str, repo: str }) }, "private-data")).toContain(
      "The input names a repo (input.repo), and the tool reads: it reads repositories.",
    );
    expect(await reasons({ name: "execute_sql", inputSchema: obj({ sql: str }) }, "private-data")).toEqual([
      'The name says "execute" and the input takes a statement (input.sql): it reads databases.',
    ]);
  });

  it("near misses: a change to a file, an email filter, a commit message, and SQL that is only formatted", async () => {
    expect(await tagsOf({ name: "delete_file" })).not.toContain("private-data");
    expect(await tagsOf({ name: "write_file", inputSchema: obj({ path: str, content: str }) })).not.toContain("private-data");
    expect(await tagsOf({ name: "list_customers", inputSchema: obj({ email: str }) })).not.toContain("private-data");
    expect(await tagsOf({ name: "validate_commit_message", inputSchema: obj({ message: str }) })).toEqual([]);
    expect(await tagsOf({ name: "format_sql", inputSchema: obj({ sql: str }) })).not.toContain("private-data");
    expect(await tagsOf({ name: "get_weather", inputSchema: obj({ city: str }) })).toEqual([]);
  });
});

describe("untrusted-input", () => {
  it("is set by reading web pages, inbound mail, messages, issues and comments", async () => {
    for (const name of ["list_issues", "get_pull_request", "read_inbox", "list_comments", "search_web", "get_tickets"]) {
      expect(await tagsOf({ name }), name).toContain("untrusted-input");
    }
    expect(await reasons({ name: "scrape_page" }, "untrusted-input")).toEqual([
      'The name "scrape_page" says "scrape": it reads web pages, which anyone can write.',
    ]);
  });

  it("is set by a URL a read fetches, and by a browser that loads one", async () => {
    expect(await reasons({ name: "fetch", inputSchema: obj({ url: str }) }, "untrusted-input")).toEqual([
      "The input takes a URL (input.url), and the tool reads it: it reads web pages, which anyone can write.",
    ]);
    expect(await tagsOf({ name: "browser_navigate", inputSchema: obj({ url: str }) })).toContain("untrusted-input");
  });

  it("is set by openWorldHint: true, and only when it is true", async () => {
    expect(await reasons({ name: "lookup_thing", annotations: { openWorldHint: true } }, "untrusted-input")).toEqual([
      "The server marks it openWorldHint: true: it reaches things outside the server's own data.",
    ]);
    expect(await tagsOf({ name: "lookup_thing", annotations: { openWorldHint: false } })).toEqual([]);
    expect(await tagsOf({ name: "lookup_thing" })).toEqual([]);
  });

  it("near misses: opening an issue, building a web page, and a date range", async () => {
    expect(await tagsOf({ name: "open_issue" })).not.toContain("untrusted-input");
    expect(await tagsOf({ name: "create_web_page" })).not.toContain("untrusted-input");
    expect(await tagsOf({ name: "list_events", inputSchema: obj({ from: str, to: str }) })).not.toContain("untrusted-input");
  });
});

describe("outbound", () => {
  it("is set by sending, posting and publishing", async () => {
    expect(await reasons({ name: "slack_post_message" }, "outbound")).toEqual([
      'The name "slack_post_message" says "post" and "message": it sends something to other people.',
    ]);
    expect(await reasons({ name: "publish_article" }, "outbound")).toEqual([
      'The name "publish_article" says "publish": it sends or publishes something to other people.',
    ]);
    expect(await tagsOf({ name: "create_and_send_invoice" })).toContain("outbound");
    expect(await reasons({ name: "add_issue_comment" }, "outbound")).toEqual([
      'The name "add_issue_comment" says "add" and "issue": it writes something other people read.',
    ]);
    expect(await tagsOf({ name: "create_pull_request" })).toContain("outbound");
    expect(await reasons({ name: "sms_tool", description: "Sends a text to a phone." }, "outbound")).toEqual([
      'The description\'s first verb is "send": it sends or publishes something to other people.',
    ]);
  });

  it("is set by a destination input, top level or one object down", async () => {
    expect(await reasons({ name: "slack_add_reaction", inputSchema: obj({ channel_id: str, reaction: str }) }, "outbound")).toEqual([
      "The input takes a destination (input.channel_id): what the tool writes goes there.",
    ]);
    expect(
      await reasons({ name: "create_draft", inputSchema: obj({ message: { type: "object", properties: { to: { type: "array" } } } }) }, "outbound"),
    ).toContain("The input takes a destination (input.message.to): what the tool writes goes there.");
  });

  it("is set by a URL input, even on a read, because a request carries what is put in it", async () => {
    expect(await reasons({ name: "fetch", inputSchema: obj({ url: str }) }, "outbound")).toEqual([
      "The input takes a URL (input.url): a request to a URL can carry data to whoever runs it.",
    ]);
    expect(await tagsOf({ name: "create_hook", inputSchema: obj({ webhookUrl: str }) })).toContain("outbound");
  });

  it("near misses: a move's destination path, a read's date range, an archive by channel, and removing a comment", async () => {
    expect(await tagsOf({ name: "move_file", inputSchema: obj({ source: str, destination: str }) })).toEqual([]);
    expect(await tagsOf({ name: "list_events", inputSchema: obj({ from: str, to: str }) })).not.toContain("outbound");
    expect(await tagsOf({ name: "slack_archive_channel", inputSchema: obj({ channel_id: str }) })).not.toContain("outbound");
    expect(await tagsOf({ name: "delete_comment" })).not.toContain("outbound");
    expect(await tagsOf({ name: "list_comments" })).not.toContain("outbound");
    expect(await tagsOf({ name: "create_customer", inputSchema: obj({ name: str, email: str }) })).toEqual([]);
    expect(await tagsOf({ name: "merge_pull_request" })).not.toContain("outbound");
  });
});

describe("tags in a scan", () => {
  it("come in a fixed order, and one tool can have all three", async () => {
    const tool: McpTool = {
      name: "get_email",
      description: "Get an email from the inbox, and tell a webhook when it is read.",
      inputSchema: obj({ id: str, webhook_url: str }),
    };
    expect(await tagsOf(tool)).toEqual(["private-data", "untrusted-input", "outbound"]);
  });

  it("match the fixtures", async () => {
    const result = await scanTools(tools("slack"));
    const tagged = Object.fromEntries(result.tools.map((t) => [t.tool, t.tags.map((x) => x.tag)]));
    expect(tagged).toMatchObject({
      slack_get_channel_history: ["private-data", "untrusted-input"],
      slack_post_message: ["outbound"],
      slack_archive_channel: [],
      slack_get_users: [],
    });
  });

  it("are left out of the hash", async () => {
    const list = tools("github");
    const result = await scanTools(list);
    const untagged = { ...result, tools: result.tools.map(({ tags: _, ...t }) => t) };
    expect(result.hash).toBe((await scanTools(list)).hash);
    expect(withTags(untagged as never, list)).toEqual(result);
  });

  it("are filled in for a stored result from before tags, from its definitions", async () => {
    const list = tools("slack");
    const result = await scanTools(list);
    const old = { ...result, tools: result.tools.map(({ tags: _, ...t }) => t) } as never;
    expect(withTags(old, list)).toEqual(result);
    expect(withTags(old, []).tools.every((t) => t.tags.length === 0)).toBe(true);
    expect(withTags(result, [])).toBe(result);
  });

  it("are computed from the final class", () => {
    expect(capabilityTags({ name: "fetch", inputSchema: obj({ url: str }) }, "destructive").map((t) => t.tag)).toEqual(["untrusted-input"]);
  });
});

describe("permissions with tags", () => {
  it("asks before an outbound read, and still allows a plain read", async () => {
    const result = await scanTools([
      { name: "fetch", inputSchema: obj({ url: str }) },
      { name: "get_weather" },
      { name: "delete_thing", inputSchema: obj({ url: str }) },
    ]);
    expect(claudeCodePermissions("web", result).permissions).toEqual({
      allow: ["mcp__web__get_weather"],
      ask: ["mcp__web__fetch"],
      deny: ["mcp__web__delete_thing"],
    });
    expect(toolPermission(result.tools[0]!)).toBe("ask");
  });

  it("lists the tags behind each rule beside the block", async () => {
    const result = await scanTools(tools("slack"));
    const tags = permissionTags("slack", result);
    expect(tags["mcp__slack__slack_get_channel_history"]).toEqual(["private-data", "untrusted-input"]);
    expect(tags["mcp__slack__slack_post_message"]).toEqual(["outbound"]);
    expect(tags["mcp__slack__slack_get_users"]).toBeUndefined();
  });
});

describe("exfilPaths", () => {
  const server = async (key: string, list: McpTool[]) => ({ key, tools: (await scanTools(list)).tools });

  it("finds every private-data -> untrusted-input -> outbound path across servers", async () => {
    const report = exfilPaths([
      await server("files", [{ name: "read_file" }, { name: "list_directory" }]),
      await server("web", [{ name: "search_web" }]),
      await server("chat", [{ name: "send_message", inputSchema: obj({ channel: str }) }, { name: "get_users" }]),
    ]);
    expect(report.tools["private-data"].map((t) => t.rule)).toEqual(["mcp__files__list_directory", "mcp__files__read_file"]);
    expect(report.tools["untrusted-input"].map((t) => t.rule)).toEqual(["mcp__web__search_web"]);
    expect(report.tools.outbound.map((t) => t.rule)).toEqual(["mcp__chat__send_message"]);
    expect(report.pathCount).toBe(2);
    expect(report.paths[0]).toEqual({
      privateData: { server: "files", tool: "list_directory", rule: "mcp__files__list_directory" },
      untrustedInput: { server: "web", tool: "search_web", rule: "mcp__web__search_web" },
      outbound: { server: "chat", tool: "send_message", rule: "mcp__chat__send_message" },
    });
    expect(report.truncated).toBe(false);
  });

  it("breaks every path with the smallest tag set, outbound first on a tie", async () => {
    const report = exfilPaths([
      await server("a", [{ name: "read_file" }, { name: "list_emails" }, { name: "send_email", inputSchema: obj({ to: str }) }]),
    ]);
    expect(report.pathCount).toBe(2);
    expect(report.breakWith?.tag).toBe("outbound");
    expect(report.breakWith?.tools.map((t) => t.tool)).toEqual(["send_email"]);

    const fewer = exfilPaths([
      await server("b", [
        { name: "read_file" },
        { name: "list_issues" },
        { name: "create_issue" },
        { name: "add_issue_comment" },
      ]),
    ]);
    expect(fewer.breakWith?.tag).toBe("untrusted-input");
    expect(fewer.breakWith?.tools.map((t) => t.tool)).toEqual(["list_issues"]);
  });

  it("denying the cut set leaves no path", async () => {
    const servers = [await server("gh", tools("github")), await server("slack", tools("slack"))];
    const report = exfilPaths(servers);
    expect(report.pathCount).toBeGreaterThan(0);
    const denied = new Set(report.breakWith!.tools.map((t) => t.rule));
    const after = exfilPaths(
      servers.map((s) => ({ ...s, tools: s.tools.filter((t) => !denied.has(`mcp__${s.key}__${t.tool}`)) })),
    );
    expect(after.pathCount).toBe(0);
    expect(after.breakWith).toBeNull();
  });

  it("has no path when a tag is missing, and caps the paths it lists", async () => {
    expect(exfilPaths([await server("fs", tools("filesystem"))])).toMatchObject({ pathCount: 0, paths: [], breakWith: null });
    const big = exfilPaths([await server("gh", tools("github")), await server("slack", tools("slack"))], 5);
    expect(big.paths).toHaveLength(5);
    expect(big.truncated).toBe(true);
  });

  it("counts two tools with one Claude Code name once, and a result without tags as none", () => {
    const report = exfilPaths([
      {
        key: "s",
        tools: [
          { tool: "get.file", tags: [{ tag: "private-data", reasons: [] }] },
          { tool: "get_file", tags: [{ tag: "private-data", reasons: [] }] },
          { tool: "old" } as never,
        ],
      },
    ]);
    expect(report.tools["private-data"].map((t) => t.rule)).toEqual(["mcp__s__get_file"]);
  });
});
