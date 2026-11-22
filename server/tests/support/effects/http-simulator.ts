import { randomBytes } from "node:crypto";

export type HttpFault =
  | "lose_response_after_commit"
  | "timeout_before_commit"
  | "connect_refused"
  | "http_500_after_commit"
  | "http_500_before_commit"
  | "hide_from_read";

export const HTTP_SIM_HOST = "api.mailer.example";
export const HTTP_SIM_TOKEN = "mlr_simulatorToken0000000000000000";

function networkError(code: string): Error {
  const error = new TypeError("fetch failed");
  (error as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return error;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export class HttpSimulator {
  readonly tokens = new Set<string>([HTTP_SIM_TOKEN]);
  readonly resources = new Map<string, Record<string, unknown>>();
  readonly locked = new Set<string>();
  readonly hosts: string[] = [];
  readonly requests: Array<{ method: string; path: string; authorization: string; body: string }> = [];
  readonly faults: { write: HttpFault[]; lookup: HttpFault[] } = { write: [], lookup: [] };
  writes = 0;

  fault(where: "write" | "lookup", fault: HttpFault) {
    this.faults[where].push(fault);
    return this;
  }

  resource(collection: string, id: string) {
    return this.resources.get(`${collection}/${id}`);
  }

  externalWrite(collection: string, id: string, fields: Record<string, unknown>) {
    this.resources.set(`${collection}/${id}`, { id, ...fields });
    return this;
  }

  fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> => {
    const u = new URL(url);
    this.hosts.push(u.hostname);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const method = (init.method ?? "GET").toUpperCase();
    this.requests.push({ method, path: u.pathname, authorization: headers.authorization ?? "", body: init.body ?? "" });
    if (!this.tokens.has((headers.authorization ?? "").replace(/^Bearer /, ""))) return json(401, { error: "invalid_token" });

    const m = /^\/v1\/([a-z_]+)(?:\/([^/]+))?$/.exec(u.pathname);
    if (!m) return json(404, { error: "not_found" });
    const collection = m[1];
    const id = m[2] === undefined ? null : decodeURIComponent(m[2]);

    if (method === "GET" && id !== null) {
      const fault = this.faults.lookup.shift();
      const found = fault === "hide_from_read" ? undefined : this.resource(collection, id);
      return found ? json(200, found) : json(404, { error: "not_found" });
    }
    if (method === "POST" && id === null) return this.write(collection, `msg_${randomBytes(6).toString("hex")}`, init.body ?? "", 201);
    if (method === "PUT" && id !== null) return this.write(collection, id, init.body ?? "", 200);
    return json(405, { error: "method_not_allowed" });
  };

  private write(collection: string, id: string, body: string, status: number): Response {
    const fault = this.faults.write.shift();
    if (fault === "connect_refused") throw networkError("ECONNREFUSED");
    if (fault === "timeout_before_commit") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (fault === "http_500_before_commit") return json(500, { error: "internal" });
    if (this.locked.has(collection) || this.locked.has(`${collection}/${id}`)) return json(409, { error: "locked" });
    let fields: unknown;
    try {
      fields = JSON.parse(body);
    } catch {
      return json(400, { error: "invalid_json" });
    }
    if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return json(422, { error: "invalid_body" });
    const resource = { ...(fields as Record<string, unknown>), id, status: "sent" };
    this.resources.set(`${collection}/${id}`, resource);
    this.writes++;
    if (fault === "lose_response_after_commit") throw networkError("ECONNRESET");
    if (fault === "http_500_after_commit") return json(500, { error: "internal" });
    return json(status, resource);
  }
}
