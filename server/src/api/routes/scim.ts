import { Hono, type Context, type Next } from "hono";
import { isFeatureEnabled } from "../../core/edition/features.ts";
import {
  createScimGroup,
  createScimUser,
  deleteScimGroup,
  deleteScimUser,
  getScimGroup,
  getScimUser,
  listScimGroups,
  listScimUsers,
  patchScimGroup,
  patchScimUser,
  replaceScimGroup,
  replaceScimUser,
} from "../../core/scim/service.ts";
import { authenticateScimToken, SCIM_BASE_URL } from "../../core/scim/settings.ts";
import {
  listResponse,
  parsePagination,
  resourceTypes,
  SCIM_CONTENT_TYPE,
  SCIM_SCHEMAS,
  ScimError,
  scimUnauthorizedResponse,
  serviceProviderConfig,
} from "../../core/scim/protocol.ts";
import { ApiError } from "../../utils/errors.ts";
import { createLogger } from "../../lib/logger.ts";
import { trustedClientIp } from "../client-ip.ts";
import { markCredentialRejected } from "../credential-rejection.ts";
import { pathParam } from "../params.ts";

const logger = createLogger({ module: "scim" });

const scim = new Hono<{ Variables: { scimWorkspaceId: string } }>();

function scimJson(c: Context, body: unknown, status: 200 | 201 = 200) {
  return c.body(JSON.stringify(body), status, { "Content-Type": SCIM_CONTENT_TYPE });
}

function scimErrorResponse(c: Context, error: ScimError) {
  return c.body(JSON.stringify(error.toJSON()), error.status as 400, { "Content-Type": SCIM_CONTENT_TYPE });
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown; cause?: { code?: unknown } })?.code ?? (err as { cause?: { code?: unknown } })?.cause?.code;
  return code === "23505";
}

scim.onError((err, c) => {
  if (err instanceof ScimError) return scimErrorResponse(c, err);
  if (err instanceof ApiError) return scimErrorResponse(c, new ScimError(err.statusCode, err.message));
  if (isUniqueViolation(err)) {
    return scimErrorResponse(c, new ScimError(409, "A resource with these unique attributes already exists", "uniqueness"));
  }
  logger.error({ error: err instanceof Error ? err.message : String(err) }, "SCIM request failed");
  return scimErrorResponse(c, new ScimError(500, "Internal error. The request can be retried."));
});

scim.use("*", async (c: Context, next: Next) => {
  if (!isFeatureEnabled("scim")) throw new ScimError(404, "Not found");
  const header = c.req.header("Authorization") ?? "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const workspaceId = token ? await authenticateScimToken(token) : null;
  if (!workspaceId) {
    logger.warn({ ip: trustedClientIp((name) => c.req.header(name)), path: c.req.path, tokenPresent: Boolean(token) }, "SCIM request refused: invalid bearer token");
    markCredentialRejected(c);
    return scimUnauthorizedResponse();
  }
  c.set("scimWorkspaceId", workspaceId);
  await next();
});

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ScimError(400, "The request body is not valid JSON", "invalidSyntax");
  }
}

scim.get("/ServiceProviderConfig", (c) => scimJson(c, serviceProviderConfig(`${SCIM_BASE_URL}`)));

scim.get("/ResourceTypes", (c) => {
  const types = resourceTypes(SCIM_BASE_URL);
  return scimJson(c, listResponse(types, types.length, 1));
});

scim.get("/Schemas", (c) => {
  const schemas = [
    { schemas: [SCIM_SCHEMAS.schema], id: SCIM_SCHEMAS.user, name: "User" },
    { schemas: [SCIM_SCHEMAS.schema], id: SCIM_SCHEMAS.group, name: "Group" },
  ];
  return scimJson(c, listResponse(schemas, schemas.length, 1));
});

scim.get("/Users", async (c) => {
  const { startIndex, count } = parsePagination({ startIndex: c.req.query("startIndex"), count: c.req.query("count") });
  return scimJson(c, await listScimUsers(c.get("scimWorkspaceId"), { filter: c.req.query("filter"), startIndex, count }));
});

scim.post("/Users", async (c) => {
  return scimJson(c, await createScimUser(c.get("scimWorkspaceId"), await jsonBody(c)), 201);
});

scim.get("/Users/:id", async (c) => {
  return scimJson(c, await getScimUser(c.get("scimWorkspaceId"), pathParam(c, "id")));
});

scim.put("/Users/:id", async (c) => {
  return scimJson(c, await replaceScimUser(c.get("scimWorkspaceId"), pathParam(c, "id"), await jsonBody(c)));
});

scim.patch("/Users/:id", async (c) => {
  return scimJson(c, await patchScimUser(c.get("scimWorkspaceId"), pathParam(c, "id"), (await jsonBody(c)) as object));
});

scim.delete("/Users/:id", async (c) => {
  await deleteScimUser(c.get("scimWorkspaceId"), pathParam(c, "id"));
  return c.body(null, 204);
});

scim.get("/Groups", async (c) => {
  const { startIndex, count } = parsePagination({ startIndex: c.req.query("startIndex"), count: c.req.query("count") });
  return scimJson(
    c,
    await listScimGroups(c.get("scimWorkspaceId"), {
      filter: c.req.query("filter"),
      startIndex,
      count,
      excludedAttributes: c.req.query("excludedAttributes"),
    }),
  );
});

scim.post("/Groups", async (c) => {
  return scimJson(c, await createScimGroup(c.get("scimWorkspaceId"), await jsonBody(c)), 201);
});

scim.get("/Groups/:id", async (c) => {
  return scimJson(c, await getScimGroup(c.get("scimWorkspaceId"), pathParam(c, "id"), c.req.query("excludedAttributes")));
});

scim.put("/Groups/:id", async (c) => {
  return scimJson(c, await replaceScimGroup(c.get("scimWorkspaceId"), pathParam(c, "id"), await jsonBody(c)));
});

scim.patch("/Groups/:id", async (c) => {
  await patchScimGroup(c.get("scimWorkspaceId"), pathParam(c, "id"), (await jsonBody(c)) as object);
  return c.body(null, 204);
});

scim.delete("/Groups/:id", async (c) => {
  await deleteScimGroup(c.get("scimWorkspaceId"), pathParam(c, "id"));
  return c.body(null, 204);
});

export default scim;
