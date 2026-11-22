import { canonicalDigest } from "./canonical.ts";

export function requestDigest(input: {
  actionName: string;
  adapterType: string;
  request: Record<string, unknown>;
  target: Record<string, unknown>;
}): string {
  return canonicalDigest({ v: 1, kind: "request", ...input });
}

export interface BindingInput {
  workspaceId: string;
  environmentId: string;
  requestDigest: string;
  target: Record<string, unknown>;
  actionVersionId: string;
  adapterType: string;
  adapterVersion: string;
  preconditions: Record<string, unknown>;
  expiresAt: Date;
}

export function bindingDigest(input: BindingInput): string {
  return canonicalDigest({ v: 1, kind: "binding", ...input, expiresAt: input.expiresAt.toISOString() });
}
