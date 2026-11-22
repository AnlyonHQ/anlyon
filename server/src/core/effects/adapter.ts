import type { ProviderTransport } from "./transport.ts";
import type { PartialEffect } from "../../db/schema/effects.ts";

export type ImpactBound = "exact" | "upper_bound";

export interface ImpactQuantity {
  dimension: string;
  currency?: string;
  amount: number;
  bound: ImpactBound;
}

export interface CapabilityClaim {
  supported: boolean;
  description: string;
}

export interface AdapterCapabilities {
  idempotency: CapabilityClaim & { retentionSeconds: number | null };
  outcomeLookup: CapabilityClaim;
  conditionalMutation: CapabilityClaim;
  asynchronousCompletion: CapabilityClaim;
  compensation: CapabilityClaim & { actionHint: string | null };
  sameKeyReplay: CapabilityClaim & { windowSeconds: number | null };
  reversible: CapabilityClaim;
  unsupported: string[];
  impactDimensions: string[];
}

export interface EffectTarget {
  account: string;
  resourceType: string;
  resourceId: string;
  resourceKey: string;
  display: Record<string, string>;
}

export interface NormalizedOperation {
  target: EffectTarget;
  request: Record<string, unknown>;
}

export type PreviewBlock =
  | { type: "fields"; title: string; fields: Array<{ label: string; value: string }> }
  | { type: "text_diff"; title: string; path: string; before: string; after: string; truncated: boolean }
  | { type: "impact"; title: string; quantities: ImpactQuantity[] }
  | {
      type: "limitations";
      title: string;
      items: Array<{ kind: "unsupported" | "guarantee" | "irreversible" | "freshness"; text: string }>;
    };

export interface EvidenceDraft {
  source: "provider_response" | "provider_lookup" | "system";
  observedAt: Date;
  impliedOutcome: "pending" | "succeeded" | "failed" | "unknown" | null;
  providerIds: Record<string, string>;
  summary: string;
  details: Record<string, unknown>;
}

export interface PreviewDraft {
  blocks: PreviewBlock[];
  preconditions: Record<string, unknown>;
  evidence: EvidenceDraft;
}

export interface DispatchRequest {
  effectId: string;
  operation: NormalizedOperation;
  preconditions: Record<string, unknown>;
  idempotencyKey: string;
  kind: "dispatch" | "replay";
}

export type Observation =
  | {
      kind: "response"; status: number; json: unknown; bodyText: string; observedAt: Date;
      details?: Record<string, unknown>;
    }
  | { kind: "transport_error"; requestSent: boolean; message: string; observedAt: Date };

export interface Interpretation {
  outcome: "pending" | "succeeded" | "failed" | "unknown";
  partialEffect: PartialEffect;
  providerReference: string | null;
  actualImpact?: ImpactQuantity[];
  evidence: EvidenceDraft[];
  verified?: boolean;
  failureProof?: { providerReference: string; summary: string };
}

export interface ReconcileRequest {
  effectId: string;
  operation: NormalizedOperation;
  preconditions: Record<string, unknown>;
  idempotencyKey: string;
  providerReference: string | null;
  firstDispatchedAt: Date | null;
  history: Array<{ source: string; impliedOutcome: string | null; observedAt: Date; providerIds: Record<string, string> }>;
  now: Date;
}

export interface VerifyRequest {
  effectId: string;
  operation: NormalizedOperation;
  response: unknown;
  now: Date;
}

export interface VerifyResult {
  matched: boolean;
  evidence: EvidenceDraft[];
}

export interface AdapterContext<Config> {
  config: Config;
  transport: ProviderTransport;
  environment: { id: string; name: string; kind: string; workspaceId?: string };
  endUserId?: string | null;
  refreshCredential?: () => Promise<boolean>;
  mcpTransport?: "streamable-http" | "sse" | null;
}

export interface EffectAdapter<Config = Record<string, unknown>> {
  readonly type: string;
  readonly version: string;
  readonly title: string;
  readonly successDefinition: string;
  readonly successEvidence: "provider_record" | "response_status";
  readonly hosts: readonly string[];
  readonly maxResponseBytes?: number;
  readonly capabilities: AdapterCapabilities;
  readonly inputSchema: Record<string, unknown>;

  parseConfig(raw: unknown): Config;
  checkCredential(credential: string, config: Config): void;
  authHeaders(credential: string): Record<string, string>;

  normalize(config: Config, input: Record<string, unknown>): NormalizedOperation;
  describeImpact(operation: NormalizedOperation): ImpactQuantity[];
  preparePreview(ctx: AdapterContext<Config>, operation: NormalizedOperation): Promise<PreviewDraft>;
  dispatch(ctx: AdapterContext<Config>, request: DispatchRequest): Promise<Observation>;
  interpret(request: DispatchRequest, observation: Observation): Interpretation;
  reconcile(ctx: AdapterContext<Config>, request: ReconcileRequest): Promise<Interpretation>;
  verify?(ctx: AdapterContext<Config>, request: VerifyRequest): Promise<VerifyResult>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEffectAdapter = EffectAdapter<any>;
