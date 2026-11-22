import type { Context, Next } from "hono";
import { ApiError } from "../../utils/errors.ts";
import { expensiveWorkPaused as brakeEngaged } from "../../core/billing/work-admission.ts";
import { requireVerifiedSender } from "./verified-sender.ts";

export function expensiveWorkPaused(): ApiError {
  return new ApiError(503, "EXPENSIVE_WORK_PAUSED",
    "New processing is temporarily paused to protect the service. Sign-in, viewing and deleting your data still work. Try again shortly.");
}

export async function requireCostAdmission(c: Context, next: Next): Promise<Response | void> {
  if (brakeEngaged()) throw expensiveWorkPaused();
  return requireVerifiedSender(c, next);
}
