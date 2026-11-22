import { upgradesPurchasable } from "../plans/limits.ts";

export type LimitKind = "monthly" | "resource" | "storage" | "paid_only";

export function nextUsageReset(now: Date = new Date()): string {
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return reset.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export function limitAdvice(kind: LimitKind, noun = "items"): string {
  const purchasable = upgradesPurchasable();
  switch (kind) {
    case "monthly":
      return purchasable
        ? "Upgrade the plan or buy an action pack from Settings > Billing to continue, or wait for the monthly reset."
        : `This allowance resets on ${nextUsageReset()} (UTC). Contact support@anlyon.com if this blocks you; there is no automatic upgrade or charge.`;
    case "resource":
      return purchasable
        ? `Remove unused ${noun}, or move to a larger plan (Starter, Pro or Team) for more.`
        : `Remove unused ${noun} to free up room.`;
    case "storage":
      return purchasable
        ? "Remove stored data, or move to a larger plan (Starter, Pro or Team) for more storage."
        : "Remove stored data to free up space.";
    case "paid_only":
      return purchasable
        ? "Choose a plan (Starter, Pro or Team) from Settings > Billing to use this."
        : "Contact support@anlyon.com to have it turned on for this workspace.";
  }
}
