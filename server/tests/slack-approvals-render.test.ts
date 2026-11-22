import { describe, expect, it } from "vitest";
import { signSlackRequest, verifySlackSignature, SLACK_SIGNATURE_WINDOW_SECONDS } from "../src/core/slack-approvals/signature.ts";
import {
  ACTION_APPROVE,
  ACTION_DENY,
  ACTION_NOTE,
  approveGate,
  escapeMrkdwn,
  renderApprovalMessage,
  renderNoteModal,
  type ApprovalMessageModel,
} from "../src/core/slack-approvals/blocks.ts";

const SECRET = "test-signing-secret";
const NOW = 1_800_000_000;

describe("Slack request signature (v0)", () => {
  const body = "payload=%7B%22type%22%3A%22block_actions%22%7D";
  const ts = String(NOW);

  it("accepts a request signed with the signing secret inside the window", () => {
    const signature = signSlackRequest(SECRET, ts, body);
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature, rawBody: body, nowSeconds: NOW + 30 })).toEqual({ ok: true });
  });

  it("refuses a different secret, a changed body and a changed timestamp", () => {
    const signature = signSlackRequest(SECRET, ts, body);
    expect(verifySlackSignature({ signingSecret: "other", timestamp: ts, signature, rawBody: body, nowSeconds: NOW })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature, rawBody: `${body}x`, nowSeconds: NOW })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: String(NOW + 1), signature, rawBody: body, nowSeconds: NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a validly signed request outside the replay window, either side", () => {
    for (const offset of [SLACK_SIGNATURE_WINDOW_SECONDS + 1, -(SLACK_SIGNATURE_WINDOW_SECONDS + 1)]) {
      const stamp = String(NOW - offset);
      const signature = signSlackRequest(SECRET, stamp, body);
      expect(verifySlackSignature({ signingSecret: SECRET, timestamp: stamp, signature, rawBody: body, nowSeconds: NOW }))
        .toEqual({ ok: false, reason: "stale_timestamp" });
    }
  });

  it("refuses missing headers and a non-numeric timestamp", () => {
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: undefined, signature: "v0=x", rawBody: body })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: undefined, rawBody: body })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: "1e9", signature: "v0=x", rawBody: body })).toEqual({ ok: false, reason: "stale_timestamp" });
  });
});

function model(over: Partial<ApprovalMessageModel> = {}, approval: Partial<ApprovalMessageModel["approval"]> = {}): ApprovalMessageModel {
  const now = new Date("2026-10-19T12:00:00Z");
  return {
    approval: {
      approvalId: "apr_123",
      kind: "action",
      status: "pending",
      title: 'Run action "refund"',
      description: null,
      payload: { actionName: "refund", method: "POST", urlTemplate: "https://api.example.com/refunds", input: { amount: 1200, reason: "dup" } },
      requiredApprovals: 1,
      approvedCount: 0,
      expiresAt: new Date("2026-10-20T12:00:00Z"),
      decidedAt: null,
      decisionNote: null,
      bindingDigest: null,
      ...approval,
    },
    environment: { name: "Production", kind: "production" },
    preview: null,
    previewMissing: false,
    votes: [],
    decidedBy: null,
    consoleUrl: "https://console.example.com",
    now,
    ...over,
  };
}

const text = (message: { blocks: unknown[] }) => JSON.stringify(message.blocks);
const buttons = (message: { blocks: Array<Record<string, unknown>> }) =>
  (message.blocks.find((b) => b.type === "actions")?.elements as Array<{ action_id: string }> | undefined)?.map((e) => e.action_id) ?? [];

const preview = (over: Partial<NonNullable<ApprovalMessageModel["preview"]>> = {}) => ({
  id: "prv_1",
  bindingDigest: "a".repeat(64),
  expiresAt: new Date("2026-10-19T13:00:00Z"),
  allowances: [{ limitId: "lim_1", name: "Refunds per day", requested: "12.00 USD", available: "88.00 USD", sufficient: true }],
  blocks: [
    { type: "fields" as const, title: "Execution target", fields: [{ label: "Environment", value: "Production (production)" }] },
    { type: "text_diff" as const, title: "File change", path: "README.md", before: "old", after: "new", truncated: false },
    { type: "impact" as const, title: "Impact", quantities: [{ dimension: "money", amount: 1200, currency: "usd", bound: "exact" as const }] },
    { type: "limitations" as const, title: "Guarantees and limitations", items: [{ kind: "irreversible" as const, text: "A refund cannot be undone." }] },
  ],
  ...over,
});

describe("Slack approval message", () => {
  it("leads with the environment in words, and warns for production", () => {
    const message = renderApprovalMessage(model());
    expect(text(message)).toContain("Executes in *Production* (production, a production environment)");
    expect(text(message)).toContain(":rotating_light:");
    const staging = renderApprovalMessage(model({ environment: { name: "Staging", kind: "staging" } }));
    expect(text(staging)).not.toContain(":rotating_light:");
  });

  it("shows a template action's method, URL template and input", () => {
    const message = text(renderApprovalMessage(model()));
    expect(message).toContain("POST https://api.example.com/refunds");
    expect(message).toContain("amount: `1200`");
    expect(message).toContain("reason: `dup`");
  });

  it("shows a function plan's writes in order, with each input", () => {
    const message = text(renderApprovalMessage(model({}, {
      kind: "function_plan",
      title: 'Run function "refund-with-checks"',
      payload: {
        functionName: "refund-with-checks",
        planDigest: "sha256:abc",
        writes: [
          { sequence: 2, action: "refund", input: { order: "o_1", amount: 500 } },
          { sequence: 3, action: "email", input: { to: "a@example.test" } },
        ],
      },
    })));
    expect(message).toContain("*Function*\\n`refund-with-checks`");
    expect(message).toContain("*Writes, in this order*");
    expect(message).toContain('1. `refund` `{\\"order\\":\\"o_1\\",\\"amount\\":500}`');
    expect(message).toContain('2. `email` `{\\"to\\":\\"a@example.test\\"}`');
    expect(message).not.toContain("Custom request");
  });

  it("shows the bound preview: fields, diff, impact, limits at review time and limitations", () => {
    const bound = preview();
    const message = text(renderApprovalMessage(model({ preview: bound }, { bindingDigest: bound.bindingDigest })));
    expect(message).toContain("Execution target");
    expect(message).toContain("Current content");
    expect(message).toContain("Content after the change");
    expect(message).toContain("12.00 USD");
    expect(message).toContain("Refunds per day: needs 12.00 USD, 88.00 USD available");
    expect(message).toContain("Rechecked immediately before dispatch.");
    expect(message).toContain("Irreversible");
    expect(message).toContain(`Binding ${"a".repeat(16)}`);
  });

  it("escapes agent-supplied text so it cannot mention, link or break out of code", () => {
    const hostile = model({}, {
      title: "<!channel> approve now",
      description: "<https://evil.example|Approve> & <@U999>",
      payload: { actionName: "x`y", input: { note: "```<!here>```" } },
    });
    const rendered = renderApprovalMessage(hostile);
    const mrkdwnTexts: string[] = [rendered.text];
    JSON.stringify(rendered.blocks, (_key, value) => {
      if (value && value.type === "mrkdwn") mrkdwnTexts.push(value.text);
      return value;
    });
    const message = mrkdwnTexts.join("\n");
    expect(message).not.toContain("<!channel>");
    expect(message).not.toContain("<https://evil.example|Approve>");
    expect(message).not.toContain("<@U999>");
    expect(message).not.toContain("<!here>");
    expect(message).toContain("&lt;https://evil.example|Approve&gt; &amp; &lt;@U999&gt;");
    expect(escapeMrkdwn("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
  });

  it("offers Approve, Deny and a note while pending, with a confirmation naming the environment", () => {
    const message = renderApprovalMessage(model());
    expect(buttons(message)).toEqual([ACTION_APPROVE, ACTION_DENY, ACTION_NOTE, "anlyon_open"]);
    const approve = (message.blocks.find((b) => b.type === "actions")!.elements as Array<Record<string, any>>)[0];
    expect(approve.value).toBe("apr_123");
    expect(approve.confirm.text.text).toContain("*Production*");
  });

  it("withholds Approve when the bound preview is missing, expired or not the bound one; Deny stays", () => {
    const missing = model({ previewMissing: true }, { bindingDigest: "b".repeat(64) });
    const expired = model({ preview: preview({ expiresAt: new Date("2026-10-19T11:00:00Z") }) }, { bindingDigest: "a".repeat(64) });
    const mismatched = model({ preview: preview() }, { bindingDigest: "c".repeat(64) });
    for (const m of [missing, expired, mismatched]) {
      expect(approveGate(m).ok).toBe(false);
      expect(buttons(renderApprovalMessage(m))).toEqual([ACTION_DENY, ACTION_NOTE, "anlyon_open"]);
    }
    expect(text(renderApprovalMessage(expired))).toContain("It can no longer execute");
  });

  it("replaces the buttons with the outcome, who decided, when, and the note", () => {
    const decided = renderApprovalMessage(model({ decidedBy: "Jane Doe (<@U1>)" }, {
      status: "approved",
      approvedCount: 1,
      decidedAt: new Date("2026-10-19T12:05:00Z"),
      decisionNote: "Checked the order <ok>",
    }));
    const body = text(decided);
    expect(buttons(decided)).toEqual(["anlyon_open"]);
    expect(body).toContain("*Approved* by Jane Doe (<@U1>) <!date^");
    expect(body).toContain("Checked the order &lt;ok&gt;");
    expect(decided.text).toContain("Approved:");

    const expired = text(renderApprovalMessage(model({}, { status: "expired", decidedAt: new Date("2026-10-19T12:05:00Z") })));
    expect(expired).toContain("*Expired*");
  });

  it("shows votes so far while a quorum is still open", () => {
    const message = text(renderApprovalMessage(model({
      votes: [{ decision: "approve", by: "Jane Doe (<@U1>)", at: new Date("2026-10-19T12:01:00Z") }],
    }, { requiredApprovals: 2, approvedCount: 1 })));
    expect(message).toContain("1 of 2");
    expect(message).toContain("Votes so far: approved by Jane Doe (<@U1>)");
  });

  it("marks a self-approved vote, and a self-approved final decision", () => {
    const pending = text(renderApprovalMessage(model({
      votes: [{ decision: "approve", by: "Jane Doe (<@U1>)", selfApproved: true, at: new Date("2026-10-19T12:01:00Z") }],
    }, { requiredApprovals: 2, approvedCount: 1 })));
    expect(pending).toContain("approved by Jane Doe (<@U1>) (Self-approved (only approver in this environment))");
    const closed = text(renderApprovalMessage(model({
      decidedBy: "Jane Doe (<@U1>) (Self-approved (only approver in this environment))",
    }, { status: "approved", decidedAt: new Date("2026-10-19T12:02:00Z") })));
    expect(closed).toContain("Self-approved (only approver in this environment)");
  });

  it("stays within Slack's block limit and keeps the buttons for a very large preview", () => {
    const many = preview({
      blocks: Array.from({ length: 80 }, (_, i) => ({ type: "impact" as const, title: "Impact", quantities: [{ dimension: "resource_mutations", amount: i, bound: "exact" as const }] })),
    });
    const message = renderApprovalMessage(model({ preview: many }, { bindingDigest: many.bindingDigest }));
    expect(message.blocks.length).toBeLessThanOrEqual(50);
    expect(buttons(message)).toContain(ACTION_APPROVE);
  });

  it("the note modal offers only Deny when approving is not allowed", () => {
    const modal = renderNoteModal({ messageRowId: "m1", title: "t", environment: { name: "P", kind: "production" }, approveAllowed: false, initial: "approve" }) as any;
    const radios = modal.blocks.find((b: any) => b.block_id === "decision").element;
    expect(radios.options.map((o: any) => o.value)).toEqual(["deny"]);
    expect(radios.initial_option.value).toBe("deny");
    expect(modal.private_metadata).toBe("m1");
  });
});
