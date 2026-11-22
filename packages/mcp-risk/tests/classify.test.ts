import { describe, expect, it } from "vitest";
import { scanTools, type McpTool } from "../src/index.ts";
import { classes, ids, one, tools } from "./helpers.ts";

describe("realistic tool lists", () => {
  it("classifies a GitHub-like server", async () => {
    const result = await scanTools(tools("github"));
    expect(classes(result)).toEqual({
      get_me: "read",
      search_repositories: "read",
      get_file_contents: "read",
      list_issues: "read",
      issue_read: "read",
      create_issue: "write",
      add_issue_comment: "write",
      create_or_update_file: "write",
      push_files: "write",
      delete_file: "destructive",
      create_branch: "write",
      create_pull_request: "write",
      merge_pull_request: "irreversible",
      fork_repository: "write",
      list_commits: "read",
      search_code: "read",
      request_copilot_review: "write",
    });
    expect(result.counts).toEqual({ read: 7, write: 8, irreversible: 1, destructive: 1 });
  });

  it("classifies a filesystem-like server, where destructiveHint raises writes that overwrite", async () => {
    const result = await scanTools(tools("filesystem"));
    expect(classes(result)).toEqual({
      read_text_file: "read",
      read_media_file: "read",
      read_multiple_files: "read",
      write_file: "destructive",
      edit_file: "destructive",
      create_directory: "write",
      list_directory: "read",
      list_directory_with_sizes: "read",
      directory_tree: "read",
      move_file: "write",
      search_files: "read",
      get_file_info: "read",
      list_allowed_directories: "read",
    });
  });

  it("classifies a Stripe-like server: money words and finalising are irreversible, a payment link and a price are not", async () => {
    const result = await scanTools(tools("stripe"));
    expect(classes(result)).toEqual({
      create_customer: "write",
      list_customers: "read",
      create_product: "write",
      create_price: "write",
      list_prices: "read",
      create_payment_link: "write",
      create_invoice: "write",
      finalize_invoice: "irreversible",
      retrieve_balance: "read",
      create_refund: "irreversible",
      list_payment_intents: "read",
      list_subscriptions: "read",
      update_subscription: "write",
      cancel_subscription: "destructive",
      create_coupon: "write",
      search_stripe_documentation: "read",
    });
  });

  it("classifies a Slack-like server: posting and replying send, archiving ends", async () => {
    const result = await scanTools(tools("slack"));
    expect(classes(result)).toEqual({
      slack_list_channels: "read",
      slack_post_message: "irreversible",
      slack_reply_to_thread: "irreversible",
      slack_add_reaction: "write",
      slack_get_channel_history: "read",
      slack_get_thread_replies: "read",
      slack_get_users: "read",
      slack_get_user_profile: "read",
      slack_archive_channel: "destructive",
    });
  });

  it("gives no high or warn findings on any of them", async () => {
    for (const name of ["github", "filesystem", "stripe", "slack"] as const) {
      const result = await scanTools(tools(name), { serverName: name });
      const loud = [...result.serverFindings, ...result.tools.flatMap((t) => t.findings)].filter((f) => f.severity !== "info");
      expect(loud, name).toEqual([]);
    }
  });

  it("explains each class by the words that set it", async () => {
    const result = await scanTools(tools("stripe"));
    const by = Object.fromEntries(result.tools.map((t) => [t.tool, t]));
    expect(by.create_refund!.reasons.join(" ")).toMatch(/also says "refund"/);
    expect(by.cancel_subscription!.reasons).toContain("The server marks it destructive (destructiveHint: true).");
    expect(by.create_payment_link!.reasons).toEqual(['The name "create_payment_link" says "create": a word for a change.']);
  });
});

const t = (name: string, extra: Partial<McpTool> = {}): McpTool => ({ name, ...extra });
const cls = async (tool: McpTool) => (await one(tool)).class;

describe("the name", () => {
  it("reads its first known verb, wherever the namespace puts it", async () => {
    expect(await cls(t("github_create_issue"))).toBe("write");
    expect(await cls(t("issueCreate"))).toBe("write");
    expect(await cls(t("browser_take_screenshot"))).toBe("read");
    expect(await cls(t("resolve-library-id"))).toBe("read");
    expect(await cls(t("repo_delete"))).toBe("destructive");
  });

  it("does not raise a read by the nouns after its verb", async () => {
    expect(await cls(t("list_refunds"))).toBe("read");
    expect(await cls(t("get_archive"))).toBe("read");
    expect(await cls(t("search_deleted_items"))).toBe("read");
  });

  it("raises a plain verb by a money or send noun right after it", async () => {
    expect(await cls(t("create_payout"))).toBe("irreversible");
    expect(await cls(t("create_invite"))).toBe("irreversible");
    expect(await cls(t("create_payment_method"))).toBe("write");
  });

  it("reads a second verb after 'and'", async () => {
    expect(await cls(t("create_and_send_invoice"))).toBe("irreversible");
    expect(await cls(t("update_and_delete_rows"))).toBe("destructive");
  });

  it("reads post + message as a send, but not a record called email", async () => {
    expect(await cls(t("chat_postMessage"))).toBe("irreversible");
    expect(await cls(t("post_email"))).toBe("irreversible");
    expect(await cls(t("create_email"))).toBe("write");
    expect(await cls(t("post_comment"))).toBe("write");
  });

  it("counts each destroy and final word", async () => {
    for (const verb of ["remove", "destroy", "purge", "revoke", "void", "drop", "truncate", "terminate"]) {
      expect(await cls(t(`${verb}_thing`)), verb).toBe("destructive");
    }
    for (const verb of ["merge", "publish", "transfer", "send", "notify", "refund", "charge"]) {
      expect(await cls(t(`${verb}_thing`)), verb).toBe("irreversible");
    }
  });

  it("counts a tool that names nothing as a write, and says so", async () => {
    const entry = await one(t("sequentialthinking", { description: "A detailed tool for dynamic and reflective problem-solving." }));
    expect(entry.class).toBe("write");
    expect(entry.reasons).toEqual(["Nothing in its name or description says what it does, so it is counted as a write."]);
  });
});

describe("the description", () => {
  it("sets the class when the name has no verb, skipping 'Use this tool to'", async () => {
    expect(await cls(t("browser_console_messages", { description: "Returns all console messages" }))).toBe("read");
    expect(await cls(t("thing", { description: "Use this tool to permanently delete a thing." }))).toBe("destructive");
    expect(await cls(t("slack", { description: "Post a new message to a Slack channel" }))).toBe("irreversible");
  });

  it("raises but never lowers the name's class", async () => {
    expect(await cls(t("get_user", { description: "Deletes the user after reading it." }))).toBe("destructive");
    expect(await cls(t("delete_user", { description: "Gets a user." }))).toBe("destructive");
  });

  it("reads only the first sentence for its verb", async () => {
    expect(await cls(t("get_x", { description: "Get an x. Delete is a separate tool." }))).toBe("read");
  });

  it("raises to irreversible on wording that says the change is final", async () => {
    const entry = await one(t("update_record", { description: "Update a record. This action cannot be undone." }));
    expect(entry.class).toBe("irreversible");
    expect(entry.reasons).toContain('The description says "cannot be undone".');
  });
});

describe("the input schema", () => {
  const schema = (properties: Record<string, unknown>) => ({ type: "object", properties });

  it("raises a write that carries amount and currency to irreversible", async () => {
    const entry = await one(t("create_thing", { inputSchema: schema({ amount: { type: "integer" }, currency: { type: "string" } }) }));
    expect(entry.class).toBe("irreversible");
    expect(entry.reasons.join(" ")).toMatch(/input\.amount\) and a currency/);
    expect(await cls(t("create_thing", { inputSchema: schema({ amount_money: { type: "object", properties: { amount: { type: "integer" }, currency: { type: "string" } } } }) }))).toBe("irreversible");
  });

  it("does not count an amount without a currency, or unit_amount on a price", async () => {
    expect(await cls(t("create_deal", { inputSchema: schema({ amount: { type: "number" } }) }))).toBe("write");
    expect(await cls(t("create_price", { inputSchema: schema({ unit_amount: { type: "integer" }, currency: { type: "string" } }) }))).toBe("write");
  });

  it("raises a write that addresses people to irreversible, but not a read that filters by them", async () => {
    expect(await cls(t("create_draft", { inputSchema: schema({ to: { type: "array" } }) }))).toBe("irreversible");
    expect(await cls(t("create_draft", { inputSchema: schema({ message: { type: "object", properties: { recipients: { type: "array" } } } }) }))).toBe("irreversible");
    expect(await cls(t("search_emails", { inputSchema: schema({ to: { type: "string" } }) }))).toBe("read");
  });

  it("raises a read that takes a statement to run to a write", async () => {
    const entry = await one(t("query", { inputSchema: schema({ sql: { type: "string" } }) }));
    expect(entry.class).toBe("write");
    expect(entry.reasons.join(" ")).toMatch(/input\.sql/);
    expect(await cls(t("run_command", { inputSchema: schema({ command: { type: "string" } }) }))).toBe("write");
  });
});

describe("annotations never lower a class", () => {
  it("keeps delete_* destructive under readOnlyHint: true, and reports the conflict", async () => {
    const entry = await one(t("delete_repo", { annotations: { readOnlyHint: true } }));
    expect(entry.class).toBe("destructive");
    expect(entry.reasons).toContain("The server marks it read-only (readOnlyHint: true), but an annotation never lowers a class.");
    const conflict = entry.findings.find((f) => f.id === "annotation-conflict")!;
    expect(conflict).toMatchObject({ severity: "warn", tool: "delete_repo" });
    expect(conflict.message).toBe('The server marks "delete_repo" read-only (readOnlyHint: true), and its own name, description or input give the class "destructive".');
    expect(conflict.evidence).toContain('"readOnlyHint":true');
  });

  it("keeps a tool that names nothing a write under readOnlyHint: true, without a conflict", async () => {
    const entry = await one(t("browser_tab_new", { annotations: { readOnlyHint: true } }));
    expect(entry.class).toBe("write");
    expect(entry.findings).toEqual([]);
  });

  it("keeps a destructive word destructive under destructiveHint: false, and reports the conflict", async () => {
    const entry = await one(t("remove_member", { annotations: { destructiveHint: false } }));
    expect(entry.class).toBe("destructive");
    expect(entry.findings.map((f) => f.id)).toEqual(["annotation-conflict"]);
  });

  it("lets destructiveHint: true raise any class", async () => {
    expect(await cls(t("create_thing", { annotations: { destructiveHint: true } }))).toBe("destructive");
    expect(await cls(t("reset_thing", { annotations: { destructiveHint: true } }))).toBe("destructive");
  });

  it("reports destructiveHint: true on a read, and both hints at once", async () => {
    const read = await one(t("list_things", { annotations: { destructiveHint: true } }));
    expect(read.class).toBe("destructive");
    expect(read.findings[0]!.message).toMatch(/its name says "list", a word for reading/);
    expect(await ids(t("create_thing", { annotations: { readOnlyHint: true, destructiveHint: true } }))).toContain("annotation-conflict");
  });

  it("lets readOnlyHint: false raise a read to a write, and reports it", async () => {
    const entry = await one(t("get_thing", { annotations: { readOnlyHint: false } }));
    expect(entry.class).toBe("write");
    expect(entry.findings.map((f) => f.id)).toEqual(["annotation-conflict"]);
  });

  it("is silent when the annotations agree", async () => {
    expect(await ids(t("get_thing", { annotations: { readOnlyHint: true } }))).toEqual([]);
    expect(await ids(t("delete_thing", { annotations: { readOnlyHint: false, destructiveHint: true } }))).toEqual([]);
  });
});

describe("determinism", () => {
  it("gives the same result for the same tools", async () => {
    const a = await scanTools(tools("github"));
    const b = await scanTools(tools("github"));
    expect(b).toEqual(a);
  });
});
