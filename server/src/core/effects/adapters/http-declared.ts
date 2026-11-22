import { ValidationError } from "../../../utils/errors.ts";
import { validateAgainstSchema } from "../../../utils/json-schema.ts";
import { outcomeOfResponseStatus } from "../../actions/dispatch-errors.ts";
import { wantsFormBody } from "../../actions/form-encoding.ts";
import { assertAccountHostOnlyInUrl, assertNoSecretRef, interpolateKeepingSecretRefs, interpolateObject } from "../../actions/template.ts";
import type {
  AdapterCapabilities,
  AdapterContext,
  DispatchRequest,
  EffectAdapter,
  EvidenceDraft,
  ImpactQuantity,
  Interpretation,
  Observation,
  PreviewDraft,
  ReconcileRequest,
  VerifyRequest,
  VerifyResult,
} from "../adapter.ts";
import {
  declaredHost,
  impactQuantity,
  normalizedVerifyNeedsResponse,
  normalizeVerify,
  parseDeclarations,
  resolveVerifyBody,
  resolveVerifyUrl,
  verifyMismatches,
  verifyNeedsResponse,
  type ActionDeclarations,
  type NormalizedVerify,
} from "../declarations.ts";
import { TransportError, type ProviderRequest } from "../transport.ts";

export const HTTP_DECLARED_TYPE = "http.declared";
export const HTTP_DECLARED_VERSION = "1";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const PREVIEW_BODY_LIMIT = 4000;
const NO_SECRETS = new Map<string, string>();

export interface DeclaredDefinition {
  method: string;
  urlTemplate: string;
  headers: Record<string, unknown>;
  bodyTemplate: Record<string, unknown> | null;
  inputSchema: Record<string, unknown>;
  declarations: ActionDeclarations;
}

export interface DeclaredRequest {
  method: ProviderRequest["method"];
  url: string;
  headers: Record<string, string>;
  body: unknown;
  bodyEncoding: "json" | "form" | null;
  impact: ImpactQuantity[];
  verify: NormalizedVerify | null;
}

function requestOf(operation: { request: Record<string, unknown> }): DeclaredRequest {
  return operation.request as unknown as DeclaredRequest;
}

function parseDefinition(raw: unknown): DeclaredDefinition {
  const value = (raw ?? {}) as Record<string, unknown>;
  const method = typeof value.method === "string" ? value.method : "";
  if (!(METHODS as readonly string[]).includes(method)) throw new ValidationError(`A declared action's method must be one of ${METHODS.join(", ")}.`);
  if (typeof value.urlTemplate !== "string") throw new ValidationError("A declared action needs a urlTemplate with a fixed https host.");
  const declared = (value.declarations ?? {}) as Record<string, unknown>;
  const declarations = parseDeclarations({ governed: true, impact: declared.impact, verify: declared.verify }, value.urlTemplate);
  if (!declarations) throw new ValidationError("A declared action needs declarations.");
  assertAccountHostOnlyInUrl(value.headers, value.bodyTemplate);
  return {
    method,
    urlTemplate: value.urlTemplate,
    headers: (value.headers as Record<string, unknown> | null | undefined) ?? {},
    bodyTemplate: (value.bodyTemplate as Record<string, unknown> | null | undefined) ?? null,
    inputSchema: (value.inputSchema as Record<string, unknown> | null | undefined) ?? {},
    declarations,
  };
}

function capabilitiesOf(declarations: ActionDeclarations): AdapterCapabilities {
  const { impact, verify } = declarations;
  const readBackAfterLoss = verify !== null && !verifyNeedsResponse(verify);
  return {
    idempotency: {
      supported: false,
      retentionSeconds: null,
      description: "A declared action sends no provider idempotency key. Anlyon sends the write once and never repeats it.",
    },
    outcomeLookup: {
      supported: readBackAfterLoss,
      description: readBackAfterLoss
        ? "A lost response is recovered by repeating the declared read-back. A match confirms the write. No match proves nothing, so the effect stays unknown until an operator resolves it."
        : verify
          ? "The verify URL needs the provider response, so a lost response cannot be read back. The effect stays unknown until an operator resolves it."
          : "No verify rule is declared, so Anlyon cannot read the result back. A lost response stays unknown until an operator resolves it.",
    },
    conditionalMutation: {
      supported: false,
      description: "Anlyon does not know this API's preconditions. The provider's state is not checked between review and dispatch.",
    },
    asynchronousCompletion: {
      supported: false,
      description: "A 2xx is recorded as the result. Work the provider finishes later is not tracked.",
    },
    compensation: {
      supported: false,
      actionHint: null,
      description: "Anlyon does not know how to undo this action. Define a separate governed action for the reversal.",
    },
    sameKeyReplay: {
      supported: false,
      windowSeconds: null,
      description: "Not supported. Without a provider idempotency key a repeated write could apply twice, so a replay is refused before anything is sent.",
    },
    reversible: {
      supported: false,
      description: "Anlyon cannot reverse a declared action. Whether the provider can is not known to Anlyon.",
    },
    unsupported: [
      "Provider idempotency",
      "Atomic stale-state protection",
      "Replay of a lost write",
      ...(verify ? [] : ["Read-back verification. A 2xx is graded acknowledged and never confirmed"]),
      ...(verify && !readBackAfterLoss ? ["Read-back after a lost response, because the verify URL needs that response"] : []),
      "A check that the declared amount describes what the provider does. Anlyon evaluates the expression as written",
    ],
    impactDimensions: impact ? [impact.dimension] : [],
  };
}

async function readBack(ctx: AdapterContext<DeclaredDefinition>, request: DeclaredRequest, url: string, response: unknown = null) {
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !/^content-(type|length)$/i.test(name)));
  const rule = request.verify;
  if (!rule?.graphql) return ctx.transport.request({ method: "GET", url, headers });
  const body = resolveVerifyBody(rule, response);
  if (!body) throw new TransportError("The GraphQL read-back could not be built: the provider response lacks a value a variable needs. Nothing was sent.", false);
  return ctx.transport.request({ method: "POST", url, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function unknownWith(evidence: EvidenceDraft): Interpretation {
  return { outcome: "unknown", partialEffect: "none", providerReference: null, evidence: [evidence] };
}

export function buildDeclaredAdapter(raw: unknown): EffectAdapter<DeclaredDefinition> {
  const definition = parseDefinition(raw);
  const { hostname } = declaredHost(definition.urlTemplate);
  const { verify } = definition.declarations;

  const adapter: EffectAdapter<DeclaredDefinition> = {
    type: HTTP_DECLARED_TYPE,
    version: HTTP_DECLARED_VERSION,
    title: "Declared HTTP action",
    successDefinition: verify
      ? "The provider answers the write with a 2xx. A read-back that matches the declared verify rule confirms it."
      : "The provider answers the write with a 2xx. No read-back is declared, so the result is acknowledged and not confirmed.",
    successEvidence: "response_status",
    hosts: [hostname],
    capabilities: capabilitiesOf(definition.declarations),
    inputSchema: definition.inputSchema,

    parseConfig: parseDefinition,

    checkCredential() {},
    authHeaders() {
      return {};
    },

    normalize(config, input) {
      if (Object.keys(config.inputSchema).length > 0) {
        const checked = validateAgainstSchema(config.inputSchema, input);
        if (!checked.valid) throw new ValidationError(`Invalid input: ${checked.errors.join(", ")}`);
      }
      const { host } = declaredHost(config.urlTemplate);
      const url = interpolateKeepingSecretRefs(config.urlTemplate, input, "url");
      const authorityEnd = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/.exec(url)?.[0].length ?? 0;
      const path = url.slice(authorityEnd).split(/[?#]/)[0] || "/";

      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(interpolateObject(config.headers, input, NO_SECRETS, { keepSecretRefs: true }))) {
        headers[name] = typeof value === "string" ? value : JSON.stringify(value);
      }

      const method = config.method as ProviderRequest["method"];
      let body: unknown = null;
      let bodyEncoding: DeclaredRequest["bodyEncoding"] = null;
      if (method !== "GET" && method !== "DELETE") {
        if (config.bodyTemplate !== null) {
          body = interpolateObject(config.bodyTemplate, input, NO_SECRETS, { typed: true, keepSecretRefs: true });
        } else {
          assertNoSecretRef(input);
          body = input;
        }
        bodyEncoding = wantsFormBody(headers) ? "form" : "json";
        if (bodyEncoding === "json" && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
          headers["Content-Type"] = "application/json";
        }
      }

      const { impact, verify: rule } = config.declarations;
      const quantity = impact ? impactQuantity(impact, input) : null;
      const request: DeclaredRequest = {
        method,
        url,
        headers,
        body,
        bodyEncoding,
        impact: quantity ? [quantity] : [],
        verify: rule ? normalizeVerify(rule, input) : null,
      };
      return {
        target: {
          account: host,
          resourceType: "http.resource",
          resourceId: `${method} ${path}`,
          resourceKey: `http:${host}${path}`,
          display: { Host: host, Method: method, Path: path },
        },
        request: request as unknown as Record<string, unknown>,
      };
    },

    describeImpact(operation) {
      return requestOf(operation).impact;
    },

    async preparePreview(_ctx, operation): Promise<PreviewDraft> {
      const request = requestOf(operation);
      const body = request.body === null ? null : JSON.stringify(request.body);
      return {
        blocks: [{
          type: "fields",
          title: "Request",
          fields: [
            { label: "Method", value: request.method },
            { label: "URL", value: request.url },
            ...Object.entries(request.headers).map(([name, value]) => ({ label: `Header ${name}`, value })),
            ...(body === null ? [] : [{
              label: `Body (${request.bodyEncoding})`,
              value: body.length > PREVIEW_BODY_LIMIT ? `${body.slice(0, PREVIEW_BODY_LIMIT)} [truncated]` : body,
            }]),
            { label: "Read-back", value: request.verify ? `${request.verify.graphql ? "POST (GraphQL query)" : "GET"} ${request.verify.url}, expecting ${request.verify.status}` : "none declared" },
          ],
        }],
        preconditions: { host: operation.target.account, method: request.method },
        evidence: {
          source: "system",
          observedAt: new Date(),
          impliedOutcome: null,
          providerIds: {},
          summary: "Previewed from the action definition and the input. The provider was not read.",
          details: {},
        },
      };
    },

    async dispatch(ctx, request: DispatchRequest): Promise<Observation> {
      if (request.kind === "replay") {
        throw new TransportError("A declared action has no provider idempotency key, so a lost write is not repeated. Nothing was sent.", false);
      }
      const req = requestOf(request.operation);
      const response = await ctx.transport.request({
        method: req.method,
        url: req.url,
        headers: req.headers,
        ...(req.bodyEncoding ? { payload: { encoding: req.bodyEncoding, value: req.body } } : {}),
      });
      return { kind: "response", status: response.status, json: response.json, bodyText: response.bodyText, observedAt: new Date() };
    },

    interpret(request, observation): Interpretation {
      if (request.kind === "replay") {
        return unknownWith({
          source: "system",
          observedAt: observation.observedAt,
          impliedOutcome: null,
          providerIds: {},
          summary: "A declared action is not replayed. Nothing was sent and the outcome is unchanged.",
          details: {},
        });
      }
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
              ? "The request may have reached the provider. No response was received."
              : "The request never left Anlyon.",
            details: { error: observation.message },
          }],
        };
      }
      const outcome = outcomeOfResponseStatus(observation.status);
      const rule = requestOf(request.operation).verify ?? null;
      const reference = outcome === "succeeded" && rule ? resolveVerifyUrl(rule, observation.json) : null;
      return {
        outcome,
        partialEffect: "none",
        providerReference: reference,
        evidence: [{
          source: "provider_response",
          observedAt: observation.observedAt,
          impliedOutcome: outcome,
          providerIds: reference ? { readBack: reference } : {},
          summary: outcome === "succeeded"
            ? `The provider accepted the request (HTTP ${observation.status}).`
            : outcome === "failed"
              ? `The provider refused the request (HTTP ${observation.status}).`
              : `The provider answered HTTP ${observation.status}. The request may or may not have been applied.`,
          details: { status: observation.status },
        }],
      };
    },

    async reconcile(ctx, request: ReconcileRequest): Promise<Interpretation> {
      const req = requestOf(request.operation);
      const rule = req.verify ?? null;
      const notReadable = (summary: string) => unknownWith({
        source: "system", observedAt: request.now, impliedOutcome: null, providerIds: {}, summary, details: {},
      });
      if (!rule) return notReadable("This action declares no verify rule, so the result cannot be read back. The outcome stays unknown until an operator resolves it.");
      if (normalizedVerifyNeedsResponse(rule)) {
        return notReadable("The verify rule needs the provider response, which was lost. The outcome stays unknown until an operator resolves it.");
      }
      const response = await readBack(ctx, req, rule.url);
      const mismatches = verifyMismatches(rule, response, null);
      if (mismatches.length === 0 && rule.match.length === 0) {
        return unknownWith({
          source: "provider_lookup",
          observedAt: request.now,
          impliedOutcome: null,
          providerIds: { readBack: rule.url },
          summary: `The read-back answered HTTP ${response.status}. The verify rule has no match check, so it cannot show that the write landed. The outcome stays unknown until an operator resolves it.`,
          details: { status: response.status },
        });
      }
      if (mismatches.length === 0) {
        return {
          outcome: "succeeded",
          partialEffect: "none",
          providerReference: rule.url,
          verified: true,
          evidence: [{
            source: "provider_lookup",
            observedAt: request.now,
            impliedOutcome: "succeeded",
            providerIds: { readBack: rule.url },
            summary: `The read-back matched the declared verify rule (HTTP ${response.status}).`,
            details: { status: response.status },
          }],
        };
      }
      return unknownWith({
        source: "provider_lookup",
        observedAt: request.now,
        impliedOutcome: null,
        providerIds: { readBack: rule.url },
        summary: "The read-back did not match the declared verify rule. That does not prove the write failed, so the outcome stays unknown.",
        details: { status: response.status, mismatches },
      });
    },
  };

  if (!verify) return adapter;
  return {
    ...adapter,
    async verify(ctx, request: VerifyRequest): Promise<VerifyResult> {
      const req = requestOf(request.operation);
      const rule = req.verify;
      const noMatch = (source: EvidenceDraft["source"], summary: string, details: Record<string, unknown>, url: string | null): VerifyResult => ({
        matched: false,
        evidence: [{ source, observedAt: request.now, impliedOutcome: null, providerIds: url ? { readBack: url } : {}, summary, details }],
      });
      if (!rule) return { matched: false, evidence: [] };
      const url = resolveVerifyUrl(rule, request.response);
      if (!url) {
        return noMatch("system", "The read-back could not be built: the provider response lacks a value the verify URL needs. The result stays acknowledged.", {}, null);
      }
      let response: Awaited<ReturnType<typeof readBack>>;
      try {
        response = await readBack(ctx, req, url, request.response);
      } catch (error) {
        return noMatch("system", "The read-back could not be completed. The result stays acknowledged.",
          { error: error instanceof Error ? error.message.slice(0, 300) : "error" }, url);
      }
      const mismatches = verifyMismatches(rule, response, request.response);
      if (mismatches.length > 0) {
        return noMatch("provider_lookup", "The read-back did not match the declared verify rule. The result stays acknowledged.",
          { status: response.status, mismatches }, url);
      }
      return {
        matched: true,
        evidence: [{
          source: "provider_lookup",
          observedAt: request.now,
          impliedOutcome: "succeeded",
          providerIds: { readBack: url },
          summary: `The read-back matched the declared verify rule (HTTP ${response.status}).`,
          details: { status: response.status },
        }],
      };
    },
  };
}
