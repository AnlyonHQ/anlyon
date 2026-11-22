import type { Context, Next } from "hono";
import { isFeatureEnabled, type FeatureKey } from "@anlyon/feature-flags";
import { NotFoundError } from "../../utils/errors.ts";

export function requireFeature(feature: FeatureKey, deployed: () => boolean = () => true) {
  return async (_c: Context, next: Next) => {
    if (!isFeatureEnabled(feature) || !deployed()) {
      throw new NotFoundError("Endpoint");
    }
    await next();
  };
}
