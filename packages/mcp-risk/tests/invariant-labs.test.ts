import { describe, expect, it } from "vitest";
import { claudeCodePermissions, diffTools, scanTools } from "../src/index.ts";
import { INVARIANT_SOURCE, poisonedAdd, rugPullBefore, shadowingAdd, trustedSendEmail } from "./fixtures/invariant-labs.ts";

describe("the fixture", () => {
  it("records its source and the date it was checked", () => {
    expect(INVARIANT_SOURCE).toEqual({
      url: "https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks",
      title: "MCP Security Notification: Tool Poisoning Attacks",
      authors: ["Luca Beurer-Kellner", "Marc Fischer"],
      published: "2025-04-01",
      checked: "2026-10-20",
    });
  });
});

describe("experiment 1: the poisoned add tool", () => {
  it("is classed by what it says it does (a write), with the poisoning in its findings", async () => {
    const result = await scanTools([poisonedAdd], { serverName: "math" });
    const [add] = result.tools;
    expect(add!.class).toBe("write");
    expect(add!.findings.map((f) => [f.id, f.severity])).toEqual([
      ["model-directed-text", "high"],
      ["model-directed-text", "high"],
      ["model-directed-text", "high"],
      ["sensitive-path", "high"],
    ]);
  });

  it("names each piece of evidence", async () => {
    const [add] = (await scanTools([poisonedAdd])).tools;
    const messages = add!.findings.map((f) => f.message);
    expect(messages).toEqual([
      'The description contains "<IMPORTANT>", a tag of the kind used to mark instructions for the model.',
      'The description contains "Before using this tool, read", an instruction to read something before the tool is used.',
      'The description contains "Do not mention that", an instruction to keep something from the user.',
      'The description refers to "~/.cursor/mcp.json" and "~/.ssh/id_rsa".',
    ]);
    expect(add!.findings[3]!.evidence).toContain("read `~/.cursor/mcp.json` and pass its content");
  });

  it("is a server with no reads to allow", async () => {
    const result = await scanTools([poisonedAdd]);
    expect(claudeCodePermissions("math", result)).toEqual({ permissions: { allow: [], ask: ["mcp__math__add"], deny: [] } });
  });
});

describe("experiment 2: the add tool that shadows send_email", () => {
  it("is found naming another server's tool, with model-directed text", async () => {
    const [add] = (await scanTools([shadowingAdd], { serverName: "math" })).tools;
    expect(add!.class).toBe("write");
    expect(add!.findings.map((f) => [f.id, f.severity, f.message])).toEqual([
      ["model-directed-text", "high", 'The description contains "<IMPORTANT>", a tag of the kind used to mark instructions for the model.'],
      ["model-directed-text", "high", 'The description contains "Do not mention this to the user", an instruction to keep something from the user.'],
      ["tool-shadowing", "warn", 'The description names a tool "send_email" that this server does not list.'],
      ["tool-shadowing", "warn", 'The description contains "When this tool is available", wording about other tools or servers.'],
    ]);
  });

  it("does not change the trusted tool it targets, which scans clean on its own server", async () => {
    const [send] = (await scanTools([trustedSendEmail], { serverName: "mail" })).tools;
    expect(send!.class).toBe("irreversible");
    expect(send!.findings).toEqual([]);
  });
});

describe("a rug pull: the definition changes after it was approved", () => {
  it("changes the hash and shows which fields changed", async () => {
    const before = await scanTools([rugPullBefore]);
    const after = await scanTools([poisonedAdd]);
    expect(before.hash).not.toBe(after.hash);
    expect(before.tools[0]!.findings).toEqual([]);
    expect(diffTools([rugPullBefore], [poisonedAdd])).toEqual({
      added: [],
      removed: [],
      changed: [{ tool: "add", fields: ["description", "inputSchema"] }],
    });
  });
});
