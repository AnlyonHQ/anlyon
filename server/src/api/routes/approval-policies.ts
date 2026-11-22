import { Hono, type Context } from "hono";
import { requireApiKey, requireApiKeyResourceScopes, requireApiKeyScope, requirePermission } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody, validateQuery } from "../middleware/validation.ts";
import { AuthorizationError } from "../../utils/errors.ts";
import { policyActor } from "../policy-actor.ts";
import {
  createEnvironmentApprovalPolicySchema,
  updateEnvironmentApprovalPolicySchema,
  evaluateApprovalPoliciesSchema,
  policyVersionsQuerySchema,
  policyFilePlanSchema,
  policyFileApplySchema,
  policyFileTestSchema,
} from "../../utils/validation.ts";
import { createPolicy, deletePolicy, getPolicy, listPolicies, updatePolicy, previewPolicies, listPolicyVersions, getPolicyVersion } from "../../core/approvals/policy.ts";
import { versionPageResponse, versionParam } from "../policy-versions.ts";
import { applyPolicyFile, planPolicyFile, testPolicyFile } from "../../core/approvals/policy-files.ts";
import { pathParam } from "../params.ts";
import { signOffIfLoosening } from "../governance-gate.ts";

const approvalPoliciesRouter = new Hono();

approvalPoliciesRouter.use("*", requireApiKey);
approvalPoliciesRouter.use("*", rateLimitByWorkspace);

approvalPoliciesRouter.post("/evaluate", requireApiKeyScope("policies:read"), validateBody(evaluateApprovalPoliciesSchema), async (c: Context) => {
  const result = await previewPolicies(c.get("workspaceId"), credentialEnvironment(c), c.get("validatedBody"));
  return c.json({ success: true, data: result });
});

approvalPoliciesRouter.post("/files/plan", requireApiKeyScope("policies:read"), validateBody(policyFilePlanSchema), async (c: Context) => {
  const plan = await planPolicyFile(c.get("workspaceId"), credentialEnvironment(c), c.get("validatedBody").source);
  return c.json({ success: true, data: plan });
});

approvalPoliciesRouter.post("/files/test", requireApiKeyScope("policies:read"), validateBody(policyFileTestSchema), async (c: Context) => {
  const body = c.get("validatedBody");
  const result = await testPolicyFile(c.get("workspaceId"), credentialEnvironment(c), body.source, body.cases);
  return c.json({ success: true, data: result });
});

approvalPoliciesRouter.use("*", requireApiKeyResourceScopes("policies:read", "policies:write"));

approvalPoliciesRouter.post("/files/apply", requirePermission("policies.manage"), validateBody(policyFileApplySchema), async (c: Context) => {
  const body = c.get("validatedBody");
  credentialEnvironment(c);
  const pending = await signOffIfLoosening(c, "policy_file.apply", {}, body);
  if (pending) return pending;
  const result = await applyPolicyFile(c.get("workspaceId"), credentialEnvironment(c), body.source, body.digest, {
    environmentId: credentialEnvironment(c), actor: policyActor(c),
  }, body.changeNote);
  return c.json({ success: true, data: result });
});

function credentialEnvironment(c: Context): string {
  const environmentId = c.get("environmentId") as string;
  const requested = c.req.query("environmentId");
  if (requested && requested !== environmentId) {
    throw new AuthorizationError("This credential can only manage policies in its own environment");
  }
  return environmentId;
}

approvalPoliciesRouter.get("/", async (c: Context) => {
  const policies = await listPolicies(c.get("workspaceId"), credentialEnvironment(c), {
    actionName: c.req.query("actionName") || undefined,
  });
  return c.json({ success: true, data: policies });
});

approvalPoliciesRouter.post("/", requirePermission("policies.manage"), validateBody(createEnvironmentApprovalPolicySchema), async (c: Context) => {
  credentialEnvironment(c);
  const pending = await signOffIfLoosening(c, "policy.create", {}, c.get("validatedBody"));
  if (pending) return pending;
  const policy = await createPolicy(c.get("workspaceId"), {
    ...c.get("validatedBody"),
    environmentId: credentialEnvironment(c),
  }, { actor: policyActor(c) });
  return c.json({ success: true, data: policy }, 201);
});

approvalPoliciesRouter.get("/:policyId", async (c: Context) => {
  const policy = await getPolicy(c.get("workspaceId"), pathParam(c, "policyId"), {
    environmentId: credentialEnvironment(c),
  });
  return c.json({ success: true, data: policy });
});

approvalPoliciesRouter.get("/:policyId/versions", validateQuery(policyVersionsQuerySchema), async (c: Context) => {
  const query = c.get("validatedQuery");
  const page = await listPolicyVersions(c.get("workspaceId"), pathParam(c, "policyId"), {
    environmentId: credentialEnvironment(c),
  }, { limit: query.limit, before: query.before });
  return c.json(versionPageResponse(page, query.limit));
});

approvalPoliciesRouter.get("/:policyId/versions/:version", async (c: Context) => {
  const version = await getPolicyVersion(c.get("workspaceId"), pathParam(c, "policyId"), versionParam(c), {
    environmentId: credentialEnvironment(c),
  });
  return c.json({ success: true, data: version });
});

approvalPoliciesRouter.patch("/:policyId", requirePermission("policies.manage"), validateBody(updateEnvironmentApprovalPolicySchema), async (c: Context) => {
  credentialEnvironment(c);
  const pending = await signOffIfLoosening(c, "policy.update", { policyId: pathParam(c, "policyId") }, c.get("validatedBody"));
  if (pending) return pending;
  const policy = await updatePolicy(c.get("workspaceId"), pathParam(c, "policyId"), c.get("validatedBody"), {
    environmentId: credentialEnvironment(c),
    actor: policyActor(c),
  });
  return c.json({ success: true, data: policy });
});

approvalPoliciesRouter.delete("/:policyId", requirePermission("policies.manage"), async (c: Context) => {
  credentialEnvironment(c);
  const pending = await signOffIfLoosening(c, "policy.delete", { policyId: pathParam(c, "policyId") }, {});
  if (pending) return pending;
  await deletePolicy(c.get("workspaceId"), pathParam(c, "policyId"), { environmentId: credentialEnvironment(c), actor: policyActor(c) });
  return c.json({ success: true, data: { deleted: true } });
});

export default approvalPoliciesRouter;
