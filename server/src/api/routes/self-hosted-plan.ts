import { Hono } from "hono";
import { requireApiKey, requireApiKeyResourceScopes } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { getCurrentUsageView, getPlanView, getQuotaView } from "../plan-views.ts";

const selfHostedPlanRouter = new Hono({ strict: false });

selfHostedPlanRouter.use("*", requireApiKey);
selfHostedPlanRouter.use("*", requireApiKeyResourceScopes("billing:read"));
selfHostedPlanRouter.use("*", rateLimitByWorkspace);

selfHostedPlanRouter.get("/plan", getPlanView);
selfHostedPlanRouter.get("/usage/current", getCurrentUsageView);
selfHostedPlanRouter.get("/quota", getQuotaView);

export default selfHostedPlanRouter;
