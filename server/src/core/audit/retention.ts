import { type LifecycleOptions, type LifecycleResult, runAuditLifecycle } from "./lifecycle.ts";

export function retentionCutoff(retentionDays: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - retentionDays * 86_400_000);
}

export type AuditRetentionResult = LifecycleResult;

export async function sweepAuditRetention(now: Date = new Date(), options: Omit<LifecycleOptions, "now"> = {}): Promise<AuditRetentionResult> {
  return runAuditLifecycle({ ...options, now });
}
