import { createHash } from "node:crypto";
import type { ImpactQuantity, PreviewBlock } from "../effects/adapter.ts";

export const ACTION_APPROVE = "anlyon_approve";
export const ACTION_DENY = "anlyon_deny";
export const ACTION_NOTE = "anlyon_note";
export const ACTION_OPEN = "anlyon_open";
export const NOTE_VIEW_CALLBACK = "anlyon_decision_note";
export const NOTE_BLOCK = "note";
export const NOTE_INPUT = "note_input";
export const DECISION_BLOCK = "decision";
export const DECISION_INPUT = "decision_input";
export const NOTE_MAX_LENGTH = 1000;

const SECTION_MAX = 2900;
const FIELD_MAX = 1900;
const DIFF_MAX = 1200;
const MAX_BLOCKS = 48;

export interface PreviewModel {
  id: string;
  blocks: PreviewBlock[];
  allowances: Array<Record<string, unknown>>;
  bindingDigest: string;
  expiresAt: Date;
}

export interface VoteModel {
  decision: "approve" | "deny";
  by: string;
  selfApproved?: boolean;
  at: Date;
}

export const SELF_APPROVED_NOTE = "Self-approved (only approver in this environment)";

export interface ApprovalMessageModel {
  approval: {
    approvalId: string;
    kind: string;
    status: "pending" | "approved" | "denied" | "expired";
    title: string;
    description: string | null;
    payload: Record<string, unknown>;
    requiredApprovals: number;
    approvedCount: number;
    expiresAt: Date;
    decidedAt: Date | null;
    decisionNote: string | null;
    bindingDigest: string | null;
  };
  environment: { name: string; kind: string };
  preview: PreviewModel | null;
  previewMissing: boolean;
  votes: VoteModel[];
  decidedBy: string | null;
  consoleUrl: string;
  now: Date;
}

type Block = Record<string, unknown>;

export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function code(text: string): string {
  return `\`${escapeMrkdwn(text).replace(/`/g, "ˋ")}\``;
}

function codeBlock(text: string): string {
  return `\`\`\`${escapeMrkdwn(text).replace(/```/g, "ˋˋˋ")}\`\`\``;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function plain(text: string, max = 150) {
  return { type: "plain_text", text: truncate(text, max), emoji: false };
}

function mrkdwn(text: string, max = SECTION_MAX) {
  return { type: "mrkdwn", text: truncate(text, max) };
}

function section(text: string): Block {
  return { type: "section", text: mrkdwn(text) };
}

function context(text: string): Block {
  return { type: "context", elements: [mrkdwn(text)] };
}

export function slackDate(date: Date): string {
  const seconds = Math.floor(date.getTime() / 1000);
  return `<!date^${seconds}^{date_short_pretty} at {time}|${date.toISOString()}>`;
}

const LIMITATION_LABEL: Record<string, string> = {
  guarantee: "Supported",
  freshness: "Not protected",
  unsupported: "Not supported",
  irreversible: "Irreversible",
};

export function formatQuantity(q: ImpactQuantity): string {
  const bound = q.bound === "upper_bound" ? "up to " : "";
  if (q.dimension === "money") return `${bound}${(q.amount / 100).toFixed(2)} ${(q.currency ?? "").toUpperCase()}`.trim();
  if (q.dimension === "resource_mutations") return `${bound}${q.amount} resource change${q.amount === 1 ? "" : "s"}`;
  return `${bound}${q.amount} ${q.dimension}`;
}

export function formatAllowance(a: Record<string, unknown>): string {
  return a.blocked
    ? `Blocked: ${String(a.message)}`
    : `${String(a.name)}: needs ${String(a.requested)}, ${String(a.available)} available${a.sufficient ? "" : " (not enough)"}`;
}

function previewBlock(block: PreviewBlock): Block[] {
  switch (block.type) {
    case "fields": {
      const out: Block[] = [];
      for (let i = 0; i < block.fields.length; i += 10) {
        out.push({
          type: "section",
          ...(i === 0 ? { text: mrkdwn(`*${escapeMrkdwn(block.title)}*`) } : {}),
          fields: block.fields.slice(i, i + 10).map((f) =>
            mrkdwn(`*${escapeMrkdwn(f.label)}*\n${escapeMrkdwn(truncate(f.value, 600))}`, FIELD_MAX)),
        });
      }
      return out;
    }
    case "text_diff":
      return [
        section(`*${escapeMrkdwn(block.title)}*: ${code(block.path)}`),
        section(`Current content\n${codeBlock(truncate(block.before || "(empty)", DIFF_MAX))}`),
        section(`Content after the change\n${codeBlock(truncate(block.after || "(empty)", DIFF_MAX))}`),
        ...(block.truncated || block.before.length > DIFF_MAX || block.after.length > DIFF_MAX
          ? [context("Shown truncated. The full change is in the preview in Anlyon.")]
          : []),
      ];
    case "impact":
      return [section(`*Expected impact*\n${block.quantities.map((q) => escapeMrkdwn(formatQuantity(q))).join(" · ")}`)];
    case "limitations":
      return [section([
        `*${escapeMrkdwn(block.title)}*`,
        ...block.items.map((item) => `${code(LIMITATION_LABEL[item.kind] ?? item.kind)} ${escapeMrkdwn(item.text)}`),
      ].join("\n"))];
    default:
      return [];
  }
}

export function payloadFields(
  kind: string,
  payload: Record<string, unknown>,
  { maxDepth = 3, maxFields = 40 } = {},
): { fields: Array<{ key: string; value: string }>; truncated: boolean } {
  const source = kind === "action" && "input" in payload ? payload.input : (payload as unknown);
  const fields: Array<{ key: string; value: string }> = [];
  let truncated = false;
  const walk = (value: unknown, path: string, depth: number) => {
    if (fields.length >= maxFields) {
      truncated = true;
      return;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value) && depth < maxDepth) {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0 && path) fields.push({ key: path, value: "{}" });
      for (const [k, v] of entries) walk(v, path ? `${path}.${k}` : k, depth + 1);
      return;
    }
    if (!path) {
      fields.push({ key: "value", value: JSON.stringify(value) ?? "null" });
      return;
    }
    fields.push({ key: path, value: typeof value === "string" ? value : (JSON.stringify(value) ?? "null") });
  };
  if (source !== undefined) walk(source, "", 0);
  return { fields, truncated };
}

function requestBlocks(model: ApprovalMessageModel): Block[] {
  const { approval } = model;
  const out: Block[] = [];
  if (approval.kind === "action") {
    const method = typeof approval.payload.method === "string" ? approval.payload.method : null;
    const url = typeof approval.payload.urlTemplate === "string" ? approval.payload.urlTemplate : null;
    if (method || url) out.push(section(`*Request*\n${code(`${method ?? ""} ${url ?? ""}`.trim())}`));
  }
  if (approval.kind === "function_plan") return planBlocks(approval.payload);
  const { fields, truncated } = payloadFields(approval.kind, approval.payload);
  if (fields.length > 0) {
    const title = approval.kind === "action" ? "*Input*" : "*Details*";
    const lines: string[] = [];
    let length = title.length;
    let cut = truncated;
    for (const f of fields) {
      const line = `${escapeMrkdwn(f.key)}: ${code(truncate(f.value, 300))}`;
      if (length + line.length + 1 > SECTION_MAX - 80) {
        cut = true;
        break;
      }
      lines.push(line);
      length += line.length + 1;
    }
    out.push(section([title, ...lines].join("\n")));
    if (cut) out.push(context("Some fields are not shown. The full request is in Anlyon."));
  }
  return out;
}

function planBlocks(payload: Record<string, unknown>): Block[] {
  const writes = Array.isArray(payload.writes) ? (payload.writes as Array<{ action?: unknown; input?: unknown }>) : [];
  const lines: string[] = [];
  let length = 0;
  let cut = false;
  for (const [index, write] of writes.entries()) {
    const line = `${index + 1}. ${code(String(write.action ?? ""))} ${code(truncate(JSON.stringify(write.input ?? null) ?? "null", 300))}`;
    if (length + line.length + 1 > SECTION_MAX - 80) {
      cut = true;
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  const out: Block[] = [section(["*Writes, in this order*", ...lines].join("\n"))];
  if (cut) out.push(context("Some writes are not shown. The full plan is in Anlyon."));
  return out;
}

const STATUS_HEADER: Record<ApprovalMessageModel["approval"]["status"], string> = {
  pending: "Approval needed",
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
};

export function approveGate(model: ApprovalMessageModel): { ok: true } | { ok: false; reason: string } {
  const { approval, preview } = model;
  if (model.previewMissing) {
    return { ok: false, reason: "The preview this approval is bound to could not be loaded, so it cannot be approved here. Review it in Anlyon. Deny is always available." };
  }
  if (!preview) return { ok: true };
  if (approval.bindingDigest && preview.bindingDigest !== approval.bindingDigest) {
    return { ok: false, reason: "The loaded preview is not the one this approval is bound to. Review it in Anlyon." };
  }
  if (preview.expiresAt.getTime() <= model.now.getTime()) {
    return { ok: false, reason: `This preview expired ${slackDate(preview.expiresAt)}. It can no longer execute. A new preview and approval are required.` };
  }
  return { ok: true };
}

export function renderApprovalMessage(model: ApprovalMessageModel): { text: string; blocks: Block[] } {
  const { approval, environment, preview } = model;
  const production = environment.kind === "production";
  const blocks: Block[] = [];

  blocks.push({ type: "header", text: plain(`${STATUS_HEADER[approval.status]}: ${approval.title}`) });
  blocks.push(section(
    `${production ? ":rotating_light: " : ""}Executes in *${escapeMrkdwn(environment.name)}* (${escapeMrkdwn(environment.kind)}${production ? ", a production environment" : ""})`,
  ));

  const actionName = typeof approval.payload.actionName === "string" ? approval.payload.actionName : null;
  blocks.push({
    type: "section",
    fields: [
      approval.kind === "function_plan"
        ? mrkdwn(`*Function*\n${code(String(approval.payload.functionName ?? ""))}`)
        : mrkdwn(`*${approval.kind === "action" ? "Action" : "Request"}*\n${actionName ? code(actionName) : "Custom request"}`),
      mrkdwn(`*Approvals*\n${approval.approvedCount} of ${approval.requiredApprovals}`),
      mrkdwn(`*Expires*\n${slackDate(approval.expiresAt)}`),
      mrkdwn(`*Approval*\n${code(approval.approvalId)}`),
    ],
  });
  if (approval.description) blocks.push(section(escapeMrkdwn(truncate(approval.description, 1500))));

  if (preview) {
    for (const block of preview.blocks) blocks.push(...previewBlock(block));
    if (preview.allowances.length > 0) {
      blocks.push(section([`*Impact limits at review time*`, ...preview.allowances.map((a) => escapeMrkdwn(formatAllowance(a)))].join("\n")));
      blocks.push(context("Rechecked immediately before dispatch."));
    }
  } else {
    blocks.push(...requestBlocks(model));
  }

  if (approval.status === "pending") {
    const gate = approveGate(model);
    if (!gate.ok) blocks.push(section(`:warning: ${gate.reason}`));
    if (model.votes.length > 0) {
      blocks.push(context(`Votes so far: ${model.votes.map((v) => `${v.decision === "approve" ? "approved" : "denied"} by ${v.by}${v.selfApproved ? ` (${SELF_APPROVED_NOTE})` : ""} ${slackDate(v.at)}`).join("; ")}`));
    }
  }

  if (blocks.length > MAX_BLOCKS - 4) {
    blocks.length = MAX_BLOCKS - 5;
    blocks.push(context("This request is too long to show in full here. Review the rest in Anlyon."));
  }

  blocks.push({ type: "divider" });
  const reviewUrl = `${model.consoleUrl}/approvals?id=${encodeURIComponent(approval.approvalId)}`;

  if (approval.status === "pending") {
    const gate = approveGate(model);
    const value = approval.approvalId;
    const elements: Block[] = [];
    if (gate.ok) {
      elements.push({
        type: "button",
        action_id: ACTION_APPROVE,
        style: "primary",
        text: plain("Approve", 75),
        value,
        confirm: {
          title: plain("Approve this request?", 100),
          text: mrkdwn(`It executes in *${escapeMrkdwn(environment.name)}* (${escapeMrkdwn(environment.kind)}).`, 300),
          confirm: plain("Approve", 30),
          deny: plain("Cancel", 30),
          ...(production ? { style: "danger" } : {}),
        },
      });
    }
    elements.push({ type: "button", action_id: ACTION_DENY, style: "danger", text: plain("Deny", 75), value });
    elements.push({ type: "button", action_id: ACTION_NOTE, text: plain("Decide with a note", 75), value });
    elements.push({ type: "button", action_id: ACTION_OPEN, text: plain("Open in Anlyon", 75), url: reviewUrl });
    blocks.push({ type: "actions", block_id: "decision", elements });
  } else {
    blocks.push(section(outcomeLine(model)));
    if (approval.decisionNote) blocks.push(section(`>${escapeMrkdwn(truncate(approval.decisionNote, NOTE_MAX_LENGTH)).replace(/\n/g, "\n>")}`));
    blocks.push({ type: "actions", block_id: "open", elements: [{ type: "button", action_id: ACTION_OPEN, text: plain("Open in Anlyon", 75), url: reviewUrl }] });
  }

  const tail = [
    preview ? `Binding ${preview.bindingDigest.slice(0, 16)}…` : null,
    preview ? `preview ${code(preview.id)}` : null,
  ].filter(Boolean);
  if (tail.length > 0) blocks.push(context(tail.join(" · ")));

  return {
    text: truncate(escapeMrkdwn(`${STATUS_HEADER[approval.status]}: ${approval.title} (${environment.name})`), 3000),
    blocks,
  };
}

function outcomeLine(model: ApprovalMessageModel): string {
  const { approval } = model;
  const at = approval.decidedAt ? ` ${slackDate(approval.decidedAt)}` : "";
  if (approval.status === "expired") return `:hourglass: *Expired*${at}. Nobody decided it in time; it can no longer execute.`;
  const verb = approval.status === "approved" ? ":white_check_mark: *Approved*" : ":no_entry: *Denied*";
  return `${verb}${model.decidedBy ? ` by ${model.decidedBy}` : ""}${at}.`;
}

export function renderingDigest(message: { text: string; blocks: unknown[] }): string {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}

export function renderNoteModal(input: {
  messageRowId: string;
  title: string;
  environment: { name: string; kind: string };
  approveAllowed: boolean;
  initial: "approve" | "deny";
}): Block {
  const option = (value: "approve" | "deny") => ({
    text: plain(value === "approve" ? "Approve" : "Deny", 75),
    value,
  });
  const options = input.approveAllowed ? [option("approve"), option("deny")] : [option("deny")];
  const initial = input.approveAllowed ? option(input.initial) : option("deny");
  return {
    type: "modal",
    callback_id: NOTE_VIEW_CALLBACK,
    private_metadata: input.messageRowId,
    title: plain("Decide with a note", 24),
    submit: plain("Submit", 24),
    close: plain("Cancel", 24),
    blocks: [
      section(`*${escapeMrkdwn(truncate(input.title, 200))}*\nExecutes in *${escapeMrkdwn(input.environment.name)}* (${escapeMrkdwn(input.environment.kind)})`),
      {
        type: "input",
        block_id: DECISION_BLOCK,
        label: plain("Decision", 2000),
        element: { type: "radio_buttons", action_id: DECISION_INPUT, options, initial_option: initial },
      },
      {
        type: "input",
        block_id: NOTE_BLOCK,
        optional: true,
        label: plain("Note", 2000),
        element: {
          type: "plain_text_input",
          action_id: NOTE_INPUT,
          multiline: true,
          max_length: NOTE_MAX_LENGTH,
          placeholder: plain("Why you decided this way. Recorded with your decision.", 150),
        },
      },
    ],
  };
}
