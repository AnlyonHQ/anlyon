import { describe, expect, it } from "vitest";
import type { AnyEffectAdapter, DispatchRequest, Interpretation, NormalizedOperation, ReconcileRequest } from "../../../src/core/effects/adapter.ts";
import { canonicalDigest } from "../../../src/core/effects/canonical.ts";
import { requestDigest } from "../../../src/core/effects/binding.ts";
import { adapterTransport, TransportError } from "../../../src/core/effects/transport.ts";
import { ValidationError } from "../../../src/utils/errors.ts";
import { setProviderFetch } from "./provider-fetch.ts";

export interface SimulatorLike {
  fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;
  hosts: string[];
  writes: number;
}

export interface AdapterHarness<Sim extends SimulatorLike> {
  name: string;
  adapter: AnyEffectAdapter;
  config: Record<string, unknown>;
  credential: string;
  secrets?: Record<string, string>;
  configWithoutTarget: Record<string, unknown>;
  validInput: Record<string, unknown>;
  reorderedInput: Record<string, unknown>;
  invalidInputs: Array<Record<string, unknown>>;
  simulator: () => Sim;
  faultLoseResponse: (sim: Sim) => void;
  faultServerErrorBeforeCommit: (sim: Sim) => void;
  faultConnectRefused: (sim: Sim) => void;
  makeWriteInvalid: (sim: Sim) => void;
  consistencyWindowMs: number;
}

function ctx(harness: AdapterHarness<SimulatorLike>) {
  const config = harness.adapter.parseConfig(harness.config);
  return {
    config,
    environment: { id: "env_test", name: "Test", kind: "development" },
    transport: adapterTransport(
      harness.adapter,
      harness.secrets ? new Map(Object.entries(harness.secrets)) : harness.credential,
      { timeoutMs: 2000 },
    ),
  };
}

async function dispatchOnce(
  harness: AdapterHarness<SimulatorLike>, operation: NormalizedOperation, preconditions: Record<string, unknown>, kind: "dispatch" | "replay" = "dispatch",
): Promise<{ request: DispatchRequest; interpretation: Interpretation }> {
  const request: DispatchRequest = { effectId: "eff_conformance0001", operation, preconditions, idempotencyKey: "anlyon-eff_conformance0001", kind };
  let observation;
  try {
    observation = await harness.adapter.dispatch(ctx(harness), request);
  } catch (error) {
    expect(error).toBeInstanceOf(TransportError);
    observation = { kind: "transport_error" as const, requestSent: (error as TransportError).requestSent, message: (error as Error).message, observedAt: new Date() };
  }
  return { request, interpretation: harness.adapter.interpret(request, observation) };
}

async function prepared(harness: AdapterHarness<SimulatorLike>) {
  const config = harness.adapter.parseConfig(harness.config);
  const operation = harness.adapter.normalize(config, harness.validInput);
  const preview = await harness.adapter.preparePreview(ctx(harness), operation);
  return { operation, preview };
}

export function describeAdapterConformance<Sim extends SimulatorLike>(harness: AdapterHarness<Sim>) {
  const h = harness as unknown as AdapterHarness<SimulatorLike>;
  let sim: Sim;
  const fresh = () => {
    sim = harness.simulator();
    setProviderFetch(sim.fetch);
    return sim;
  };

  describe(`adapter conformance: ${harness.name}`, () => {
    describe("declaration", () => {
      it("declares identity, hosts and every capability explicitly", () => {
        const a = harness.adapter;
        expect(a.type).toMatch(/^[a-z]+\.[a-z_]+$/);
        expect(a.version).toMatch(/^\d+$/);
        expect(a.hosts.length).toBeGreaterThan(0);
        expect(a.successDefinition.length).toBeGreaterThan(10);
        expect(["provider_record", "response_status"]).toContain(a.successEvidence);
        for (const key of ["idempotency", "outcomeLookup", "conditionalMutation", "asynchronousCompletion", "compensation", "sameKeyReplay", "reversible"] as const) {
          expect(typeof a.capabilities[key].supported).toBe("boolean");
          expect(a.capabilities[key].description.length).toBeGreaterThan(10);
        }
        expect(a.capabilities.unsupported.length).toBeGreaterThan(0);
        expect(a.capabilities.impactDimensions.length).toBeGreaterThan(0);
        if (a.capabilities.idempotency.supported) expect(a.capabilities.idempotency.retentionSeconds).not.toBeUndefined();
      });

      it("claims same-key replay only with a provider idempotency key to deduplicate on", () => {
        const caps = harness.adapter.capabilities;
        if (caps.sameKeyReplay.supported) expect(caps.idempotency.supported).toBe(true);
      });

      it("refuses a config that does not name its target explicitly", () => {
        expect(() => harness.adapter.parseConfig(harness.configWithoutTarget)).toThrow(ValidationError);
      });
    });

    describe("identity", () => {
      it("normalizes deterministically, independent of key order", () => {
        const config = harness.adapter.parseConfig(harness.config);
        const a = harness.adapter.normalize(config, harness.validInput);
        const b = harness.adapter.normalize(config, harness.reorderedInput);
        const digest = (op: NormalizedOperation) => requestDigest({ actionName: "x", adapterType: harness.adapter.type, request: op.request, target: op.target as never });
        expect(digest(a)).toBe(digest(b));
        expect(canonicalDigest(a)).toBe(canonicalDigest(harness.adapter.normalize(config, harness.validInput)));
      });

      it("resolves an explicit target with a prefix-matchable resource key", () => {
        const config = harness.adapter.parseConfig(harness.config);
        const op = harness.adapter.normalize(config, harness.validInput);
        expect(op.target.account.length).toBeGreaterThan(0);
        expect(op.target.resourceKey).toContain(op.target.account);
      });

      it("rejects invalid input with a validation error, before any network", () => {
        const config = harness.adapter.parseConfig(harness.config);
        const s = fresh();
        for (const input of harness.invalidInputs) {
          expect(() => harness.adapter.normalize(config, input), JSON.stringify(input)).toThrow(ValidationError);
        }
        expect(s.hosts).toHaveLength(0);
      });

      it("describes a bounded quantity for every dimension it declares", () => {
        const config = harness.adapter.parseConfig(harness.config);
        const impact = harness.adapter.describeImpact(harness.adapter.normalize(config, harness.validInput));
        for (const dimension of harness.adapter.capabilities.impactDimensions) {
          const q = impact.find((item) => item.dimension === dimension);
          expect(q, dimension).toBeDefined();
          expect(Number.isInteger(q!.amount) && q!.amount >= 0).toBe(true);
          expect(["exact", "upper_bound"]).toContain(q!.bound);
        }
      });
    });

    describe("isolation", () => {
      it("reaches only its declared hosts and never leaks the credential", async () => {
        const s = fresh();
        const { operation, preview } = await prepared(h);
        const { interpretation } = await dispatchOnce(h, operation, preview.preconditions);
        expect(new Set(s.hosts)).toEqual(new Set(harness.adapter.hosts));
        const serialized = JSON.stringify({ operation, preview, interpretation });
        expect(serialized).not.toContain(harness.credential);
      });

      it("cannot be pointed at another host by its transport", async () => {
        fresh();
        const transport = ctx(h).transport;
        await expect(transport.request({ method: "GET", url: "https://evil.example/steal" })).rejects.toMatchObject({ requestSent: false });
        await expect(transport.request({ method: "GET", url: `http://${harness.adapter.hosts[0]}/` })).rejects.toMatchObject({ requestSent: false });
      });

      it("prepares typed preview blocks, material preconditions and timed evidence", async () => {
        fresh();
        const { preview } = await prepared(h);
        for (const block of preview.blocks) expect(["fields", "text_diff", "impact", "limitations"]).toContain(block.type);
        expect(Object.keys(preview.preconditions).length).toBeGreaterThan(0);
        expect(preview.evidence.observedAt).toBeInstanceOf(Date);
        expect(JSON.stringify(preview)).not.toMatch(/<script|<\/?html/i);
      });
    });

    describe("dispatch and evidence", () => {
      it("interprets an accepted write with a provider reference and provider evidence", async () => {
        const s = fresh();
        const { operation, preview } = await prepared(h);
        const { interpretation } = await dispatchOnce(h, operation, preview.preconditions);
        expect(["succeeded", "pending"]).toContain(interpretation.outcome);
        expect(interpretation.providerReference).toBeTruthy();
        expect(interpretation.evidence.some((e) => e.source === "provider_response" && Object.keys(e.providerIds).length > 0)).toBe(true);
        expect(s.writes).toBe(1);
      });

      it("a duplicate attempt of the same effect never creates a second mutation", async () => {
        const s = fresh();
        const { operation, preview } = await prepared(h);
        await dispatchOnce(h, operation, preview.preconditions);
        const second = await dispatchOnce(h, operation, preview.preconditions, "replay");
        expect(s.writes).toBe(1);
        expect(second.interpretation.outcome).not.toBe("failed");
      });

      it("a lost response after the provider committed is unknown, never failed", async () => {
        const s = fresh();
        const { operation, preview } = await prepared(h);
        harness.faultLoseResponse(s);
        const { interpretation } = await dispatchOnce(h, operation, preview.preconditions);
        expect(s.writes).toBe(1);
        expect(interpretation.outcome).toBe("unknown");
      });

      it("a server error is unknown", async () => {
        const s = fresh();
        const { operation, preview } = await prepared(h);
        harness.faultServerErrorBeforeCommit(s);
        const { interpretation } = await dispatchOnce(h, operation, preview.preconditions);
        expect(interpretation.outcome).toBe("unknown");
      });

      it("a request that never left is failed with no partial effect", async () => {
        const s = fresh();
        const { operation, preview } = await prepared(h);
        harness.faultConnectRefused(s);
        const { interpretation } = await dispatchOnce(h, operation, preview.preconditions);
        expect(interpretation.outcome).toBe("failed");
        expect(interpretation.partialEffect).toBe("none");
        expect(s.writes).toBe(0);
      });

      it("a provider refusal is failed with evidence", async () => {
        const s = fresh();
        const { operation, preview } = await prepared(h);
        harness.makeWriteInvalid(s);
        const { interpretation } = await dispatchOnce(h, operation, preview.preconditions);
        expect(interpretation.outcome).toBe("failed");
        expect(interpretation.evidence[0].source).toBe("provider_response");
        expect(s.writes).toBe(0);
      });

      it("interpretation never throws on garbage", () => {
        const request: DispatchRequest = {
          effectId: "eff_x", operation: { target: { account: "a", resourceType: "r", resourceId: "i", resourceKey: "k", display: {} }, request: {} },
          preconditions: {}, idempotencyKey: "k", kind: "dispatch",
        };
        for (const status of [200, 201, 400, 409, 500, 503]) {
          const result = harness.adapter.interpret(request, { kind: "response", status, json: null, bodyText: "<html>oops</html>", observedAt: new Date() });
          expect(["pending", "succeeded", "failed", "unknown"]).toContain(result.outcome);
          if (status >= 500) expect(result.outcome).toBe("unknown");
          if (status < 300) expect(result.outcome).not.toBe("failed");
        }
      });
    });

    describe("reconciliation", () => {
      it("recovers a lost response to the same provider reference, read-only", async () => {
        const s = fresh();
        const { operation, preview } = await prepared(h);
        harness.faultLoseResponse(s);
        const { request } = await dispatchOnce(h, operation, preview.preconditions);
        const writes = s.writes;
        const result = await harness.adapter.reconcile(ctx(h), {
          effectId: request.effectId, operation, preconditions: preview.preconditions, idempotencyKey: request.idempotencyKey,
          providerReference: null, firstDispatchedAt: new Date(), history: [], now: new Date(),
        });
        expect(["succeeded", "pending"]).toContain(result.outcome);
        expect(result.providerReference).toBeTruthy();
        expect(result.evidence[0].source).toBe("provider_lookup");
        expect(s.writes).toBe(writes);
        if (harness.adapter.successEvidence === "response_status" && result.outcome === "succeeded") {
          expect(result.verified).toBe(true);
        }
      });

      it("never treats absence as failure, however often and however late it looks", async () => {
        const s = fresh();
        const { operation, preview } = await prepared(h);
        const base = {
          effectId: "eff_neverwritten01", operation, preconditions: preview.preconditions, idempotencyKey: "anlyon-eff_neverwritten01",
          providerReference: null, firstDispatchedAt: new Date(Date.now() - 2 * harness.consistencyWindowMs),
        };
        let history: ReconcileRequest["history"] = [];
        for (let i = 0; i < 5; i++) {
          const result = await harness.adapter.reconcile(ctx(h), { ...base, history, now: new Date(Date.now() + i * 60 * 60_000) });
          expect(result.outcome).toBe("unknown");
          expect(result.failureProof).toBeUndefined();
          history = [...history, ...result.evidence.map((e) => ({ source: e.source, impliedOutcome: e.impliedOutcome, observedAt: e.observedAt, providerIds: e.providerIds }))];
        }
        expect(s.writes).toBe(0);
      });

      it("a failed interpretation of a found operation carries the provider's proof", async () => {
        fresh();
        const { operation } = await prepared(h);
        const garbage = await harness.adapter.reconcile(ctx(h), {
          effectId: "eff_neverwritten02", operation, preconditions: {}, idempotencyKey: "anlyon-eff_neverwritten02",
          providerReference: null, firstDispatchedAt: new Date(0), history: [], now: new Date(),
        });
        if (garbage.outcome === "failed") expect(garbage.failureProof?.providerReference).toBeTruthy();
      });
    });
  });
}
