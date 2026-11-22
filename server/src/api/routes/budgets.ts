import { Hono, type Context, type Next } from "hono";
import { assertCallerPermission, requireApiKey, requireApiKeyResourceScopes } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody } from "../middleware/validation.ts";
import { putBudgetSchema } from "../../utils/validation.ts";
import { budgetKeyEnvironment, deleteBudget, getBudget, listBudgets, putBudget } from "../../core/billing/budgets.ts";
import { pathParam } from "../params.ts";
import { signOffIfLoosening } from "../governance-gate.ts";

const budgetsRouter = new Hono();

const budgetEnvironment = (c: Context): string | undefined =>
  c.get("authType") === "session" ? undefined : (c.get("environmentId") as string);

budgetsRouter.use("*", requireApiKey);
budgetsRouter.use("*", requireApiKeyResourceScopes("budgets:read", "budgets:write"));
budgetsRouter.use("*", rateLimitByWorkspace);

async function requireLimitsManageForKey(c: Context, next: Next) {
  const environmentId = await budgetKeyEnvironment(c.get("workspaceId"), c.req.param("apiKeyId") ?? "");
  if (environmentId) await assertCallerPermission(c, "limits.manage", environmentId);
  await next();
}

budgetsRouter.get("/", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const budgets = await listBudgets(workspaceId, budgetEnvironment(c));
  return c.json({ success: true, data: budgets });
});

budgetsRouter.get("/:apiKeyId", async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const budget = await getBudget(workspaceId, pathParam(c, "apiKeyId"), budgetEnvironment(c));
  return c.json({ success: true, data: budget });
});

budgetsRouter.put("/:apiKeyId", requireLimitsManageForKey, validateBody(putBudgetSchema), async (c: Context) => {
  const workspaceId = c.get("workspaceId");
  const body = c.get("validatedBody");
  const pending = await signOffIfLoosening(c, "budget.put", { apiKeyId: pathParam(c, "apiKeyId") }, body);
  if (pending) return pending;
  const budget = await putBudget(workspaceId, pathParam(c, "apiKeyId"), body, budgetEnvironment(c));
  return c.json({ success: true, data: budget });
});

budgetsRouter.delete("/:apiKeyId", requireLimitsManageForKey, async (c: Context) => {
  const pending = await signOffIfLoosening(c, "budget.delete", { apiKeyId: pathParam(c, "apiKeyId") }, {});
  if (pending) return pending;
  const workspaceId = c.get("workspaceId");
  await deleteBudget(workspaceId, pathParam(c, "apiKeyId"), budgetEnvironment(c));
  return c.json({ success: true, data: { deleted: true } });
});

export default budgetsRouter;
