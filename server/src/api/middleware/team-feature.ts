import type { Context, Next } from "hono";
import { assertTeamFeature, type TeamFeature } from "../../core/billing/team-features.ts";

export function requireTeamFeature(feature: TeamFeature) {
  return async (c: Context, next: Next) => {
    await assertTeamFeature(c.get("workspaceId") as string, feature);
    await next();
  };
}
