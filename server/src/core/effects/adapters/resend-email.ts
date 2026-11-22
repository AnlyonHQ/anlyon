import { createHash } from "node:crypto";
import { ValidationError } from "../../../utils/errors.ts";
import type {
  AdapterContext,
  DispatchRequest,
  EffectAdapter,
  EvidenceDraft,
  Interpretation,
  Observation,
  PreviewDraft,
  ReconcileRequest,
  VerifyRequest,
  VerifyResult,
} from "../adapter.ts";
import { TransportError } from "../transport.ts";

export interface ResendEmailConfig {
  domain: string;
  fromAddresses: string[] | null;
}

interface ResendEmailRequest {
  domain: string;
  from: string;
  fromAddress: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  html: string | null;
  text: string | null;
}

const API = "https://api.resend.com";
export const RESEND_IDEMPOTENCY_RETENTION_SECONDS = 24 * 60 * 60;
export const RESEND_MAX_TO = 50;
export const RESEND_MAX_COPY = 50;
export const RESEND_EFFECT_TAG = "anlyon_effect";
export const RESEND_LOOKUP_MAX_PAGES = 3;
export const RESEND_LOOKUP_MAX_CANDIDATES = 20;
const LOOKUP_SKEW_MS = 5 * 60_000;
export const RESEND_CONSISTENCY_WINDOW_MS = 120_000;
export const RESEND_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_SUBJECT = 998;
const MAX_BODY_BYTES = 256 * 1024;
const PREVIEW_TEXT_LIMIT = 4000;

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const FROM_WITH_NAME = /^([^<>"\r\n]{1,200}) <([^<>\s]+)>$/;
const TAG_VALUE = /^[A-Za-z0-9_-]{1,256}$/;
const NOT_SENT_EVENTS = ["failed", "canceled"];

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requestOf(operation: { request: Record<string, unknown> }): ResendEmailRequest {
  return operation.request as unknown as ResendEmailRequest;
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

function isAddress(value: string): boolean {
  return value.length <= 320 && ADDRESS.test(value);
}

function addressList(value: unknown, field: string, max: number, required: boolean): string[] {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${field} must be an array of 1 to ${max} email addresses.`);
    return [];
  }
  if (!Array.isArray(value) || value.length > max || (required && value.length === 0)) {
    throw new ValidationError(`${field} must be an array of ${required ? 1 : 0} to ${max} email addresses.`);
  }
  return value.map((item) => {
    const address = typeof item === "string" ? item.trim() : "";
    if (!isAddress(address)) throw new ValidationError(`${field} holds a value that is not an email address.`);
    return address;
  });
}

function body(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) throw new ValidationError(`${field} must be a non-empty string.`);
  if (Buffer.byteLength(value, "utf8") > MAX_BODY_BYTES) throw new ValidationError(`${field} exceeds ${MAX_BODY_BYTES} bytes.`);
  return value;
}

function parseFrom(value: unknown): { from: string; address: string } {
  const raw = typeof value === "string" ? value.trim() : "";
  const named = FROM_WITH_NAME.exec(raw);
  const address = named ? named[2] : raw;
  if (!isAddress(address)) throw new ValidationError("from must be an email address, or `Name <address>`.");
  return { from: named ? `${named[1].trim()} <${address}>` : address, address };
}

function parseCreatedAt(value: unknown): number | null {
  const raw = str(value);
  if (!raw) return null;
  const iso = raw.trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1").replace(/([+-]\d{2})$/, "$1:00");
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

function carriesEffectTag(email: Record<string, unknown>, effectId: string): boolean {
  return Array.isArray(email.tags) && email.tags.some((tag) => {
    const t = record(tag);
    return t.name === RESEND_EFFECT_TAG && t.value === effectId;
  });
}

function errorName(json: unknown): string | null {
  return str(record(json).name);
}

function unknownLookup(now: Date, summary: string, details: Record<string, unknown> = {}, providerIds: Record<string, string> = {}): Interpretation {
  return {
    outcome: "unknown",
    partialEffect: "none",
    providerReference: null,
    evidence: [{ source: "provider_lookup", observedAt: now, impliedOutcome: null, providerIds, summary, details }],
  };
}

function interpretFoundEmail(email: Record<string, unknown>, id: string, now: Date): Interpretation {
  const lastEvent = str(email.last_event);
  const notSent = lastEvent !== null && NOT_SENT_EVENTS.includes(lastEvent);
  return {
    outcome: notSent ? "failed" : "succeeded",
    partialEffect: "none",
    providerReference: id,
    ...(notSent
      ? { failureProof: { providerReference: id, summary: `Resend reports email ${id} as ${lastEvent}.` } }
      : { verified: true }),
    evidence: [{
      source: "provider_lookup",
      observedAt: now,
      impliedOutcome: notSent ? "failed" : "succeeded",
      providerIds: { emailId: id },
      summary: notSent
        ? `Resend holds email ${id} for this effect and reports it as ${lastEvent}. It was not sent.`
        : `Resend holds email ${id} for this effect. Its last event is ${lastEvent ?? "not reported"}. That is not proof of delivery.`,
      details: { lastEvent },
    }],
  };
}

const FULL_ACCESS_HINT = "Reading an email needs a Resend API key with full access. A sending access key cannot read.";

export const resendEmailAdapter: EffectAdapter<ResendEmailConfig> = {
  type: "resend.email_send",
  version: "1",
  title: "Resend email send",
  successDefinition:
    "Resend accepted the send and returned an email id. A read-back of that id that shows this effect's tag confirms it. Neither one means the email was delivered.",
  successEvidence: "response_status",
  hosts: ["api.resend.com"],
  maxResponseBytes: RESEND_MAX_RESPONSE_BYTES,
  capabilities: {
    idempotency: {
      supported: true,
      retentionSeconds: RESEND_IDEMPOTENCY_RETENTION_SECONDS,
      description:
        "Every write sends the effect's Idempotency-Key. Resend returns the first response for a repeated key with the same payload and sends nothing. Resend keeps keys for 24 hours. After that a repeat could send a second email.",
    },
    outcomeLookup: {
      supported: true,
      description:
        "By email id when the response arrived. After a lost response, by a bounded search: Resend has no lookup by idempotency key, so Anlyon lists recent sent emails and reads candidates by id for the anlyon_effect tag. Finding the email settles it. Not finding it proves nothing, so the effect stays unknown until a replay inside 24 hours or an operator resolves it. Reads need a full access API key.",
    },
    conditionalMutation: {
      supported: false,
      description: "Resend has no conditional send. Nothing about the recipients or the domain is checked atomically with the write.",
    },
    asynchronousCompletion: {
      supported: false,
      description: "Delivery happens after Resend accepts the email. Anlyon records acceptance and one read-back. It does not track delivery, bounces or complaints.",
    },
    compensation: {
      supported: false,
      actionHint: null,
      description: "A sent email cannot be recalled through the Resend API.",
    },
    sameKeyReplay: {
      supported: true,
      windowSeconds: RESEND_IDEMPOTENCY_RETENTION_SECONDS,
      description: "A lost response may be recovered by repeating the write under the same key within 24 hours. The repeat is a governed write.",
    },
    reversible: { supported: false, description: "A sent email cannot be unsent." },
    unsupported: [
      "Delivery to the inbox. Succeeded means Resend accepted the email, and confirmed means Resend holds it. Bounces, suppressions and spam complaints are not tracked",
      "Recall of a sent email",
      "Lookup by idempotency key. Resend retrieves an email by id only, so recovery after a lost response is a bounded search or a same-key replay",
      "Replay after 24 hours, when Resend no longer holds the idempotency key",
      "A sending access API key. The read-back and the lookup need full access",
      "Scheduled sends, attachments, templates, custom tags, custom headers and batch sends",
      "More than one sending domain per action",
    ],
    impactDimensions: ["emails"],
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["from", "to", "subject"],
    properties: {
      from: { type: "string", description: "An address on the action's sending domain, or `Name <address>`." },
      to: { type: "array", items: { type: "string" }, description: `1 to ${RESEND_MAX_TO} addresses.` },
      cc: { type: "array", items: { type: "string" } },
      bcc: { type: "array", items: { type: "string" } },
      replyTo: { type: "array", items: { type: "string" } },
      subject: { type: "string" },
      html: { type: "string" },
      text: { type: "string", description: "At least one of `html` and `text` is required." },
    },
  },

  parseConfig(raw) {
    const config = record(raw);
    const domain = str(config.domain)?.toLowerCase() ?? "";
    if (!DOMAIN.test(domain)) {
      throw new ValidationError("resend.email_send needs an explicit sending `domain`, for example `mail.example.com`. No account default is assumed.");
    }
    let fromAddresses: string[] | null = null;
    if (config.fromAddresses !== undefined && config.fromAddresses !== null) {
      if (!Array.isArray(config.fromAddresses) || config.fromAddresses.length === 0 || config.fromAddresses.length > 50) {
        throw new ValidationError("resend.email_send `fromAddresses` must be an array of 1 to 50 addresses on the sending domain.");
      }
      fromAddresses = config.fromAddresses.map((item) => {
        const address = typeof item === "string" ? item.trim().toLowerCase() : "";
        if (!isAddress(address) || domainOf(address) !== domain) {
          throw new ValidationError(`resend.email_send \`fromAddresses\` may only hold addresses on ${domain}.`);
        }
        return address;
      }).sort();
    }
    const extra = Object.keys(config).filter((key) => !["domain", "fromAddresses"].includes(key));
    if (extra.length) throw new ValidationError(`resend.email_send config does not accept: ${extra.join(", ")}`);
    return { domain, fromAddresses };
  },

  checkCredential(credential) {
    if (!/^re_[A-Za-z0-9_]{8,}$/.test(credential)) {
      throw new ValidationError("resend.email_send refuses a credential that is not a Resend API key (re_...).");
    }
  },

  authHeaders(credential) {
    return { Authorization: `Bearer ${credential}` };
  },

  normalize(config, input) {
    const allowed = ["from", "to", "cc", "bcc", "replyTo", "subject", "html", "text"];
    const extra = Object.keys(input).filter((key) => !allowed.includes(key));
    if (extra.length) throw new ValidationError(`This action does not accept: ${extra.join(", ")}.`);

    const { from, address } = parseFrom(input.from);
    if (domainOf(address) !== config.domain) throw new ValidationError(`This action sends from ${config.domain} only.`);
    if (config.fromAddresses && !config.fromAddresses.includes(address.toLowerCase())) {
      throw new ValidationError(`This action may not send from ${address}.`);
    }
    const to = addressList(input.to, "to", RESEND_MAX_TO, true);
    const cc = addressList(input.cc, "cc", RESEND_MAX_COPY, false);
    const bcc = addressList(input.bcc, "bcc", RESEND_MAX_COPY, false);
    const replyTo = addressList(input.replyTo, "replyTo", RESEND_MAX_COPY, false);
    const seen = new Set<string>();
    for (const recipient of [...to, ...cc, ...bcc]) {
      const key = recipient.toLowerCase();
      if (seen.has(key)) throw new ValidationError(`${recipient} is listed more than once across to, cc and bcc.`);
      seen.add(key);
    }
    const subject = typeof input.subject === "string" ? input.subject.trim() : "";
    if (!subject || subject.length > MAX_SUBJECT || /[\r\n]/.test(subject)) {
      throw new ValidationError(`subject must be 1 to ${MAX_SUBJECT} characters on one line.`);
    }
    const html = body(input.html, "html");
    const text = body(input.text, "text");
    if (html === null && text === null) throw new ValidationError("At least one of html and text is required.");

    const request: ResendEmailRequest = { domain: config.domain, from, fromAddress: address, to, cc, bcc, replyTo, subject, html, text };
    return {
      target: {
        account: config.domain,
        resourceType: "resend.email",
        resourceId: address,
        resourceKey: `resend:${config.domain}:from/${address.toLowerCase()}`,
        display: { "Sending domain": config.domain, From: from },
      },
      request: request as unknown as Record<string, unknown>,
    };
  },

  describeImpact(operation) {
    const request = requestOf(operation);
    return [{ dimension: "emails", amount: request.to.length + request.cc.length + request.bcc.length, bound: "exact" }];
  },

  async preparePreview(ctx, operation): Promise<PreviewDraft> {
    const request = requestOf(operation);
    const domains = await ctx.transport.request({ method: "GET", url: `${API}/domains` });
    if (domains.status === 401 || domains.status === 403) {
      throw new ValidationError(`Resend refused to list domains (HTTP ${domains.status}${errorName(domains.json) ? `, ${errorName(domains.json)}` : ""}). ${FULL_ACCESS_HINT}`);
    }
    const data = record(domains.json).data;
    if (domains.status !== 200 || !Array.isArray(data)) {
      throw new ValidationError(`Resend did not return the account's domains (HTTP ${domains.status}).`);
    }
    const domain = data.map(record).find((item) => str(item.name)?.toLowerCase() === ctx.config.domain);
    if (!domain) throw new ValidationError(`${ctx.config.domain} is not a domain on the Resend account this credential belongs to.`);
    const status = str(domain.status) ?? "unknown";
    const recipients = request.to.length + request.cc.length + request.bcc.length;
    const shownText = request.text === null ? null : request.text.slice(0, PREVIEW_TEXT_LIMIT);
    return {
      blocks: [{
        type: "fields",
        title: "Email",
        fields: [
          { label: "Sending domain", value: `${ctx.config.domain} (${status} at review)` },
          { label: "From", value: request.from },
          { label: "To", value: request.to.join(", ") },
          ...(request.cc.length ? [{ label: "Cc", value: request.cc.join(", ") }] : []),
          ...(request.bcc.length ? [{ label: "Bcc", value: request.bcc.join(", ") }] : []),
          ...(request.replyTo.length ? [{ label: "Reply-To", value: request.replyTo.join(", ") }] : []),
          { label: "Recipients", value: String(recipients) },
          { label: "Subject", value: request.subject },
          ...(shownText === null ? [] : [{
            label: "Text body",
            value: request.text !== null && request.text.length > PREVIEW_TEXT_LIMIT ? `${shownText} [truncated]` : shownText,
          }]),
          ...(request.html === null ? [] : [{
            label: "HTML body",
            value: `${Buffer.byteLength(request.html, "utf8")} bytes, sha256 ${createHash("sha256").update(request.html, "utf8").digest("hex")}`,
          }]),
        ],
      }],
      preconditions: { domain: ctx.config.domain, from: request.fromAddress.toLowerCase() },
      evidence: {
        source: "provider_lookup",
        observedAt: new Date(),
        impliedOutcome: null,
        providerIds: { domain: ctx.config.domain, ...(str(domain.id) ? { domainId: String(domain.id) } : {}) },
        summary: `Resend lists ${ctx.config.domain} with status ${status} at review.`,
        details: { status },
      },
    };
  },

  async dispatch(ctx, request: DispatchRequest): Promise<Observation> {
    const op = requestOf(request.operation);
    if (!TAG_VALUE.test(request.effectId)) {
      throw new TransportError("The effect id cannot be carried as a Resend tag. Nothing was sent", false);
    }
    if (request.idempotencyKey.length < 1 || request.idempotencyKey.length > 256) {
      throw new TransportError("The idempotency key is outside the 1 to 256 characters Resend accepts. Nothing was sent", false);
    }
    const response = await ctx.transport.request({
      method: "POST",
      url: `${API}/emails`,
      headers: { "Content-Type": "application/json", "Idempotency-Key": request.idempotencyKey },
      body: JSON.stringify({
        from: op.from,
        to: op.to,
        ...(op.cc.length ? { cc: op.cc } : {}),
        ...(op.bcc.length ? { bcc: op.bcc } : {}),
        ...(op.replyTo.length ? { reply_to: op.replyTo } : {}),
        subject: op.subject,
        ...(op.html !== null ? { html: op.html } : {}),
        ...(op.text !== null ? { text: op.text } : {}),
        tags: [{ name: RESEND_EFFECT_TAG, value: request.effectId }],
      }),
    });
    return { kind: "response", status: response.status, json: response.json, bodyText: response.bodyText, observedAt: new Date() };
  },

  interpret(_request, observation): Interpretation {
    if (observation.kind === "transport_error") {
      const outcome = observation.requestSent ? "unknown" : "failed";
      return {
        outcome,
        partialEffect: "none",
        providerReference: null,
        evidence: [{
          source: "system",
          observedAt: observation.observedAt,
          impliedOutcome: outcome,
          providerIds: {},
          summary: observation.requestSent
            ? "The send request may have reached Resend. No response was received."
            : "The send request never left Anlyon.",
          details: { error: observation.message },
        }],
      };
    }
    const json = record(observation.json);
    const id = str(json.id);
    if (observation.status >= 200 && observation.status < 300) {
      return {
        outcome: id ? "succeeded" : "unknown",
        partialEffect: "none",
        providerReference: id,
        evidence: [{
          source: "provider_response",
          observedAt: observation.observedAt,
          impliedOutcome: id ? "succeeded" : "unknown",
          providerIds: id ? { emailId: id } : {},
          summary: id
            ? `Resend accepted the email as ${id}. That is acceptance, not delivery.`
            : `Resend answered HTTP ${observation.status} without an email id. The email may or may not exist.`,
          details: { status: observation.status },
        }],
      };
    }
    const indeterminate = observation.status >= 500 || observation.status === 409;
    const name = errorName(observation.json);
    return {
      outcome: indeterminate ? "unknown" : "failed",
      partialEffect: "none",
      providerReference: null,
      evidence: [{
        source: "provider_response",
        observedAt: observation.observedAt,
        impliedOutcome: indeterminate ? "unknown" : "failed",
        providerIds: {},
        summary: indeterminate
          ? `Resend answered HTTP ${observation.status}${name ? ` (${name})` : ""}. The email may or may not have been sent.`
          : `Resend refused the send (HTTP ${observation.status}${name ? `, ${name}` : ""}).`,
        details: { status: observation.status, name, message: str(json.message)?.slice(0, 300) ?? null },
      }],
    };
  },

  async reconcile(ctx, request: ReconcileRequest): Promise<Interpretation> {
    const op = requestOf(request.operation);
    if (request.providerReference) {
      const read = await readEmail(ctx, request.providerReference);
      if (read.status !== 200 || str(read.email.id) !== request.providerReference) {
        return unknownLookup(request.now, `Email ${request.providerReference} could not be read (HTTP ${read.status}).${read.status === 401 ? ` ${FULL_ACCESS_HINT}` : ""}`,
          { status: read.status }, { emailId: request.providerReference });
      }
      if (!carriesEffectTag(read.email, request.effectId)) {
        return unknownLookup(request.now, `Email ${request.providerReference} does not carry this effect's tag, so it does not settle the outcome.`,
          {}, { emailId: request.providerReference });
      }
      return interpretFoundEmail(read.email, request.providerReference, request.now);
    }

    const since = (request.firstDispatchedAt ?? request.now).getTime() - LOOKUP_SKEW_MS;
    const candidates: string[] = [];
    let exhaustive = false;
    let after: string | null = null;
    for (let page = 0; page < RESEND_LOOKUP_MAX_PAGES; page++) {
      const list = await ctx.transport.request({
        method: "GET",
        url: `${API}/emails?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      });
      const items = record(list.json).data;
      if (list.status !== 200 || !Array.isArray(items)) {
        return unknownLookup(request.now, `Listing sent emails failed (HTTP ${list.status}).${list.status === 401 ? ` ${FULL_ACCESS_HINT}` : ""}`, { status: list.status });
      }
      let reachedOlder = false;
      for (const item of items.map(record)) {
        const createdAt = parseCreatedAt(item.created_at);
        if (createdAt !== null && createdAt < since) {
          reachedOlder = true;
          continue;
        }
        const id = str(item.id);
        if (id && item.subject === op.subject) candidates.push(id);
      }
      const last = items.length ? str(record(items[items.length - 1]).id) : null;
      if (reachedOlder || record(list.json).has_more !== true || !last) {
        exhaustive = true;
        break;
      }
      after = last;
    }

    const matches: Array<{ id: string; email: Record<string, unknown> }> = [];
    const toRead = candidates.slice(0, RESEND_LOOKUP_MAX_CANDIDATES);
    if (candidates.length > toRead.length) exhaustive = false;
    for (const id of toRead) {
      const read = await readEmail(ctx, id);
      if (read.status === 401 || read.status === 403) {
        return unknownLookup(request.now, `Resend refused to read email ${id} (HTTP ${read.status}). ${FULL_ACCESS_HINT}`, { status: read.status });
      }
      if (read.status !== 200) {
        exhaustive = false;
        continue;
      }
      if (carriesEffectTag(read.email, request.effectId)) matches.push({ id, email: read.email });
    }

    if (matches.length > 1) {
      return {
        outcome: "unknown",
        partialEffect: "possible",
        providerReference: null,
        evidence: [{
          source: "provider_lookup",
          observedAt: request.now,
          impliedOutcome: "unknown",
          providerIds: Object.fromEntries(matches.map((match, i) => [`email${i + 1}`, match.id])),
          summary: `${matches.length} emails carry this effect's tag. The evidence is contradictory. An operator must investigate.`,
          details: { emails: matches.map((match) => ({ id: match.id, lastEvent: str(match.email.last_event) })) },
        }],
      };
    }
    if (matches.length === 1) return interpretFoundEmail(matches[0].email, matches[0].id, request.now);

    const dispatchedAt = request.firstDispatchedAt?.getTime() ?? request.now.getTime();
    const pastWindow = request.now.getTime() >= dispatchedAt + RESEND_CONSISTENCY_WINDOW_MS;
    return unknownLookup(
      request.now,
      !exhaustive
        ? "No email carrying this effect's tag was found, and the search stopped at its bound. The outcome stays unknown."
        : pastWindow
          ? "No sent email carries this effect's tag. That does not prove none was sent, so the outcome stays unknown."
          : "No sent email carrying this effect's tag is visible yet. Resend may not have listed it.",
      { exhaustive, candidatesRead: toRead.length, maxPages: RESEND_LOOKUP_MAX_PAGES, maxCandidates: RESEND_LOOKUP_MAX_CANDIDATES },
    );
  },

  async verify(ctx, request: VerifyRequest): Promise<VerifyResult> {
    const noMatch = (source: EvidenceDraft["source"], summary: string, details: Record<string, unknown>, id: string | null): VerifyResult => ({
      matched: false,
      evidence: [{ source, observedAt: request.now, impliedOutcome: null, providerIds: id ? { emailId: id } : {}, summary, details }],
    });
    const id = str(record(request.response).id);
    if (!id) return noMatch("system", "The read-back could not be built: the response carried no email id. The result stays acknowledged.", {}, null);
    let read: Awaited<ReturnType<typeof readEmail>>;
    try {
      read = await readEmail(ctx, id);
    } catch (error) {
      return noMatch("system", "The read-back could not be completed. The result stays acknowledged.",
        { error: error instanceof Error ? error.message.slice(0, 300) : "error" }, id);
    }
    if (read.status !== 200 || str(read.email.id) !== id) {
      return noMatch("provider_lookup",
        `Resend did not return email ${id} (HTTP ${read.status}). The result stays acknowledged.${read.status === 401 ? ` ${FULL_ACCESS_HINT}` : ""}`,
        { status: read.status }, id);
    }
    if (!carriesEffectTag(read.email, request.effectId)) {
      return noMatch("provider_lookup", `Email ${id} does not carry this effect's tag. The result stays acknowledged.`, {}, id);
    }
    const lastEvent = str(read.email.last_event);
    if (lastEvent !== null && NOT_SENT_EVENTS.includes(lastEvent)) {
      return noMatch("provider_lookup", `Resend reports email ${id} as ${lastEvent}. The result stays acknowledged and is not confirmed.`, { lastEvent }, id);
    }
    return {
      matched: true,
      evidence: [{
        source: "provider_lookup",
        observedAt: request.now,
        impliedOutcome: "succeeded",
        providerIds: { emailId: id },
        summary: `The read-back matched. Resend holds email ${id} for this effect. Its last event is ${lastEvent ?? "not reported"}. That is not proof of delivery.`,
        details: { lastEvent },
      }],
    };
  },
};

async function readEmail(ctx: AdapterContext<ResendEmailConfig>, id: string): Promise<{ status: number; email: Record<string, unknown> }> {
  const response = await ctx.transport.request({ method: "GET", url: `${API}/emails/${encodeURIComponent(id)}` });
  return { status: response.status, email: record(response.json) };
}
