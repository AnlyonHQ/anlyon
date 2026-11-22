import { vi } from "vitest";
import { providerFetch } from "./support/effects/provider-fetch.ts";

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: providerFetch };
});

const { describeAdapterConformance } = await import("./support/effects/conformance.ts");
const { stripeRefundAdapter, STRIPE_CONSISTENCY_WINDOW_MS } = await import("../src/core/effects/adapters/stripe-refund.ts");
const { githubFileAdapter, GITHUB_LOOKUP_MAX_PAGES, GITHUB_MAX_TEXT_BYTES } = await import("../src/core/effects/adapters/github-file.ts");
const { StripeSimulator } = await import("./support/effects/stripe-simulator.ts");
const { GitHubSimulator } = await import("./support/effects/github-simulator.ts");
const { buildDeclaredAdapter } = await import("../src/core/effects/adapters/http-declared.ts");
const { HttpSimulator, HTTP_SIM_HOST, HTTP_SIM_TOKEN } = await import("./support/effects/http-simulator.ts");
const {
  resendEmailAdapter, RESEND_CONSISTENCY_WINDOW_MS, RESEND_EFFECT_TAG, RESEND_IDEMPOTENCY_RETENTION_SECONDS,
  RESEND_LOOKUP_MAX_CANDIDATES, RESEND_MAX_TO,
} = await import("../src/core/effects/adapters/resend-email.ts");
const { ResendSimulator, RESEND_SIM_DOMAIN, RESEND_SIM_KEY, RESEND_SIM_SENDING_KEY } = await import("./support/effects/resend-simulator.ts");

describeAdapterConformance({
  name: "stripe.refund",
  adapter: stripeRefundAdapter,
  config: { account: "acct_simTest001", mode: "test", currency: "usd" },
  configWithoutTarget: { mode: "test", currency: "usd" },
  credential: "sk_test_simulator_key_0000000000",
  validInput: { paymentIntent: "pi_conformance", amount: 8000, currency: "usd", reason: "requested_by_customer" },
  reorderedInput: { reason: "requested_by_customer", currency: "usd", amount: 8000, paymentIntent: "pi_conformance" },
  invalidInputs: [
    { paymentIntent: "pi_conformance", amount: 80.5, currency: "usd" },
    { paymentIntent: "pi_conformance", amount: 0, currency: "usd" },
    { paymentIntent: "pi_conformance", amount: 100, currency: "eur" },
    { paymentIntent: "ch_notapi", amount: 100, currency: "usd" },
    { paymentIntent: "pi_conformance", amount: "100", currency: "usd" },
  ],
  simulator: () => new StripeSimulator().addPaymentIntent("pi_conformance", 20_000),
  faultLoseResponse: (sim) => sim.fault("write", "lose_response_after_commit"),
  faultServerErrorBeforeCommit: (sim) => sim.fault("write", "http_500_before_commit"),
  faultConnectRefused: (sim) => sim.fault("write", "connect_refused"),
  makeWriteInvalid: (sim) => { sim.paymentIntents.get("pi_conformance")!.amount_received = 100; },
  consistencyWindowMs: STRIPE_CONSISTENCY_WINDOW_MS,
});

const REPO = "anlyon-sim/fixtures";
describeAdapterConformance({
  name: "github.file_update",
  adapter: githubFileAdapter,
  config: { owner: "anlyon-sim", repo: "fixtures", branch: "anlyon-test" },
  configWithoutTarget: { owner: "anlyon-sim", repo: "fixtures" },
  credential: "ghp_simulatorToken000000000000000000",
  validInput: { path: "docs/status.txt", content: "status: green\n", message: "Update status" },
  reorderedInput: { message: "Update status", content: "status: green\n", path: "docs/status.txt" },
  invalidInputs: [
    { path: "../etc/passwd", content: "x", message: "m" },
    { path: "/abs.txt", content: "x", message: "m" },
    { path: "a.txt", content: "x".repeat(70 * 1024), message: "m" },
    { path: "a.txt", content: "bin\u0000ary", message: "m" },
    { path: "a.txt", content: "x", message: "" },
    { path: "a.txt", content: "x", message: "sneak\nAnlyon-Effect: eff_other" },
  ],
  simulator: () => new GitHubSimulator().addRepo(REPO, "main").setFile(REPO, "anlyon-test", "docs/status.txt", "status: amber\n"),
  faultLoseResponse: (sim) => sim.fault("write", "lose_response_after_commit"),
  faultServerErrorBeforeCommit: (sim) => sim.fault("write", "http_502_before_commit"),
  faultConnectRefused: (sim) => sim.fault("write", "connect_refused"),
  makeWriteInvalid: (sim) => sim.externalWrite(REPO, "anlyon-test", "docs/status.txt", "status: red\n"),
  consistencyWindowMs: 60_000,
});

const RESEND_INPUT = {
  from: `Billing <billing@${RESEND_SIM_DOMAIN}>`,
  to: ["a@example.com", "b@example.com"],
  cc: ["c@example.com"],
  subject: "Your receipt",
  text: "Thanks for your order.",
};
describeAdapterConformance({
  name: "resend.email_send",
  adapter: resendEmailAdapter,
  config: { domain: RESEND_SIM_DOMAIN },
  configWithoutTarget: { fromAddresses: [`billing@${RESEND_SIM_DOMAIN}`] },
  credential: RESEND_SIM_KEY,
  validInput: RESEND_INPUT,
  reorderedInput: { text: "Thanks for your order.", subject: "Your receipt", cc: ["c@example.com"], to: ["a@example.com", "b@example.com"], from: `Billing <billing@${RESEND_SIM_DOMAIN}>` },
  invalidInputs: [
    { ...RESEND_INPUT, from: "billing@other.example" },
    { ...RESEND_INPUT, to: [] },
    { ...RESEND_INPUT, to: "a@example.com" },
    { ...RESEND_INPUT, to: Array.from({ length: RESEND_MAX_TO + 1 }, (_, i) => `r${i}@example.com`) },
    { ...RESEND_INPUT, cc: ["A@example.com"] },
    { ...RESEND_INPUT, to: ["not-an-address"] },
    { ...RESEND_INPUT, subject: "" },
    { from: RESEND_INPUT.from, to: RESEND_INPUT.to, subject: "No body" },
    { ...RESEND_INPUT, scheduledAt: "in 1 hour" },
  ],
  simulator: () => new ResendSimulator(),
  faultLoseResponse: (sim) => sim.fault("write", "lose_response_after_commit"),
  faultServerErrorBeforeCommit: (sim) => sim.fault("write", "http_500_before_commit"),
  faultConnectRefused: (sim) => sim.fault("write", "connect_refused"),
  makeWriteInvalid: (sim) => { sim.domains.get(RESEND_SIM_DOMAIN)!.status = "pending"; },
  consistencyWindowMs: RESEND_CONSISTENCY_WINDOW_MS,
});

const DECLARED = {
  method: "PUT",
  urlTemplate: `https://${HTTP_SIM_HOST}/v1/messages/{{input.messageId}}`,
  headers: { Authorization: "Bearer {{secret:MAILER_TOKEN}}" },
  bodyTemplate: { to: "{{input.to}}", subject: "{{input.subject}}" },
  inputSchema: {
    type: "object",
    required: ["messageId", "to", "subject"],
    properties: {
      messageId: { type: "string", pattern: "^[a-z0-9-]{1,40}$" },
      to: { type: "array", items: { type: "string" } },
      subject: { type: "string" },
    },
  },
  declarations: {
    impact: { dimension: "emails", unit: "emails", amount: "count(input.to)", bound: "exact" },
    verify: {
      url: `https://${HTTP_SIM_HOST}/v1/messages/{{input.messageId}}`,
      status: 200,
      match: [{ path: "subject", equals: "{{input.subject}}" }],
    },
  },
};
const DECLARED_INPUT = { messageId: "welcome-1", to: ["a@example.com", "b@example.com"], subject: "Welcome" };

describeAdapterConformance({
  name: "http.declared (no provider adapter)",
  adapter: buildDeclaredAdapter(DECLARED),
  config: DECLARED,
  configWithoutTarget: { ...DECLARED, urlTemplate: "https://{{input.host}}/v1/messages/{{input.messageId}}" },
  credential: HTTP_SIM_TOKEN,
  secrets: { MAILER_TOKEN: HTTP_SIM_TOKEN },
  validInput: DECLARED_INPUT,
  reorderedInput: { subject: "Welcome", to: ["a@example.com", "b@example.com"], messageId: "welcome-1" },
  invalidInputs: [
    { messageId: "welcome-1", subject: "Welcome" },
    { messageId: "welcome-1", to: "a@example.com", subject: "Welcome" },
    { messageId: "../admin", to: ["a@example.com"], subject: "Welcome" },
    { messageId: "welcome-1", to: ["a@example.com"], subject: 7 },
    { messageId: "welcome-1", to: ["a@example.com"], subject: "{{secret:MAILER_TOKEN}}" },
  ],
  simulator: () => new HttpSimulator(),
  faultLoseResponse: (sim) => sim.fault("write", "lose_response_after_commit"),
  faultServerErrorBeforeCommit: (sim) => sim.fault("write", "http_500_before_commit"),
  faultConnectRefused: (sim) => sim.fault("write", "connect_refused"),
  makeWriteInvalid: (sim) => { sim.locked.add("messages/welcome-1"); },
  consistencyWindowMs: 60_000,
});

const { describe, expect, it } = await import("vitest");
const { ValidationError } = await import("../src/utils/errors.ts");
const { setProviderFetch } = await import("./support/effects/provider-fetch.ts");
const { adapterTransport } = await import("../src/core/effects/transport.ts");

describe("http.declared read-back and recovery", () => {
  type Definition = typeof DECLARED;
  const effectId = "eff_declaredaction01";
  const setup = (definition: Record<string, unknown> = DECLARED, input: Record<string, unknown> = DECLARED_INPUT) => {
    const sim = new HttpSimulator();
    setProviderFetch(sim.fetch);
    const adapter = buildDeclaredAdapter(definition);
    const config = adapter.parseConfig(definition);
    const ctx = {
      config,
      environment: { id: "env_test", name: "Test", kind: "development" },
      transport: adapterTransport(adapter, new Map([["MAILER_TOKEN", HTTP_SIM_TOKEN]]), { timeoutMs: 2000 }),
    };
    const operation = adapter.normalize(config, input);
    const request = { effectId, operation, preconditions: {}, idempotencyKey: `anlyon-${effectId}`, kind: "dispatch" as const };
    const lookup = () => adapter.reconcile(ctx, {
      effectId, operation, preconditions: {}, idempotencyKey: `anlyon-${effectId}`, providerReference: null,
      firstDispatchedAt: new Date(), history: [], now: new Date(),
    });
    return { sim, adapter, ctx, operation, request, lookup };
  };
  const SERVER_ID: Record<string, unknown> = {
    ...DECLARED,
    method: "POST",
    urlTemplate: `https://${HTTP_SIM_HOST}/v1/messages`,
    inputSchema: { type: "object", required: ["to", "subject"], properties: { to: { type: "array", items: { type: "string" } }, subject: { type: "string" } } },
    declarations: {
      ...DECLARED.declarations,
      verify: { url: `https://${HTTP_SIM_HOST}/v1/messages/{{response.id}}`, status: 200, match: [{ path: "status", equals: "sent" }] },
    },
  };
  const withoutVerify = (definition: Definition): Record<string, unknown> =>
    ({ ...definition, declarations: { impact: definition.declarations.impact, verify: null } });

  it("the persisted request keeps the secret reference, and the transport puts the value on the wire", async () => {
    const { sim, adapter, ctx, operation, request } = setup();
    expect(JSON.stringify(operation)).not.toContain(HTTP_SIM_TOKEN);
    expect((operation.request as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer {{secret:MAILER_TOKEN}}");
    const observation = await adapter.dispatch(ctx, request);
    expect(sim.requests[0].authorization).toBe(`Bearer ${HTTP_SIM_TOKEN}`);
    expect(JSON.stringify(observation)).not.toContain(HTTP_SIM_TOKEN);
  });

  it("a 2xx is acceptance: it carries no verification until the read-back matches", async () => {
    const { sim, adapter, ctx, request } = setup();
    const observation = await adapter.dispatch(ctx, request);
    const interpretation = adapter.interpret(request, observation);
    expect(interpretation).toMatchObject({ outcome: "succeeded" });
    expect(interpretation.verified).toBeUndefined();
    expect(adapter.successEvidence).toBe("response_status");
    const verified = await adapter.verify!(ctx, { effectId, operation: request.operation, response: (observation as { json: unknown }).json, now: new Date() });
    expect(verified.matched).toBe(true);
    expect(verified.evidence[0]).toMatchObject({ source: "provider_lookup", impliedOutcome: "succeeded" });
    expect(sim.writes).toBe(1);
  });

  it("a read-back that does not match, or cannot be made, is not a match and writes nothing", async () => {
    const { sim, adapter, ctx, request } = setup();
    const observation = await adapter.dispatch(ctx, request);
    const response = (observation as { json: unknown }).json;
    sim.externalWrite("messages", "welcome-1", { subject: "Changed by someone else" });
    const mismatch = await adapter.verify!(ctx, { effectId, operation: request.operation, response, now: new Date() });
    expect(mismatch.matched).toBe(false);
    expect(mismatch.evidence[0].details).toMatchObject({ mismatches: ["subject"] });
    sim.tokens.clear();
    const refused = await adapter.verify!(ctx, { effectId, operation: request.operation, response, now: new Date() });
    expect(refused.matched).toBe(false);
    expect(sim.writes).toBe(1);
  });

  it("a verify URL that needs the response reads back after the write, and cannot after a lost response", async () => {
    const { sim, adapter, ctx, request, lookup } = setup(SERVER_ID, { to: ["a@example.com"], subject: "Welcome" });
    expect(adapter.capabilities.outcomeLookup.supported).toBe(false);
    expect(adapter.capabilities.unsupported.join(" ")).toMatch(/lost response/);
    const observation = await adapter.dispatch(ctx, request);
    const interpretation = adapter.interpret(request, observation);
    expect(interpretation.providerReference).toMatch(/\/v1\/messages\/msg_[0-9a-f]+$/);
    const verified = await adapter.verify!(ctx, { effectId, operation: request.operation, response: (observation as { json: unknown }).json, now: new Date() });
    expect(verified.matched).toBe(true);

    sim.fault("write", "lose_response_after_commit");
    await expect(adapter.dispatch(ctx, request)).rejects.toMatchObject({ requestSent: true });
    const reads = sim.requests.length;
    const result = await lookup();
    expect(result).toMatchObject({ outcome: "unknown", providerReference: null });
    expect(result.failureProof).toBeUndefined();
    expect(sim.requests).toHaveLength(reads);
    expect(sim.writes).toBe(2);
  });

  it("with no verify rule a 2xx is all there is: no read-back, and a lost response stays unknown", async () => {
    const { sim, adapter, ctx, request, lookup } = setup(withoutVerify(DECLARED));
    expect(adapter.verify).toBeUndefined();
    expect(adapter.capabilities.outcomeLookup.supported).toBe(false);
    expect(adapter.capabilities.unsupported.join(" ")).toMatch(/Read-back verification/);
    const interpretation = adapter.interpret(request, await adapter.dispatch(ctx, request));
    expect(interpretation).toMatchObject({ outcome: "succeeded", providerReference: null });
    const requests = sim.requests.length;
    expect((await lookup()).outcome).toBe("unknown");
    expect(sim.requests).toHaveLength(requests);
    expect(sim.writes).toBe(1);
  });

  it("a replay is refused before any write and never reads as failed", async () => {
    const { sim, adapter, ctx, request } = setup();
    await adapter.dispatch(ctx, request);
    const replay = { ...request, kind: "replay" as const };
    await expect(adapter.dispatch(ctx, replay)).rejects.toMatchObject({ requestSent: false });
    expect(sim.writes).toBe(1);
    const interpretation = adapter.interpret(replay, { kind: "transport_error", requestSent: false, message: "refused", observedAt: new Date() });
    expect(interpretation.outcome).toBe("unknown");
    expect(adapter.capabilities.sameKeyReplay.supported).toBe(false);
    expect(adapter.capabilities.idempotency.supported).toBe(false);
  });

  it("a read-back that matches after a lost response recovers it as verified, read-only", async () => {
    const { sim, adapter, ctx, request, lookup } = setup();
    sim.fault("write", "lose_response_after_commit");
    await expect(adapter.dispatch(ctx, request)).rejects.toMatchObject({ requestSent: true });
    const result = await lookup();
    expect(result).toMatchObject({ outcome: "succeeded", verified: true });
    expect(sim.writes).toBe(1);
    expect(sim.requests.filter((r) => r.method !== "GET")).toHaveLength(1);
  });

  it("a secret the transport was not given is refused before anything is sent", async () => {
    const { sim, adapter, operation, request } = setup();
    const ctx = {
      config: adapter.parseConfig(DECLARED),
      environment: { id: "env_test", name: "Test", kind: "development" },
      transport: adapterTransport(adapter, new Map<string, string>(), { timeoutMs: 2000 }),
    };
    await expect(adapter.dispatch(ctx, { ...request, operation })).rejects.toMatchObject({ requestSent: false });
    expect(sim.hosts).toHaveLength(0);
  });
});

describe("resend.email_send read-back and recovery", () => {
  const effectId = "eff_resendrecovery01";
  const setup = (credential: string = RESEND_SIM_KEY, input: Record<string, unknown> = RESEND_INPUT) => {
    const sim = new ResendSimulator();
    setProviderFetch(sim.fetch);
    const config = resendEmailAdapter.parseConfig({ domain: RESEND_SIM_DOMAIN });
    const ctx = {
      config,
      environment: { id: "env_test", name: "Test", kind: "development" },
      transport: adapterTransport(resendEmailAdapter, credential, { timeoutMs: 2000 }),
    };
    const operation = resendEmailAdapter.normalize(config, input);
    const request = { effectId, operation, preconditions: { domain: RESEND_SIM_DOMAIN }, idempotencyKey: `anlyon-${effectId}`, kind: "dispatch" as const };
    const lookup = (providerReference: string | null = null, now = new Date()) => resendEmailAdapter.reconcile(ctx, {
      effectId, operation, preconditions: {}, idempotencyKey: `anlyon-${effectId}`, providerReference,
      firstDispatchedAt: new Date(), history: [], now,
    });
    const verify = (response: unknown) => resendEmailAdapter.verify!(ctx, { effectId, operation, response, now: new Date() });
    return { sim, ctx, operation, request, lookup, verify };
  };
  const posts = (sim: InstanceType<typeof ResendSimulator>) => sim.requests.filter((r) => r.method === "POST");

  it("counts one email per recipient across to, cc and bcc, exactly", () => {
    const config = resendEmailAdapter.parseConfig({ domain: RESEND_SIM_DOMAIN });
    const operation = resendEmailAdapter.normalize(config, { ...RESEND_INPUT, bcc: ["d@example.com", "e@example.com"] });
    expect(resendEmailAdapter.describeImpact(operation)).toEqual([{ dimension: "emails", amount: 5, bound: "exact" }]);
    expect(operation.target).toMatchObject({ account: RESEND_SIM_DOMAIN, resourceKey: `resend:${RESEND_SIM_DOMAIN}:from/billing@${RESEND_SIM_DOMAIN}` });
  });

  it("confines the sender to the configured domain, and to the allowlist when one is set", () => {
    const config = resendEmailAdapter.parseConfig({ domain: RESEND_SIM_DOMAIN.toUpperCase(), fromAddresses: [`Billing@${RESEND_SIM_DOMAIN}`] });
    expect(config).toEqual({ domain: RESEND_SIM_DOMAIN, fromAddresses: [`billing@${RESEND_SIM_DOMAIN}`] });
    expect(() => resendEmailAdapter.normalize(config, { ...RESEND_INPUT, from: `support@${RESEND_SIM_DOMAIN}` })).toThrow(ValidationError);
    expect(() => resendEmailAdapter.normalize(config, { ...RESEND_INPUT, from: `billing@evil-${RESEND_SIM_DOMAIN}` })).toThrow(ValidationError);
    expect(() => resendEmailAdapter.parseConfig({ domain: RESEND_SIM_DOMAIN, fromAddresses: ["billing@other.example"] })).toThrow(ValidationError);
    expect(() => resendEmailAdapter.parseConfig({ domain: RESEND_SIM_DOMAIN, region: "eu" })).toThrow(ValidationError);
  });

  it("refuses a credential that is not a Resend API key", () => {
    const config = resendEmailAdapter.parseConfig({ domain: RESEND_SIM_DOMAIN });
    for (const credential of ["sk_test_simulator_key_0000000000", "ghp_simulatorToken000000000000000000", "re_", ""]) {
      expect(() => resendEmailAdapter.checkCredential(credential, config)).toThrow(ValidationError);
    }
    expect(() => resendEmailAdapter.checkCredential(RESEND_SIM_KEY, config)).not.toThrow();
  });

  it("an accepted send is acceptance: it carries no verification until the read-back matches", async () => {
    const { sim, ctx, request, verify } = setup();
    const observation = await resendEmailAdapter.dispatch(ctx, request);
    const interpretation = resendEmailAdapter.interpret(request, observation);
    expect(interpretation).toMatchObject({ outcome: "succeeded", providerReference: sim.emails[0].id });
    expect(interpretation.verified).toBeUndefined();
    expect(resendEmailAdapter.successEvidence).toBe("response_status");
    expect(posts(sim)[0].idempotencyKey).toBe(`anlyon-${effectId}`);
    expect(sim.emails[0].tags).toEqual([{ name: RESEND_EFFECT_TAG, value: effectId }]);
    const verified = await verify((observation as { json: unknown }).json);
    expect(verified.matched).toBe(true);
    expect(verified.evidence[0]).toMatchObject({ source: "provider_lookup", impliedOutcome: "succeeded", providerIds: { emailId: sim.emails[0].id } });
    expect(verified.evidence[0].summary).toMatch(/not proof of delivery/);
    expect(sim.writes).toBe(1);
    expect(posts(sim)).toHaveLength(1);
  });

  it("a read-back that finds no email, another effect's email, or a failed one is not a match and writes nothing", async () => {
    const { sim, ctx, request, verify } = setup();
    const response = (await resendEmailAdapter.dispatch(ctx, request) as { json: unknown }).json;
    sim.fault("lookup", "hide_from_read");
    expect((await verify(response)).matched).toBe(false);
    const other = sim.externalEmail({ subject: RESEND_INPUT.subject, tags: [{ name: RESEND_EFFECT_TAG, value: "eff_someoneelse0001" }] });
    expect((await verify({ id: other.id })).matched).toBe(false);
    expect((await verify({})).matched).toBe(false);
    sim.setLastEvent(sim.emails[0].id, "failed");
    const failed = await verify(response);
    expect(failed.matched).toBe(false);
    expect(failed.evidence[0].details).toMatchObject({ lastEvent: "failed" });
    sim.setLastEvent(sim.emails[0].id, "bounced");
    expect((await verify(response)).matched).toBe(true);
    expect(posts(sim)).toHaveLength(1);
  });

  it("a sending access key can send and cannot read back, so the result is not confirmed", async () => {
    const { sim, ctx, operation, request, lookup, verify } = setup(RESEND_SIM_SENDING_KEY);
    await expect(resendEmailAdapter.preparePreview(ctx, operation)).rejects.toThrow(/full access/);
    const observation = await resendEmailAdapter.dispatch(ctx, request);
    expect(resendEmailAdapter.interpret(request, observation).outcome).toBe("succeeded");
    const readBack = await verify((observation as { json: unknown }).json);
    expect(readBack.matched).toBe(false);
    expect(readBack.evidence[0].summary).toMatch(/full access/);
    const result = await lookup();
    expect(result.outcome).toBe("unknown");
    expect(result.evidence[0].summary).toMatch(/full access/);
    expect(sim.writes).toBe(1);
  });

  it("a same-key replay inside the window returns the first email and sends nothing", async () => {
    const { sim, ctx, request } = setup();
    sim.fault("write", "lose_response_after_commit");
    await expect(resendEmailAdapter.dispatch(ctx, request)).rejects.toMatchObject({ requestSent: true });
    sim.advance((RESEND_IDEMPOTENCY_RETENTION_SECONDS - 60) * 1000);
    const replay = { ...request, kind: "replay" as const };
    const interpretation = resendEmailAdapter.interpret(replay, await resendEmailAdapter.dispatch(ctx, replay));
    expect(interpretation).toMatchObject({ outcome: "succeeded", providerReference: sim.emails[0].id });
    expect(sim.writes).toBe(1);
    expect(sim.recipients()).toBe(3);
    expect(resendEmailAdapter.capabilities.sameKeyReplay).toMatchObject({ supported: true, windowSeconds: RESEND_IDEMPOTENCY_RETENTION_SECONDS });
    expect(resendEmailAdapter.capabilities.idempotency).toMatchObject({ supported: true, retentionSeconds: RESEND_IDEMPOTENCY_RETENTION_SECONDS });
  });

  it("after 24 hours the provider no longer holds the key: a repeat would send again, so the window is declared", async () => {
    const { sim, ctx, request } = setup();
    await resendEmailAdapter.dispatch(ctx, request);
    sim.advance((RESEND_IDEMPOTENCY_RETENTION_SECONDS + 60) * 1000);
    await resendEmailAdapter.dispatch(ctx, { ...request, kind: "replay" });
    expect(sim.writes).toBe(2);
    expect(resendEmailAdapter.capabilities.sameKeyReplay.windowSeconds).toBe(24 * 60 * 60);
  });

  it("a key reused with another payload, or still in flight, is unknown and never failed", async () => {
    const { sim, ctx, request, operation } = setup();
    await resendEmailAdapter.dispatch(ctx, request);
    const changed = { ...request, operation: { ...operation, request: { ...operation.request, subject: "Changed" } }, kind: "replay" as const };
    const observation = await resendEmailAdapter.dispatch(ctx, changed);
    expect(observation).toMatchObject({ status: 409 });
    const interpretation = resendEmailAdapter.interpret(changed, observation);
    expect(interpretation.outcome).toBe("unknown");
    expect(interpretation.evidence[0].summary).toMatch(/invalid_idempotent_request/);
    expect(sim.writes).toBe(1);
  });

  it("recovers a lost response by the effect tag, among other emails with the same subject, read-only", async () => {
    const { sim, ctx, request, lookup } = setup();
    sim.externalEmail({ subject: RESEND_INPUT.subject });
    sim.fault("write", "lose_response_after_commit");
    await expect(resendEmailAdapter.dispatch(ctx, request)).rejects.toMatchObject({ requestSent: true });
    sim.externalEmail({ subject: RESEND_INPUT.subject, tags: [{ name: RESEND_EFFECT_TAG, value: "eff_someoneelse0001" }] });
    const ours = sim.emails[1];
    const result = await lookup();
    expect(result).toMatchObject({ outcome: "succeeded", verified: true, providerReference: ours.id });
    expect(result.failureProof).toBeUndefined();
    expect(await lookup(ours.id)).toMatchObject({ outcome: "succeeded", verified: true, providerReference: ours.id });
    expect(posts(sim)).toHaveLength(1);
    expect(sim.writes).toBe(1);
  });

  it("an email the list does not show yet, or that predates the dispatch, is unknown and never failed", async () => {
    const { sim, ctx, request, lookup } = setup();
    sim.fault("write", "lose_response_after_commit");
    await expect(resendEmailAdapter.dispatch(ctx, request)).rejects.toMatchObject({ requestSent: true });
    sim.fault("lookup", "hide_from_list");
    const hidden = await lookup();
    expect(hidden.outcome).toBe("unknown");
    expect(hidden.failureProof).toBeUndefined();
    sim.emails[0].createdAtMs -= 60 * 60_000;
    const reads = sim.requests.length;
    expect((await lookup()).outcome).toBe("unknown");
    expect(sim.requests.slice(reads).map((r) => r.path)).toEqual(["/emails"]);
    expect(sim.writes).toBe(1);
  });

  it("a search that hits its bound stays unknown and says so", async () => {
    const { sim, ctx, request, lookup } = setup();
    sim.fault("write", "lose_response_after_commit");
    await expect(resendEmailAdapter.dispatch(ctx, request)).rejects.toMatchObject({ requestSent: true });
    for (let i = 0; i < RESEND_LOOKUP_MAX_CANDIDATES; i++) sim.externalEmail({ subject: RESEND_INPUT.subject });
    const result = await lookup();
    expect(result.outcome).toBe("unknown");
    expect(result.evidence[0].summary).toMatch(/search stopped/);
    expect(result.evidence[0].details).toMatchObject({ exhaustive: false, candidatesRead: RESEND_LOOKUP_MAX_CANDIDATES });
  });

  it("a found email that Resend reports failed is failed, with proof naming it", async () => {
    const { sim, ctx, request, lookup } = setup();
    sim.fault("write", "lose_response_after_commit");
    await expect(resendEmailAdapter.dispatch(ctx, request)).rejects.toMatchObject({ requestSent: true });
    sim.setLastEvent(sim.emails[0].id, "failed");
    const result = await lookup();
    expect(result.outcome).toBe("failed");
    expect(result.failureProof?.providerReference).toBe(sim.emails[0].id);
    expect(result.verified).toBeUndefined();
  });

  it("declares what it does not do", () => {
    const caps = resendEmailAdapter.capabilities;
    expect(caps.unsupported.join(" ")).toMatch(/Delivery to the inbox/);
    expect(caps.unsupported.join(" ")).toMatch(/Recall/);
    expect(caps.unsupported.join(" ")).toMatch(/Lookup by idempotency key/);
    expect(caps.conditionalMutation.supported).toBe(false);
    expect(caps.compensation.supported).toBe(false);
    expect(caps.reversible.supported).toBe(false);
    expect(caps.impactDimensions).toEqual(["emails"]);
  });
});

describe("github.file_update pathPrefix", () => {
  const CONFIG = { owner: "anlyon-sim", repo: "fixtures", branch: "anlyon-test" };
  const change = (pathPrefix: string, path: string) =>
    githubFileAdapter.normalize(githubFileAdapter.parseConfig({ ...CONFIG, pathPrefix }), { path, content: "x\n", message: "m" });

  it("confines on a segment boundary: \"docs\" does not admit docs-private/", () => {
    expect(() => change("docs", "docs-private/keys.md")).toThrow(ValidationError);
    expect(() => change("docs", "docsx.md")).toThrow(ValidationError);
    expect(change("docs", "docs/a.md").target.resourceId).toBe("anlyon-test:docs/a.md");
  });

  it("treats \"docs/\" and \"docs\" alike, and admits nested files", () => {
    expect(change("docs/", "docs/x").target.resourceId).toBe("anlyon-test:docs/x");
    expect(change("docs//", "docs/x/y.md").target.resourceId).toBe("anlyon-test:docs/x/y.md");
    expect(() => change("docs/", "docs-private/x")).toThrow(ValidationError);
    expect(githubFileAdapter.parseConfig({ ...CONFIG, pathPrefix: "docs" }).pathPrefix).toBe("docs/");
  });

  it("refuses a prefix that is not a relative directory", () => {
    for (const pathPrefix of ["/", "/docs", "docs/../x", "./docs", "a//b"]) {
      expect(() => githubFileAdapter.parseConfig({ ...CONFIG, pathPrefix })).toThrow(ValidationError);
    }
  });
});

describe("github.file_update recovery", () => {
  const CONFIG = { owner: "anlyon-sim", repo: "fixtures", branch: "anlyon-test" };
  const TOKEN = "ghp_simulatorToken000000000000000000";
  const setup = () => {
    const sim = new GitHubSimulator().addRepo(REPO, "main").setFile(REPO, "anlyon-test", "docs/status.txt", "status: amber\n");
    sim.tokens.add(TOKEN);
    setProviderFetch(sim.fetch);
    const config = githubFileAdapter.parseConfig(CONFIG);
    const ctx = {
      config,
      environment: { id: "env_test", name: "Test", kind: "development" },
      transport: adapterTransport(githubFileAdapter, TOKEN, { timeoutMs: 2000 }),
    };
    return { sim, ctx, config };
  };
  const effectId = "eff_githubrecovery01";
  const lostWrite = async (sim: InstanceType<typeof GitHubSimulator>, ctx: Parameters<typeof githubFileAdapter.dispatch>[0], config: ReturnType<typeof githubFileAdapter.parseConfig>) => {
    const operation = githubFileAdapter.normalize(config, { path: "docs/status.txt", content: "status: green\n", message: "Update status" });
    const preview = await githubFileAdapter.preparePreview(ctx, operation);
    const request = { effectId, operation, preconditions: preview.preconditions, idempotencyKey: `anlyon-${effectId}`, kind: "dispatch" as const };
    sim.fault("write", "lose_response_after_commit");
    await expect(githubFileAdapter.dispatch(ctx, request)).rejects.toThrow();
    return { operation, preview, request };
  };
  const lookup = (ctx: Parameters<typeof githubFileAdapter.dispatch>[0], operation: ReturnType<typeof githubFileAdapter.normalize>, preconditions: Record<string, unknown>, now = new Date(Date.now() + 10 * 60_000)) =>
    githubFileAdapter.reconcile(ctx, {
      effectId, operation, preconditions, idempotencyKey: `anlyon-${effectId}`, providerReference: null,
      firstDispatchedAt: new Date(), history: [], now,
    });

  it("finds a landed commit beyond the first page of history", async () => {
    const { sim, ctx, config } = setup();
    const { operation, preview } = await lostWrite(sim, ctx, config);
    for (let i = 0; i < 150; i++) sim.commits.push({ sha: `later${i}`, message: `later ${i}`, path: "docs/status.txt", branch: "anlyon-test", date: new Date().toISOString() });
    const result = await lookup(ctx, operation, preview.preconditions);
    expect(result.outcome).toBe("succeeded");
  });

  it("a commit that left the branch history (force-push) is unknown on every lookup, never failed", async () => {
    const { sim, ctx, config } = setup();
    const { operation, preview } = await lostWrite(sim, ctx, config);
    sim.rewriteHistory((c) => c.message.includes(effectId));
    for (let i = 0; i < 5; i++) {
      const result = await lookup(ctx, operation, preview.preconditions, new Date(Date.now() + (i + 1) * 60 * 60_000));
      expect(result.outcome).toBe("unknown");
    }
    expect(sim.writes).toBe(1);
  });

  it("a search that hits its bound stays unknown and says so", async () => {
    const { sim, ctx, config } = setup();
    const { operation, preview } = await lostWrite(sim, ctx, config);
    for (let i = 0; i < GITHUB_LOOKUP_MAX_PAGES * 100; i++) sim.commits.push({ sha: `noise${i}`, message: `noise ${i}`, path: "docs/status.txt", branch: "anlyon-test", date: new Date().toISOString() });
    const result = await lookup(ctx, operation, preview.preconditions);
    expect(result.outcome).toBe("unknown");
    expect(result.evidence[0].summary).toMatch(/search stopped/);
    expect(result.evidence[0].details).toMatchObject({ exhaustive: false });
  });

  it("a file at GITHUB_MAX_TEXT_BYTES previews, and its update is recorded succeeded, not unknown", async () => {
    const { sim, ctx, config } = setup();
    sim.setFile(REPO, "anlyon-test", "docs/large.txt", "a".repeat(GITHUB_MAX_TEXT_BYTES));
    const operation = githubFileAdapter.normalize(config, { path: "docs/large.txt", content: "b".repeat(GITHUB_MAX_TEXT_BYTES), message: "Large update" });
    const preview = await githubFileAdapter.preparePreview(ctx, operation);
    const request = { effectId, operation, preconditions: preview.preconditions, idempotencyKey: `anlyon-${effectId}`, kind: "dispatch" as const };
    const result = githubFileAdapter.interpret(request, await githubFileAdapter.dispatch(ctx, request));
    expect(result.outcome).toBe("succeeded");
    expect(result.providerReference).toMatch(/^[0-9a-f]{40}$/);
    expect(sim.writes).toBe(1);
  });

  it("A -> B -> A: the reviewed blob SHA would let a repeat write B twice, so replay is not offered", async () => {
    const { sim, ctx, config } = setup();
    const { request } = await lostWrite(sim, ctx, config);
    sim.externalWrite(REPO, "anlyon-test", "docs/status.txt", "status: amber\n", "restore");
    await githubFileAdapter.dispatch(ctx, { ...request, kind: "replay" });
    expect(sim.writes).toBe(2);
    expect(githubFileAdapter.capabilities.sameKeyReplay.supported).toBe(false);
  });
});

describe("stripe.refund lookups", () => {
  const TOKEN = "sk_test_simulator_key_0000000000";
  const setup = () => {
    const sim = new StripeSimulator().addPaymentIntent("pi_lookup", 20_000);
    setProviderFetch(sim.fetch);
    const config = stripeRefundAdapter.parseConfig({ account: sim.accountId, mode: "test", currency: "usd" });
    const ctx = {
      config,
      environment: { id: "env_test", name: "Test", kind: "development" },
      transport: adapterTransport(stripeRefundAdapter, TOKEN, { timeoutMs: 2000 }),
    };
    const operation = stripeRefundAdapter.normalize(config, { paymentIntent: "pi_lookup", amount: 1000, currency: "usd" });
    return { sim, ctx, operation };
  };
  const lookup = (ctx: Parameters<typeof stripeRefundAdapter.reconcile>[0], operation: ReturnType<typeof stripeRefundAdapter.normalize>, effectId: string, providerReference: string | null = null) =>
    stripeRefundAdapter.reconcile(ctx, {
      effectId, operation, preconditions: {}, idempotencyKey: `anlyon-${effectId}`, providerReference,
      firstDispatchedAt: new Date(Date.now() - 60 * 60_000), history: [], now: new Date(),
    });

  it("a refund whose anlyon_effect marker was removed is unknown, not failed", async () => {
    const { sim, ctx, operation } = setup();
    const effectId = "eff_markerremoved01";
    await stripeRefundAdapter.dispatch(ctx, {
      effectId, operation, preconditions: { account: sim.accountId }, idempotencyKey: `anlyon-${effectId}`, kind: "dispatch",
    });
    sim.refunds[0].metadata = {};
    const result = await lookup(ctx, operation, effectId);
    expect(result.outcome).toBe("unknown");
    expect(sim.refunds).toHaveLength(1);
  });

  it("a found refund that Stripe reports failed is failed, with proof naming it", async () => {
    const { sim, ctx, operation } = setup();
    const effectId = "eff_refundfailed01";
    sim.fault("write", "pending");
    await stripeRefundAdapter.dispatch(ctx, {
      effectId, operation, preconditions: { account: sim.accountId }, idempotencyKey: `anlyon-${effectId}`, kind: "dispatch",
    });
    sim.settle(sim.refunds[0].id, "failed");
    const result = await lookup(ctx, operation, effectId, sim.refunds[0].id);
    expect(result.outcome).toBe("failed");
    expect(result.failureProof?.providerReference).toBe(sim.refunds[0].id);
  });
});

describe("stripe.refund fault drill (test mode)", () => {
  const TOKEN = "sk_test_simulator_key_0000000000";

  it("accepts only the named drill, and only beside test mode", () => {
    const base = { account: "acct_simTest001", mode: "test", currency: "usd" };
    expect(stripeRefundAdapter.parseConfig({ ...base, faultDrill: "drop_response_after_send" }).faultDrill).toBe("drop_response_after_send");
    expect(stripeRefundAdapter.parseConfig(base).faultDrill).toBeUndefined();
    expect(() => stripeRefundAdapter.parseConfig({ ...base, faultDrill: "drop_everything" })).toThrow(/faultDrill/);
    expect(() => stripeRefundAdapter.parseConfig({ ...base, mode: "live", faultDrill: "drop_response_after_send" })).toThrow(/test/);
  });

  it("sends the refund once, then discards Stripe's answer as a lost response; lookup finds it", async () => {
    const sim = new StripeSimulator().addPaymentIntent("pi_drill", 20_000);
    setProviderFetch(sim.fetch);
    const config = stripeRefundAdapter.parseConfig({ account: sim.accountId, mode: "test", currency: "usd", faultDrill: "drop_response_after_send" });
    const ctx = { config, environment: { id: "env_test", name: "Test", kind: "development" }, transport: adapterTransport(stripeRefundAdapter, TOKEN, { timeoutMs: 2000 }) };
    const operation = stripeRefundAdapter.normalize(config, { paymentIntent: "pi_drill", amount: 5400, currency: "usd" });
    const effectId = "eff_faultdrill0001";
    const error = await stripeRefundAdapter.dispatch(ctx, {
      effectId, operation, preconditions: { account: sim.accountId }, idempotencyKey: `anlyon-${effectId}`, kind: "dispatch",
    }).then(() => null, (e: unknown) => e as { name: string; requestSent: boolean });
    expect(error).toMatchObject({ name: "TransportError", requestSent: true });
    expect(sim.writes).toBe(1);
    const found = await stripeRefundAdapter.reconcile(ctx, {
      effectId, operation, preconditions: {}, idempotencyKey: `anlyon-${effectId}`, providerReference: null,
      firstDispatchedAt: new Date(), history: [], now: new Date(),
    });
    expect(found.outcome).toBe("succeeded");
    expect(found.providerReference).toBe(sim.refunds[0].id);
    expect(sim.writes).toBe(1);
  });
});

describe("stripe.refund runs with a live or a test key", () => {
  const base = { account: "acct_simTest001", currency: "usd" };
  const live = stripeRefundAdapter.parseConfig({ ...base, mode: "live" });
  const test = stripeRefundAdapter.parseConfig({ ...base, mode: "test" });

  it("needs the mode named, and takes both", () => {
    expect(live.mode).toBe("live");
    expect(test.mode).toBe("test");
    expect(() => stripeRefundAdapter.parseConfig(base)).toThrow(/mode/);
    expect(() => stripeRefundAdapter.parseConfig({ ...base, mode: "sandbox" })).toThrow(/mode/);
  });

  it("accepts the key that matches the declared mode and refuses the other kind", () => {
    for (const key of ["sk_live_0000000000000000", "rk_live_0000000000000000"]) {
      expect(() => stripeRefundAdapter.checkCredential(key, live)).not.toThrow();
      expect(() => stripeRefundAdapter.checkCredential(key, test)).toThrow(ValidationError);
    }
    for (const key of ["sk_test_0000000000000000", "rk_test_0000000000000000"]) {
      expect(() => stripeRefundAdapter.checkCredential(key, test)).not.toThrow();
      expect(() => stripeRefundAdapter.checkCredential(key, live)).toThrow(ValidationError);
    }
    expect(() => stripeRefundAdapter.checkCredential("pk_live_0000000000000000", live)).toThrow(ValidationError);
  });

  it("shows the reviewer which mode the refund runs in", () => {
    const input = { paymentIntent: "pi_mode", amount: 100, currency: "usd" };
    expect(stripeRefundAdapter.normalize(live, input).target.display.Account).toBe("acct_simTest001 (live mode)");
    expect(stripeRefundAdapter.normalize(test, input).target.display.Account).toBe("acct_simTest001 (test mode)");
  });

  it("refuses a payment intent from the other mode before anything is reviewed", async () => {
    const sim = new StripeSimulator().addPaymentIntent("pi_mode", 20_000);
    sim.keys.add("sk_live_simulator_key_0000000000");
    setProviderFetch(sim.fetch);
    const config = stripeRefundAdapter.parseConfig({ account: sim.accountId, mode: "live", currency: "usd" });
    const ctx = { config, environment: { id: "env_test", name: "Test", kind: "production" }, transport: adapterTransport(stripeRefundAdapter, "sk_live_simulator_key_0000000000", { timeoutMs: 2000 }) };
    const operation = stripeRefundAdapter.normalize(config, { paymentIntent: "pi_mode", amount: 100, currency: "usd" });
    await expect(stripeRefundAdapter.preparePreview(ctx as never, operation)).rejects.toThrow(/not a live-mode payment intent/);
    expect(sim.writes).toBe(0);
  });
});
