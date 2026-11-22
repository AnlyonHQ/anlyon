import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import { auditRequest } from "../audit-caller.ts";
import { signOffIfLoosening } from "../governance-gate.ts";
import { requireFeature } from "../middleware/feature-gate.ts";
import { callerAuthority, requireApiKey, requireApiKeyScope, requirePermission } from "../middleware/auth.ts";
import { rateLimitByWorkspace } from "../middleware/rateLimit.ts";
import { validateBody } from "../middleware/validation.ts";
import { pathParam } from "../params.ts";
import { AuthorizationError } from "../../utils/errors.ts";
import { assertMayReferenceSecrets } from "../../core/actions/service.ts";
import {
  adoptTools,
  archiveUpstream,
  assertMayAdopt,
  connectUpstream,
  createEndUserConnectLink,
  getUpstream,
  listUpstreams,
  refreshUpstream,
  registerUpstream,
  registrationSecrets,
  UPSTREAM_NAME,
} from "../../core/mcp-upstreams/service.ts";
import { inspectUpstream } from "../../core/mcp-upstreams/inspect.ts";

const impactSchema = z.object({
  dimension: z.string().min(1).max(32),
  unit: z.string().min(1).max(32).optional(),
  amount: z.string().min(1).max(200),
  bound: z.enum(["exact", "upper_bound"]),
}).strict();

export const registerUpstreamSchema = z.object({
  name: z.string().regex(UPSTREAM_NAME, "1 to 32 lowercase letters, digits and hyphens, starting with a letter"),
  url: z.string().url().max(2048),
  headers: z.record(z.string().min(1).max(64), z.string().max(4096)).optional(),
  registryName: z.string().min(1).max(200).nullable().optional(),
  oauth: z.object({
    clientId: z.string().min(1).max(512).nullable().optional(),
    clientSecret: z.string().regex(/^\{\{secret:[A-Z0-9_]+\}\}$/, "a {{secret:NAME}} reference").nullable().optional(),
    scopes: z.array(z.string().min(1).max(200)).max(50).optional(),
    redirectUri: z.string().url().max(2048).nullable().optional(),
    authorizationServer: z.string().url().max(2048).nullable().optional(),
  }).strict().nullable().optional(),
  endUserKey: z.object({
    header: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "a header name"),
  }).strict().nullable().optional(),
}).strict();

export const inspectUpstreamSchema = z.object({
  url: z.string().url().max(2048),
}).strict();

export const endUserConnectLinkSchema = z.object({
  endUserId: z.string().min(1).max(256),
  redirectUrl: z.string().url().max(2048).nullable().optional(),
}).strict();

export const adoptToolsSchema = z.object({
  tools: z.record(
    z.string().min(1).max(200),
    z.object({
      requiresApproval: z.boolean().optional(),
      impact: impactSchema.nullable().optional(),
      description: z.string().max(1000).optional(),
      toolHash: z.string().regex(/^[0-9a-f]{64}$/, "a tool definition hash").optional(),
    }).strict(),
  ).refine((tools) => Object.keys(tools).length > 0 && Object.keys(tools).length <= 100, "Name 1 to 100 tools to adopt"),
}).strict();

async function aPersonInTheConsole(c: Context, next: Next) {
  if (c.get("authType") !== "session") {
    const refused = new AuthorizationError("Connecting an account to an MCP server is a person's consent, so it can only be started in the Anlyon console.");
    refused.fix = { summary: "Ask a person to connect their account on this server's page in the console, then list its tools again with `anlyon mcp tools <name> --refresh`.", docs: "https://docs.anlyon.com/execution/mcp-servers" };
    throw refused;
  }
  await next();
}

const mcpUpstreamsRouter = new Hono();

mcpUpstreamsRouter.use("*", requireFeature("mcp-upstreams"));
mcpUpstreamsRouter.use("*", requireApiKey);
mcpUpstreamsRouter.use("*", rateLimitByWorkspace);

const scope = (c: Context) => ({ workspaceId: c.get("workspaceId") as string, environmentId: c.get("environmentId") as string });

mcpUpstreamsRouter.get("/", requireApiKeyScope("actions:read"), async (c: Context) => {
  const { workspaceId, environmentId } = scope(c);
  return c.json({ success: true, data: await listUpstreams(workspaceId, environmentId) });
});

mcpUpstreamsRouter.post("/", requireApiKeyScope("actions:write"), requirePermission("actions.manage"), validateBody(registerUpstreamSchema), async (c: Context) => {
  const { workspaceId, environmentId } = scope(c);
  const body = c.get("validatedBody") as z.infer<typeof registerUpstreamSchema>;
  assertMayReferenceSecrets(callerAuthority(c), registrationSecrets(body));
  const pending = await signOffIfLoosening(c, "mcp_upstream.register", {}, body);
  if (pending) return pending;
  const upstream = await registerUpstream(workspaceId, environmentId, body, callerAuthority(c));
  auditRequest(c, {
    workspaceId, environmentId, type: "mcp_upstream.registered", resource: { type: "mcp_upstream", id: upstream.id },
    data: {
      name: upstream.name, url: upstream.url, tools: upstream.tools.length, toolsHash: upstream.toolsHash,
      ...(upstream.oauth ? { oauth: { issuer: upstream.oauth.issuer, clientId: upstream.oauth.clientId, publicClient: upstream.oauth.publicClient } } : {}),
      ...(upstream.endUserKey ? { endUserKey: upstream.endUserKey } : {}),
    },
  });
  return c.json({ success: true, data: upstream }, 201);
});

mcpUpstreamsRouter.post("/inspect", requireApiKeyScope("actions:write"), requirePermission("actions.manage"), validateBody(inspectUpstreamSchema), async (c: Context) => {
  const { workspaceId, environmentId } = scope(c);
  const { url } = c.get("validatedBody") as z.infer<typeof inspectUpstreamSchema>;
  return c.json({ success: true, data: await inspectUpstream({ workspaceId, environmentId }, url) });
});

mcpUpstreamsRouter.post("/:id/connect", aPersonInTheConsole, requirePermission("actions.manage"), async (c: Context) => {
  const { workspaceId, environmentId } = scope(c);
  const id = pathParam(c, "id");
  const pending = await signOffIfLoosening(c, "mcp_upstream.connect", { id }, {});
  if (pending) return pending;
  const started = await connectUpstream(workspaceId, environmentId, id);
  auditRequest(c, { workspaceId, environmentId, type: "mcp_upstream.connect_started", resource: { type: "mcp_upstream", id }, data: {} });
  return c.json({ success: true, data: started });
});

mcpUpstreamsRouter.post("/:id/connect-links", requireApiKeyScope("end-users:write"), requirePermission("actions.manage"), validateBody(endUserConnectLinkSchema), async (c: Context) => {
  const { workspaceId, environmentId } = scope(c);
  const id = pathParam(c, "id");
  const body = c.get("validatedBody") as z.infer<typeof endUserConnectLinkSchema>;
  const link = await createEndUserConnectLink(workspaceId, environmentId, id, body);
  auditRequest(c, {
    workspaceId, environmentId, type: "mcp_upstream.connect_link_created", resource: { type: "mcp_upstream", id },
    data: { endUserId: body.endUserId, expiresAt: link.expiresAt.toISOString() },
  });
  return c.json({ success: true, data: link }, 201);
});

mcpUpstreamsRouter.get("/:id", requireApiKeyScope("actions:read"), async (c: Context) => {
  const { workspaceId, environmentId } = scope(c);
  return c.json({ success: true, data: await getUpstream(workspaceId, environmentId, pathParam(c, "id")) });
});

mcpUpstreamsRouter.post("/:id/refresh", requireApiKeyScope("actions:write"), requirePermission("actions.manage"), async (c: Context) => {
  const { workspaceId, environmentId } = scope(c);
  const id = pathParam(c, "id");
  const pending = await signOffIfLoosening(c, "mcp_upstream.refresh", { id }, {});
  if (pending) return pending;
  const upstream = await refreshUpstream(workspaceId, environmentId, id);
  auditRequest(c, {
    workspaceId, environmentId, type: "mcp_upstream.refreshed", resource: { type: "mcp_upstream", id: upstream.id },
    data: {
      toolsHash: upstream.toolsHash, error: upstream.lastError?.message ?? null,
      changed: upstream.adopted.filter((a) => a.state !== "current").map((a) => ({ tool: a.tool, state: a.state })),
    },
  });
  return c.json({ success: true, data: upstream });
});

mcpUpstreamsRouter.post("/:id/adopt", requireApiKeyScope("actions:write"), requirePermission("actions.manage"), validateBody(adoptToolsSchema), async (c: Context) => {
  const { workspaceId, environmentId } = scope(c);
  const id = pathParam(c, "id");
  const body = c.get("validatedBody") as z.infer<typeof adoptToolsSchema>;
  await assertMayAdopt(workspaceId, environmentId, id, callerAuthority(c));
  const pending = await signOffIfLoosening(c, "mcp_upstream.adopt", { id }, body);
  if (pending) return pending;
  const result = await adoptTools(workspaceId, environmentId, id, body.tools, callerAuthority(c));
  for (const adopted of result.adopted) {
    auditRequest(c, {
      workspaceId, environmentId,
      type: adopted.readopted ? "action.definition.updated" : "action.definition.created",
      resource: { type: "action", id: adopted.action.id },
      data: { actionName: adopted.action.name, source: "mcp_adopt", upstreamId: id, tool: adopted.tool, requiresApproval: adopted.action.requiresApproval },
    });
  }
  return c.json({ success: true, data: result }, result.adopted.some((a) => !a.readopted) ? 201 : 200);
});

mcpUpstreamsRouter.post("/:id/archive", requireApiKeyScope("actions:write"), requirePermission("actions.manage"), async (c: Context) => {
  const { workspaceId, environmentId } = scope(c);
  const upstream = await archiveUpstream(workspaceId, environmentId, pathParam(c, "id"));
  auditRequest(c, {
    workspaceId, environmentId, type: "mcp_upstream.archived", resource: { type: "mcp_upstream", id: upstream.id },
    data: { name: upstream.name, disabled: upstream.adopted.map((a) => a.action) },
  });
  return c.json({ success: true, data: upstream });
});

export default mcpUpstreamsRouter;
