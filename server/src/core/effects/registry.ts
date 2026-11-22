import type { AnyEffectAdapter } from "./adapter.ts";
import { ValidationError } from "../../utils/errors.ts";
import { stripeRefundAdapter } from "./adapters/stripe-refund.ts";
import { githubFileAdapter } from "./adapters/github-file.ts";
import { resendEmailAdapter } from "./adapters/resend-email.ts";

const adapters = new Map<string, AnyEffectAdapter>(
  [stripeRefundAdapter, githubFileAdapter, resendEmailAdapter].map((adapter) => [adapter.type, adapter]),
);

export function getAdapter(type: string): AnyEffectAdapter {
  const adapter = adapters.get(type);
  if (!adapter) throw new ValidationError(`Unknown action adapter "${type}". Available: ${[...adapters.keys()].join(", ")}.`);
  return adapter;
}

export function findAdapter(type: string): AnyEffectAdapter | undefined {
  return adapters.get(type);
}

export function listAdapters(): AnyEffectAdapter[] {
  return [...adapters.values()];
}
