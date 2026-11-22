import { randomUUID } from "node:crypto";

export type ResendFault =
  | "lose_response_after_commit"
  | "timeout_before_commit"
  | "connect_refused"
  | "http_500_after_commit"
  | "http_500_before_commit"
  | "hide_from_list"
  | "hide_from_read";

export const RESEND_SIM_KEY = "re_simulator_fixture";
export const RESEND_SIM_SENDING_KEY = "re_simulatorSendOnly_00000000000";
export const RESEND_SIM_DOMAIN = "mail.anlyon-sim.dev";
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60_000;

export interface SimEmail {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to: string[];
  subject: string;
  html: string | null;
  text: string | null;
  tags: Array<{ name: string; value: string }>;
  last_event: string;
  createdAtMs: number;
}

function networkError(code: string): Error {
  const error = new TypeError("fetch failed");
  (error as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return error;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function problem(status: number, name: string, message: string): Response {
  return json(status, { statusCode: status, name, message });
}

function list(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stamp(ms: number): string {
  return `${new Date(ms).toISOString().replace("T", " ").replace("Z", "")}000+00`;
}

export class ResendSimulator {
  readonly keys = new Map<string, "full_access" | "sending_access">([
    [RESEND_SIM_KEY, "full_access"],
    [RESEND_SIM_SENDING_KEY, "sending_access"],
  ]);
  readonly domains = new Map<string, { id: string; name: string; status: string }>();
  readonly emails: SimEmail[] = [];
  readonly idempotency = new Map<string, { payload: string; status: number; body: unknown; at: number }>();
  readonly hosts: string[] = [];
  readonly requests: Array<{ method: string; path: string; idempotencyKey: string | null }> = [];
  readonly faults: { write: ResendFault[]; lookup: ResendFault[] } = { write: [], lookup: [] };
  writes = 0;
  private offsetMs = 0;

  constructor() {
    this.addDomain(RESEND_SIM_DOMAIN);
  }

  now() {
    return Date.now() + this.offsetMs;
  }

  advance(ms: number) {
    this.offsetMs += ms;
    return this;
  }

  addDomain(name: string, status = "verified") {
    this.domains.set(name, { id: randomUUID(), name, status });
    return this;
  }

  fault(where: "write" | "lookup", fault: ResendFault) {
    this.faults[where].push(fault);
    return this;
  }

  recipients() {
    return this.emails.reduce((sum, email) => sum + email.to.length + email.cc.length + email.bcc.length, 0);
  }

  setLastEvent(id: string, event: string) {
    const email = this.emails.find((e) => e.id === id);
    if (!email) throw new Error(`no email ${id}`);
    email.last_event = event;
  }

  externalEmail(fields: Partial<SimEmail> & { subject: string }) {
    const email: SimEmail = {
      id: randomUUID(), from: `noreply@${RESEND_SIM_DOMAIN}`, to: ["someone@example.com"], cc: [], bcc: [], reply_to: [],
      html: null, text: "x", tags: [], last_event: "delivered", createdAtMs: this.now(), ...fields,
    };
    this.emails.push(email);
    return email;
  }

  fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> => {
    const u = new URL(url);
    this.hosts.push(u.hostname);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const method = (init.method ?? "GET").toUpperCase();
    this.requests.push({ method, path: u.pathname, idempotencyKey: headers["idempotency-key"] ?? null });
    const token = (headers.authorization ?? "").replace(/^Bearer /, "");
    if (!token) return problem(401, "missing_api_key", "Missing API key in the authorization header.");
    const permission = this.keys.get(token);
    if (!permission) return problem(403, "invalid_api_key", "API key is invalid.");

    if (method === "POST" && u.pathname === "/emails") return this.send(headers, init.body ?? "");

    if (permission !== "full_access") return problem(401, "restricted_api_key", "This API key is restricted to only send emails.");

    if (method === "GET" && u.pathname === "/domains") {
      return json(200, {
        object: "list",
        has_more: false,
        data: [...this.domains.values()].map((d) => ({ id: d.id, name: d.name, status: d.status, created_at: stamp(0), region: "us-east-1" })),
      });
    }

    if (method === "GET" && u.pathname === "/emails") {
      const fault = this.faults.lookup.shift();
      const newestFirst = fault === "hide_from_list" ? [] : [...this.emails].reverse();
      const limit = Math.min(Math.max(Number(u.searchParams.get("limit") ?? 20) || 20, 1), 100);
      const after = u.searchParams.get("after");
      const start = after ? newestFirst.findIndex((e) => e.id === after) + 1 : 0;
      const page = newestFirst.slice(start, start + limit);
      return json(200, {
        object: "list",
        has_more: start + limit < newestFirst.length,
        data: page.map((e) => ({
          id: e.id, to: e.to, from: e.from, created_at: stamp(e.createdAtMs), subject: e.subject,
          bcc: e.bcc.length ? e.bcc : null, cc: e.cc.length ? e.cc : null, reply_to: e.reply_to.length ? e.reply_to : null,
          last_event: e.last_event, scheduled_at: null,
        })),
      });
    }

    if (method === "GET" && u.pathname.startsWith("/emails/")) {
      const fault = this.faults.lookup.shift();
      const id = decodeURIComponent(u.pathname.slice("/emails/".length));
      const email = fault === "hide_from_read" ? undefined : this.emails.find((e) => e.id === id);
      if (!email) return problem(404, "not_found", "Email not found");
      return json(200, {
        object: "email", id: email.id, to: email.to, from: email.from, created_at: stamp(email.createdAtMs), subject: email.subject,
        html: email.html, text: email.text, bcc: email.bcc, cc: email.cc, reply_to: email.reply_to,
        last_event: email.last_event, scheduled_at: null, tags: email.tags,
      });
    }

    return problem(404, "not_found", "The requested endpoint does not exist.");
  };

  private send(headers: Record<string, string>, body: string): Response {
    const fault = this.faults.write.shift();
    if (fault === "connect_refused") throw networkError("ECONNREFUSED");
    if (fault === "timeout_before_commit") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (fault === "http_500_before_commit") return problem(500, "application_error", "An unexpected error occurred.");

    const key = headers["idempotency-key"];
    if (key !== undefined) {
      if (key.length < 1 || key.length > 256) {
        return problem(400, "invalid_idempotency_key", "Idempotency keys, if present, must have between 1 and 256 characters.");
      }
      const seen = this.idempotency.get(key);
      if (seen && this.now() - seen.at < IDEMPOTENCY_RETENTION_MS) {
        if (seen.payload !== body) {
          return problem(409, "invalid_idempotent_request", "This idempotency key has been used on a request that had a different payload.");
        }
        return json(seen.status, seen.body);
      }
    }

    let fields: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      fields = parsed as Record<string, unknown>;
    } catch {
      return problem(400, "validation_error", "An error was found with one or more fields in the request.");
    }
    const from = typeof fields.from === "string" ? fields.from : "";
    const to = list(fields.to);
    let status = 200;
    let result: unknown;
    const address = /<([^>]+)>$/.exec(from)?.[1] ?? from;
    const domain = this.domains.get(address.slice(address.lastIndexOf("@") + 1).toLowerCase());
    if (!from || to.length === 0 || typeof fields.subject !== "string") {
      status = 422;
      result = { statusCode: 422, name: "missing_required_field", message: "The request body is missing one or more required fields." };
    } else if (to.length > 50) {
      status = 400;
      result = { statusCode: 400, name: "validation_error", message: "The `to` field must have 50 items or fewer." };
    } else if (!domain || domain.status !== "verified") {
      status = 403;
      result = { statusCode: 403, name: "validation_error", message: `The ${domain?.name ?? "sending"} domain is not verified.` };
    } else {
      const email: SimEmail = {
        id: randomUUID(),
        from,
        to,
        cc: list(fields.cc),
        bcc: list(fields.bcc),
        reply_to: list(fields.reply_to),
        subject: fields.subject,
        html: typeof fields.html === "string" ? fields.html : null,
        text: typeof fields.text === "string" ? fields.text : null,
        tags: Array.isArray(fields.tags)
          ? fields.tags.flatMap((tag) => {
              const t = (tag ?? {}) as Record<string, unknown>;
              return typeof t.name === "string" && typeof t.value === "string" ? [{ name: t.name, value: t.value }] : [];
            })
          : [],
        last_event: "sent",
        createdAtMs: this.now(),
      };
      this.emails.push(email);
      this.writes++;
      result = { id: email.id };
    }
    if (key !== undefined && status === 200) this.idempotency.set(key, { payload: body, status, body: result, at: this.now() });
    if (fault === "lose_response_after_commit") throw networkError("ECONNRESET");
    if (fault === "http_500_after_commit") return problem(500, "application_error", "An unexpected error occurred.");
    return json(status, result);
  }
}
