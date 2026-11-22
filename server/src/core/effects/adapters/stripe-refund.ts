import { ValidationError } from "../../../utils/errors.ts";
import { encodeFormBody } from "../../actions/form-encoding.ts";
import type {
  DispatchRequest,
  EffectAdapter,
  EvidenceDraft,
  Interpretation,
  Observation,
  PreviewDraft,
  ReconcileRequest,
} from "../adapter.ts";
import { TransportError } from "../transport.ts";

export interface StripeRefundConfig {
  account: string;
  mode: StripeMode;
  currency: string;
  faultDrill?: typeof FAULT_DRILLS[number];
}

export const FAULT_DRILLS = ["drop_response_after_send"] as const;
export const STRIPE_MODES = ["test", "live"] as const;
export type StripeMode = typeof STRIPE_MODES[number];

const API = "https://api.stripe.com";
const MAX_AMOUNT = 99_999_999;
export const STRIPE_CONSISTENCY_WINDOW_MS = 120_000;
export const STRIPE_IDEMPOTENCY_RETENTION_SECONDS = 24 * 60 * 60;
const REASONS = ["duplicate", "fraudulent", "requested_by_customer"] as const;

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function formatMinor(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()} (${amount} minor units)`;
}

function refundStatusOutcome(status: string | null): Interpretation["outcome"] {
  if (status === "succeeded") return "succeeded";
  if (status === "pending" || status === "requires_action") return "pending";
  if (status === "failed" || status === "canceled") return "failed";
  return "unknown";
}

function refundEvidence(
  source: EvidenceDraft["source"],
  refund: Record<string, unknown>,
  observedAt: Date,
  summary: string,
): EvidenceDraft {
  const status = str(refund.status);
  return {
    source,
    observedAt,
    impliedOutcome: refundStatusOutcome(status),
    providerIds: {
      ...(str(refund.id) ? { refundId: str(refund.id)! } : {}),
      ...(str(refund.payment_intent) ? { paymentIntent: str(refund.payment_intent)! } : {}),
    },
    summary,
    details: {
      status,
      amount: refund.amount ?? null,
      currency: refund.currency ?? null,
      failureReason: refund.failure_reason ?? null,
    },
  };
}

function interpretRefund(source: EvidenceDraft["source"], refund: Record<string, unknown>, observedAt: Date): Interpretation {
  const status = str(refund.status);
  const outcome = refundStatusOutcome(status);
  const id = str(refund.id);
  return {
    outcome,
    partialEffect: "none",
    providerReference: id,
    evidence: [refundEvidence(source, refund, observedAt, `Refund ${id ?? "?"} is ${status ?? "in an unrecognised state"}.`)],
    ...(outcome === "failed" && id ? { failureProof: { providerReference: id, summary: `Stripe reports refund ${id} as ${status}.` } } : {}),
  };
}

export const stripeRefundAdapter: EffectAdapter<StripeRefundConfig> = {
  type: "stripe.refund",
  version: "1",
  title: "Stripe refund",
  successDefinition: "A Stripe Refund carrying this effect's id reaches status `succeeded`.",
  successEvidence: "provider_record",
  hosts: ["api.stripe.com"],
  capabilities: {
    idempotency: {
      supported: true,
      retentionSeconds: STRIPE_IDEMPOTENCY_RETENTION_SECONDS,
      description:
        "Every write sends the effect's Idempotency-Key. Stripe returns the first result for a repeated key; keys may be pruned after 24 hours, after which a repeat could create a second refund.",
    },
    outcomeLookup: {
      supported: true,
      description:
        "Looked up by refund id, or by the anlyon_effect metadata listed on the payment intent. Finding the refund settles it. Not finding it proves nothing: metadata can be removed after the fact, so the effect stays unknown until a replay within the idempotency window or an operator resolves it.",
    },
    conditionalMutation: {
      supported: false,
      description:
        "Stripe has no conditional write on a payment intent. The account is re-checked immediately before dispatch but not atomically; the refundable amount shown is as of review. Stripe refuses a refund above what remains refundable when it executes.",
    },
    asynchronousCompletion: {
      supported: true,
      description: "A refund may be accepted as `pending` and finish later. Anlyon reads it back up to 12 times. After that it stays unresolved until an operator resolves it.",
    },
    compensation: {
      supported: false,
      actionHint: null,
      description: "A refund cannot be reversed through the Stripe API.",
    },
    sameKeyReplay: {
      supported: true,
      windowSeconds: STRIPE_IDEMPOTENCY_RETENTION_SECONDS,
      description: "A lost response may be recovered by repeating the write under the same key within 24 hours. The repeat is a governed write.",
    },
    reversible: { supported: false, description: "Refunds are irreversible." },
    unsupported: [
      "Atomic stale-state protection for the payment intent",
      "More than one currency per action",
      "Refunds without an explicit amount",
    ],
    impactDimensions: ["money", "resource_mutations"],
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["paymentIntent", "amount", "currency"],
    properties: {
      paymentIntent: { type: "string", pattern: "^pi_[A-Za-z0-9]{1,64}$" },
      amount: { type: "integer", description: "Exact integer minor units, e.g. 1250 for 12.50 USD." },
      currency: { type: "string", pattern: "^[a-z]{3}$" },
      reason: { type: "string", enum: [...REASONS] },
    },
  },

  parseConfig(raw) {
    const config = (raw ?? {}) as Record<string, unknown>;
    const account = str(config.account);
    if (!account || !/^acct_[A-Za-z0-9]{1,64}$/.test(account)) {
      throw new ValidationError("stripe.refund needs an explicit `account` (acct_...). Defaults are not resolved at execution time.");
    }
    if (!(STRIPE_MODES as readonly unknown[]).includes(config.mode)) {
      throw new ValidationError("stripe.refund needs an explicit `mode`: \"live\" or \"test\".");
    }
    const mode = config.mode as StripeMode;
    const currency = str(config.currency);
    if (!currency || !/^[a-z]{3}$/.test(currency)) {
      throw new ValidationError("stripe.refund needs one lowercase ISO currency, e.g. `usd`.");
    }
    const extra = Object.keys(config).filter((key) => !["account", "mode", "currency", "faultDrill"].includes(key));
    if (extra.length) throw new ValidationError(`stripe.refund config does not accept: ${extra.join(", ")}`);
    if (config.faultDrill === undefined || config.faultDrill === null) return { account, mode, currency };
    if (mode !== "test") throw new ValidationError("stripe.refund faultDrill runs with `mode: \"test\"` only.");
    if (!(FAULT_DRILLS as readonly unknown[]).includes(config.faultDrill)) {
      throw new ValidationError(`stripe.refund faultDrill must be one of ${FAULT_DRILLS.join(", ")}.`);
    }
    return { account, mode, currency, faultDrill: config.faultDrill as StripeRefundConfig["faultDrill"] };
  },

  checkCredential(credential, config) {
    if (!new RegExp(`^(sk|rk)_${config.mode}_`).test(credential)) {
      throw new ValidationError(`stripe.refund is configured with mode "${config.mode}" and refuses a credential that is not a Stripe ${config.mode} key.`);
    }
  },

  authHeaders(credential) {
    return { Authorization: `Bearer ${credential}` };
  },

  normalize(config, input) {
    const paymentIntent = str(input.paymentIntent);
    if (!paymentIntent || !/^pi_[A-Za-z0-9]{1,64}$/.test(paymentIntent)) {
      throw new ValidationError("paymentIntent must be a payment intent id (pi_...).");
    }
    const amount = input.amount;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT) {
      throw new ValidationError(`amount must be an integer number of minor units between 1 and ${MAX_AMOUNT}.`);
    }
    const currency = str(input.currency);
    if (currency !== config.currency) {
      throw new ValidationError(`This action refunds in ${config.currency} only; got ${currency ?? "none"}.`);
    }
    const reason = input.reason === undefined ? null : str(input.reason);
    if (reason !== null && !(REASONS as readonly string[]).includes(reason)) {
      throw new ValidationError(`reason must be one of ${REASONS.join(", ")}.`);
    }
    return {
      target: {
        account: config.account,
        resourceType: "stripe.payment_intent",
        resourceId: paymentIntent,
        resourceKey: `stripe:${config.account}:payment_intent/${paymentIntent}`,
        display: { Account: `${config.account} (${config.mode} mode)`, "Payment intent": paymentIntent },
      },
      request: { paymentIntent, amount, currency, reason },
    };
  },

  describeImpact(operation) {
    const request = operation.request as { amount: number; currency: string };
    return [
      { dimension: "money", currency: request.currency, amount: request.amount, bound: "exact" },
      { dimension: "resource_mutations", amount: 1, bound: "exact" },
    ];
  },

  async preparePreview(ctx, operation): Promise<PreviewDraft> {
    const request = operation.request as { paymentIntent: string; amount: number; currency: string; reason: string | null };
    const account = await ctx.transport.request({ method: "GET", url: `${API}/v1/account` });
    const accountId = str((account.json as Record<string, unknown> | null)?.id);
    if (account.status !== 200 || accountId !== ctx.config.account) {
      throw new ValidationError(
        `The configured credential belongs to ${accountId ?? "an unreadable account"}, not ${ctx.config.account}. Refusing to preview against a different account.`,
      );
    }
    const pi = await ctx.transport.request({
      method: "GET",
      url: `${API}/v1/payment_intents/${encodeURIComponent(request.paymentIntent)}?expand[]=latest_charge`,
    });
    if (pi.status === 404) throw new ValidationError(`Payment intent ${request.paymentIntent} does not exist on ${ctx.config.account}.`);
    if (pi.status !== 200 || !pi.json || typeof pi.json !== "object") {
      throw new ValidationError(`Stripe did not return payment intent ${request.paymentIntent} (HTTP ${pi.status}).`);
    }
    const body = pi.json as Record<string, unknown>;
    if ((body.livemode === true) !== (ctx.config.mode === "live")) {
      throw new ValidationError(`Payment intent ${request.paymentIntent} is not a ${ctx.config.mode}-mode payment intent, and this action is configured with mode "${ctx.config.mode}".`);
    }
    if (str(body.currency) !== request.currency) {
      throw new ValidationError(`Payment intent ${request.paymentIntent} is in ${str(body.currency)}, not ${request.currency}.`);
    }
    const charge = (body.latest_charge && typeof body.latest_charge === "object" ? body.latest_charge : {}) as Record<string, unknown>;
    const received = typeof body.amount_received === "number" ? body.amount_received : 0;
    const refunded = typeof charge.amount_refunded === "number" ? charge.amount_refunded : 0;
    const refundable = Math.max(received - refunded, 0);
    const observedAt = new Date();
    return {
      blocks: [{
        type: "fields",
        title: "Refund",
        fields: [
          { label: "Account", value: `${ctx.config.account} (${ctx.config.mode} mode)` },
          { label: "Payment intent", value: request.paymentIntent },
          { label: "Refund amount", value: formatMinor(request.amount, request.currency) },
          { label: "Reason", value: request.reason ?? "not given" },
          { label: "Refundable at review time", value: formatMinor(refundable, request.currency) },
          { label: "Payment status", value: str(body.status) ?? "unknown" },
          ...(ctx.config.faultDrill
            ? [{ label: "Fault drill", value: "Test key drill: Anlyon will discard Stripe's response after sending this refund. The refund may still happen; the outcome is recovered from Stripe." }]
            : []),
        ],
      }],
      preconditions: { account: ctx.config.account, currency: request.currency, livemode: ctx.config.mode === "live" },
      evidence: {
        source: "provider_lookup",
        observedAt,
        impliedOutcome: null,
        providerIds: { paymentIntent: request.paymentIntent, account: ctx.config.account },
        summary: `Payment intent ${request.paymentIntent}: ${formatMinor(refundable, request.currency)} refundable at review.`,
        details: { status: str(body.status), amountReceived: received, amountRefunded: refunded },
      },
    };
  },

  async dispatch(ctx, request: DispatchRequest): Promise<Observation> {
    const op = request.operation.request as { paymentIntent: string; amount: number; currency: string; reason: string | null };
    let account: Awaited<ReturnType<typeof ctx.transport.request>>;
    try {
      account = await ctx.transport.request({ method: "GET", url: `${API}/v1/account` });
    } catch (error) {
      throw new TransportError(`Account check failed before the refund was sent: ${error instanceof Error ? error.message : "error"}`, false);
    }
    const accountId = str((account.json as Record<string, unknown> | null)?.id);
    if (account.status !== 200 || accountId !== request.preconditions.account) {
      throw new TransportError(`Credential account ${accountId ?? "unreadable"} does not match the reviewed account; nothing was sent`, false);
    }
    const response = await ctx.transport.request({
      method: "POST",
      url: `${API}/v1/refunds`,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": request.idempotencyKey,
      },
      body: encodeFormBody({
        payment_intent: op.paymentIntent,
        amount: op.amount,
        ...(op.reason ? { reason: op.reason } : {}),
        metadata: { anlyon_effect: request.effectId },
      }),
    });
    if (ctx.config.faultDrill === "drop_response_after_send") {
      throw new TransportError("Fault drill: Stripe's response was discarded after the refund was sent (test key).", true);
    }
    return { kind: "response", status: response.status, json: response.json, bodyText: response.bodyText, observedAt: new Date() };
  },

  interpret(_request, observation): Interpretation {
    if (observation.kind === "transport_error") {
      return {
        outcome: observation.requestSent ? "unknown" : "failed",
        partialEffect: "none",
        providerReference: null,
        evidence: [{
          source: "system",
          observedAt: observation.observedAt,
          impliedOutcome: observation.requestSent ? "unknown" : "failed",
          providerIds: {},
          summary: observation.requestSent
            ? "The refund request may have reached Stripe; no response was received."
            : "The refund request never left Anlyon.",
          details: { error: observation.message },
        }],
      };
    }
    const body = (observation.json && typeof observation.json === "object" ? observation.json : {}) as Record<string, unknown>;
    if (observation.status >= 200 && observation.status < 300 && body.object === "refund") {
      return interpretRefund("provider_response", body, observation.observedAt);
    }
    const error = (body.error && typeof body.error === "object" ? body.error : {}) as Record<string, unknown>;
    const accepted = observation.status >= 200 && observation.status < 300;
    const indeterminate = accepted || observation.status >= 500 || observation.status === 409;
    return {
      outcome: indeterminate ? "unknown" : "failed",
      partialEffect: "none",
      providerReference: null,
      evidence: [{
        source: "provider_response",
        observedAt: observation.observedAt,
        impliedOutcome: indeterminate ? "unknown" : "failed",
        providerIds: str(error.request_log_url) ? { requestLog: str(error.request_log_url)! } : {},
        summary: indeterminate
          ? `Stripe answered HTTP ${observation.status}; the refund may or may not exist.`
          : `Stripe refused the refund (HTTP ${observation.status}${str(error.code) ? `, ${str(error.code)}` : ""}).`,
        details: { status: observation.status, code: error.code ?? null, message: str(error.message)?.slice(0, 300) ?? null },
      }],
    };
  },

  async reconcile(ctx, request: ReconcileRequest): Promise<Interpretation> {
    const op = request.operation.request as { paymentIntent: string };
    if (request.providerReference) {
      const res = await ctx.transport.request({
        method: "GET",
        url: `${API}/v1/refunds/${encodeURIComponent(request.providerReference)}`,
      });
      if (res.status === 200 && res.json && typeof res.json === "object") {
        return interpretRefund("provider_lookup", res.json as Record<string, unknown>, request.now);
      }
      return unknownLookup(request.now, `Refund ${request.providerReference} could not be read (HTTP ${res.status}).`);
    }

    const matches: Array<Record<string, unknown>> = [];
    let startingAfter: string | null = null;
    for (let page = 0; page < 5; page++) {
      const query = `payment_intent=${encodeURIComponent(op.paymentIntent)}&limit=100${startingAfter ? `&starting_after=${encodeURIComponent(startingAfter)}` : ""}`;
      const res = await ctx.transport.request({ method: "GET", url: `${API}/v1/refunds?${query}` });
      if (res.status !== 200 || !res.json || typeof res.json !== "object") {
        return unknownLookup(request.now, `Listing refunds failed (HTTP ${res.status}).`);
      }
      const list = res.json as { data?: Array<Record<string, unknown>>; has_more?: boolean };
      for (const refund of list.data ?? []) {
        const metadata = (refund.metadata ?? {}) as Record<string, unknown>;
        if (metadata.anlyon_effect === request.effectId) matches.push(refund);
      }
      if (!list.has_more || !list.data?.length) {
        startingAfter = null;
        break;
      }
      startingAfter = str(list.data[list.data.length - 1].id);
      if (page === 4) {
        return unknownLookup(request.now, "More than 500 refunds on this payment intent; the search did not finish.");
      }
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
          providerIds: Object.fromEntries(matches.map((refund, i) => [`refund${i + 1}`, str(refund.id) ?? "?"])),
          summary: `${matches.length} refunds carry this effect's id. The evidence is contradictory; an operator must investigate.`,
          details: { refunds: matches.map((refund) => ({ id: refund.id, status: refund.status, amount: refund.amount })) },
        }],
      };
    }
    if (matches.length === 1) return interpretRefund("provider_lookup", matches[0], request.now);

    const dispatchedAt = request.firstDispatchedAt?.getTime() ?? request.now.getTime();
    const pastWindow = request.now.getTime() >= dispatchedAt + STRIPE_CONSISTENCY_WINDOW_MS;
    return {
      outcome: "unknown",
      partialEffect: "none",
      providerReference: null,
      evidence: [{
        source: "provider_lookup",
        observedAt: request.now,
        impliedOutcome: null,
        providerIds: { paymentIntent: op.paymentIntent },
        summary: pastWindow
          ? "No refund on the payment intent carries this effect's id. That does not prove none was made (the marker can be removed); the outcome stays unknown."
          : "No refund carrying this effect's id is visible yet; Stripe may not have finished.",
        details: { consistencyWindowMs: STRIPE_CONSISTENCY_WINDOW_MS },
      }],
    };
  },
};

function unknownLookup(now: Date, summary: string): Interpretation {
  return {
    outcome: "unknown",
    partialEffect: "none",
    providerReference: null,
    evidence: [{ source: "provider_lookup", observedAt: now, impliedOutcome: null, providerIds: {}, summary, details: {} }],
  };
}

