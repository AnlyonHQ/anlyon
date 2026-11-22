export const SCIM_SCHEMAS = {
  user: "urn:ietf:params:scim:schemas:core:2.0:User",
  group: "urn:ietf:params:scim:schemas:core:2.0:Group",
  listResponse: "urn:ietf:params:scim:api:messages:2.0:ListResponse",
  patchOp: "urn:ietf:params:scim:api:messages:2.0:PatchOp",
  error: "urn:ietf:params:scim:api:messages:2.0:Error",
  serviceProviderConfig: "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
  resourceType: "urn:ietf:params:scim:schemas:core:2.0:ResourceType",
  schema: "urn:ietf:params:scim:schemas:core:2.0:Schema",
} as const;

export const SCIM_CONTENT_TYPE = "application/scim+json";

export type ScimErrorType = "invalidFilter" | "uniqueness" | "mutability" | "invalidSyntax" | "invalidValue" | "noTarget";

export class ScimError extends Error {
  constructor(
    public status: number,
    public detail: string,
    public scimType?: ScimErrorType,
  ) {
    super(detail);
    this.name = "ScimError";
  }

  toJSON() {
    return {
      schemas: [SCIM_SCHEMAS.error],
      status: String(this.status),
      ...(this.scimType ? { scimType: this.scimType } : {}),
      detail: this.detail,
    };
  }
}

export function scimUnauthorizedResponse(): Response {
  return new Response(JSON.stringify(new ScimError(401, "A valid SCIM bearer token is required").toJSON()), {
    status: 401,
    headers: { "Content-Type": SCIM_CONTENT_TYPE, "WWW-Authenticate": 'Bearer realm="anlyon-scim"' },
  });
}

export interface ScimMeta {
  resourceType: "User" | "Group";
  created: string;
  lastModified: string;
  location: string;
}

export interface ScimUserResource {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name?: { formatted?: string };
  displayName?: string;
  emails: Array<{ value: string; primary: boolean; type: "work" }>;
  active: boolean;
  groups?: Array<{ value: string; display: string; $ref: string }>;
  meta: ScimMeta;
}

export interface ScimGroupResource {
  schemas: string[];
  id: string;
  externalId?: string;
  displayName: string;
  members?: Array<{ value: string; display?: string; $ref: string }>;
  meta: ScimMeta;
}

export function toScimUser(
  baseUrl: string,
  row: {
    id: string;
    externalId: string | null;
    userName: string;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
  },
  person: { name: string; email: string },
  groups: Array<{ id: string; displayName: string }> = [],
): ScimUserResource {
  const location = `${baseUrl}/Users/${row.id}`;
  return {
    schemas: [SCIM_SCHEMAS.user],
    id: row.id,
    ...(row.externalId ? { externalId: row.externalId } : {}),
    userName: row.userName,
    ...(person.name ? { name: { formatted: person.name }, displayName: person.name } : {}),
    emails: [{ value: person.email, primary: true, type: "work" }],
    active: row.active,
    groups: groups.map((g) => ({ value: g.id, display: g.displayName, $ref: `${baseUrl}/Groups/${g.id}` })),
    meta: {
      resourceType: "User",
      created: row.createdAt.toISOString(),
      lastModified: row.updatedAt.toISOString(),
      location,
    },
  };
}

export function toScimGroup(
  baseUrl: string,
  row: { id: string; externalId: string | null; displayName: string; createdAt: Date; updatedAt: Date },
  members: Array<{ id: string; userName: string }> | null,
): ScimGroupResource {
  return {
    schemas: [SCIM_SCHEMAS.group],
    id: row.id,
    ...(row.externalId ? { externalId: row.externalId } : {}),
    displayName: row.displayName,
    ...(members
      ? { members: members.map((m) => ({ value: m.id, display: m.userName, $ref: `${baseUrl}/Users/${m.id}` })) }
      : {}),
    meta: {
      resourceType: "Group",
      created: row.createdAt.toISOString(),
      lastModified: row.updatedAt.toISOString(),
      location: `${baseUrl}/Groups/${row.id}`,
    },
  };
}

export function listResponse<T>(resources: T[], totalResults: number, startIndex: number) {
  return {
    schemas: [SCIM_SCHEMAS.listResponse],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

export const MAX_ATTRIBUTE_LENGTH = 512;

export function parsePagination(query: { startIndex?: string; count?: string }): { startIndex: number; count: number } {
  const start = Number.parseInt(query.startIndex ?? "1", 10);
  const count = Number.parseInt(query.count ?? "100", 10);
  return {
    startIndex: Number.isFinite(start) && start >= 1 ? Math.min(start, 2 ** 31 - 1) : 1,
    count: Number.isFinite(count) ? Math.min(Math.max(count, 0), 200) : 100,
  };
}

export function serviceProviderConfig(documentationUri: string) {
  return {
    schemas: [SCIM_SCHEMAS.serviceProviderConfig],
    documentationUri,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "Bearer token",
        description: "The SCIM token from the workspace's SCIM settings, sent as Authorization: Bearer.",
        primary: true,
      },
    ],
    meta: { resourceType: "ServiceProviderConfig" },
  };
}

export function resourceTypes(baseUrl: string) {
  return [
    {
      schemas: [SCIM_SCHEMAS.resourceType],
      id: "User",
      name: "User",
      endpoint: "/Users",
      schema: SCIM_SCHEMAS.user,
      meta: { resourceType: "ResourceType", location: `${baseUrl}/ResourceTypes/User` },
    },
    {
      schemas: [SCIM_SCHEMAS.resourceType],
      id: "Group",
      name: "Group",
      endpoint: "/Groups",
      schema: SCIM_SCHEMAS.group,
      meta: { resourceType: "ResourceType", location: `${baseUrl}/ResourceTypes/Group` },
    },
  ];
}
