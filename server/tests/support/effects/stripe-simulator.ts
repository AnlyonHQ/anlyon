import { randomBytes } from "node:crypto";

export type StripeFault =
  | "lose_response_after_commit"
  | "timeout_before_commit"
  | "connect_refused"
  | "http_500_after_commit"
  | "http_500_before_commit"
  | "pending"
  | "hide_from_list"
  | "account_unreachable";

export interface SimRefund {
  id: string;
  object: "refund";
  amount: number;
  currency: string;
  payment_intent: string;
  status: "pending" | "succeeded" | "failed" | "canceled";
  reason: string | null;
  metadata: Record<string, string>;
  failure_reason: string | null;
  created: number;
}

function networkError(code: string): Error {
  const error = new TypeError("fetch failed");
  (error as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return error;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export class StripeSimulator {
  accountId = "acct_simTest001";
  readonly keys = new Set<string>(["sk_test_simulator_key_0000000000"]);
  readonly paymentIntents = new Map<string, { id: string; currency: string; amount_received: number; livemode: boolean }>();
  readonly refunds: SimRefund[] = [];
  readonly idempotency = new Map<string, { params: string; status: number; body: unknown }>();
  readonly hosts: string[] = [];
  readonly faults: { write: StripeFault[]; lookup: StripeFault[]; preflight: StripeFault[] } = { write: [], lookup: [], preflight: [] };
  writes = 0;

  addPaymentIntent(id: string, amount: number, currency = "usd") {
    this.paymentIntents.set(id, { id, currency, amount_received: amount, livemode: false });
    return this;
  }

  fault(where: "write" | "lookup" | "preflight", fault: StripeFault) {
    this.faults[where].push(fault);
    return this;
  }

  settle(refundId: string, status: "succeeded" | "failed") {
    const refund = this.refunds.find((r) => r.id === refundId);
    if (!refund) throw new Error(`no refund ${refundId}`);
    refund.status = status;
    if (status === "failed") refund.failure_reason = "lost_or_stolen_card";
  }

  refundedOn(pi: string) {
    return this.refunds.filter((r) => r.payment_intent === pi && r.status !== "failed" && r.status !== "canceled")
      .reduce((sum, r) => sum + r.amount, 0);
  }

  fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> => {
    const u = new URL(url);
    this.hosts.push(u.hostname);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const token = (headers.authorization ?? "").replace(/^Bearer /, "");
    if (!this.keys.has(token)) return json(401, { error: { type: "invalid_request_error", message: "Invalid API Key provided" } });
    const method = (init.method ?? "GET").toUpperCase();

    if (method === "GET" && u.pathname === "/v1/account") {
      if (this.faults.preflight.shift() === "account_unreachable") throw networkError("ECONNREFUSED");
      return json(200, { id: this.accountId, object: "account" });
    }

    if (method === "GET" && u.pathname.startsWith("/v1/payment_intents/")) {
      const pi = this.paymentIntents.get(decodeURIComponent(u.pathname.split("/").pop()!));
      if (!pi) return json(404, { error: { type: "invalid_request_error", code: "resource_missing" } });
      return json(200, {
        ...pi, object: "payment_intent", status: "succeeded",
        latest_charge: { id: `ch_${pi.id}`, amount_refunded: this.refundedOn(pi.id) },
      });
    }

    if (method === "GET" && u.pathname.startsWith("/v1/refunds/")) {
      const refund = this.refunds.find((r) => r.id === decodeURIComponent(u.pathname.split("/").pop()!));
      return refund ? json(200, refund) : json(404, { error: { code: "resource_missing" } });
    }

    if (method === "GET" && u.pathname === "/v1/refunds") {
      const fault = this.faults.lookup.shift();
      const pi = u.searchParams.get("payment_intent");
      const data = fault === "hide_from_list" ? [] : this.refunds.filter((r) => !pi || r.payment_intent === pi);
      return json(200, { object: "list", data: [...data].reverse(), has_more: false });
    }

    if (method === "POST" && u.pathname === "/v1/refunds") return this.createRefund(headers, init.body ?? "");

    return json(404, { error: { type: "invalid_request_error", message: `Unrecognized request URL (${method}: ${u.pathname})` } });
  };

  private async createRefund(headers: Record<string, string>, body: string): Promise<Response> {
    const fault = this.faults.write.shift();
    if (fault === "connect_refused") throw networkError("ECONNREFUSED");
    if (fault === "timeout_before_commit") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (fault === "http_500_before_commit") return json(500, { error: { type: "api_error", message: "An unknown error occurred" } });

    const key = headers["idempotency-key"];
    if (key && this.idempotency.has(key)) {
      const seen = this.idempotency.get(key)!;
      if (seen.params !== body) {
        return json(400, { error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters they were first used with." } });
      }
      return json(seen.status, seen.body);
    }

    const params = new URLSearchParams(body);
    const piId = params.get("payment_intent") ?? "";
    const pi = this.paymentIntents.get(piId);
    const amount = Number(params.get("amount"));
    let status = 200;
    let result: unknown;
    if (!pi) {
      status = 400;
      result = { error: { type: "invalid_request_error", code: "resource_missing", message: `No such payment_intent: '${piId}'` } };
    } else if (amount > pi.amount_received - this.refundedOn(piId)) {
      status = 400;
      result = { error: { type: "invalid_request_error", code: "amount_too_large", message: "Refund amount is greater than unrefunded amount on charge" } };
    } else {
      const metadata: Record<string, string> = {};
      for (const [k, v] of params) {
        const m = /^metadata\[(.+)\]$/.exec(k);
        if (m) metadata[m[1]] = v;
      }
      const refund: SimRefund = {
        id: `re_${randomBytes(8).toString("hex")}`,
        object: "refund",
        amount,
        currency: pi.currency,
        payment_intent: piId,
        status: fault === "pending" ? "pending" : "succeeded",
        reason: params.get("reason"),
        metadata,
        failure_reason: null,
        created: Math.floor(Date.now() / 1000),
      };
      this.refunds.push(refund);
      this.writes++;
      result = refund;
    }
    if (key) this.idempotency.set(key, { params: body, status, body: result });
    if (fault === "lose_response_after_commit") throw networkError("ECONNRESET");
    if (fault === "http_500_after_commit") return json(500, { error: { type: "api_error", message: "An unknown error occurred" } });
    return json(status, result);
  }
}
