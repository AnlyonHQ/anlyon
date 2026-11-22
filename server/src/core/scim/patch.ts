import { MAX_ATTRIBUTE_LENGTH, ScimError, SCIM_SCHEMAS } from "./protocol.ts";

export interface PatchOperation {
  op: string;
  path?: string;
  value?: unknown;
}

export interface PatchRequest {
  schemas?: unknown;
  Operations?: unknown;
}

function operationsOf(body: PatchRequest): Array<{ op: "add" | "replace" | "remove"; path?: string; value?: unknown }> {
  if (!Array.isArray(body.schemas) || !body.schemas.includes(SCIM_SCHEMAS.patchOp)) {
    throw new ScimError(400, `A PATCH body must list the schema ${SCIM_SCHEMAS.patchOp}`, "invalidSyntax");
  }
  if (!Array.isArray(body.Operations) || body.Operations.length === 0) {
    throw new ScimError(400, "A PATCH body needs at least one operation in Operations", "invalidSyntax");
  }
  return body.Operations.map((raw) => {
    const operation = raw as PatchOperation;
    const op = typeof operation?.op === "string" ? operation.op.toLowerCase() : "";
    if (op !== "add" && op !== "replace" && op !== "remove") {
      throw new ScimError(400, `Unsupported PATCH op "${String(operation?.op)}"`, "invalidSyntax");
    }
    const path = typeof operation.path === "string" && operation.path.trim() ? operation.path.trim() : undefined;
    return { op, path, value: operation.value };
  });
}

export function coerceBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === "true";
  throw new ScimError(400, `Expected a boolean, got ${JSON.stringify(value)}`, "invalidValue");
}

function stringValue(attribute: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ScimError(400, `${attribute} must be a non-empty string`, "invalidValue");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_ATTRIBUTE_LENGTH) {
    throw new ScimError(400, `${attribute} may be at most ${MAX_ATTRIBUTE_LENGTH} characters`, "invalidValue");
  }
  return trimmed;
}

const stripUserUrn = (path: string) => path.replace(/^urn:ietf:params:scim:schemas:core:2\.0:User:/i, "");

export interface UserPatchState {
  userName: string;
  externalId: string | null;
  active: boolean;
}

function applyUserAttribute(state: UserPatchState, op: string, attribute: string, value: unknown): void {
  switch (stripUserUrn(attribute).toLowerCase()) {
    case "active":
      if (op !== "remove") state.active = coerceBoolean(value);
      return;
    case "username":
      if (op === "remove") throw new ScimError(400, "userName is required and cannot be removed", "mutability");
      state.userName = stringValue("userName", value);
      return;
    case "externalid":
      state.externalId = op === "remove" ? null : stringValue("externalId", value);
      return;
    default:
      return;
  }
}

export function applyUserPatch(state: UserPatchState, body: PatchRequest): UserPatchState {
  const next = { ...state };
  for (const { op, path, value } of operationsOf(body)) {
    if (path) {
      applyUserAttribute(next, op, path, value);
      continue;
    }
    if (op === "remove") throw new ScimError(400, "A remove operation needs a path", "noTarget");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ScimError(400, "A PATCH operation without a path needs an object value", "invalidSyntax");
    }
    for (const [attribute, attributeValue] of Object.entries(value)) {
      applyUserAttribute(next, op, attribute, attributeValue);
    }
  }
  return next;
}

export interface GroupPatchState {
  displayName: string;
  externalId: string | null;
  members: Set<string>;
}

const MEMBER_FILTER = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i;

function memberIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => {
    const id = (entry as { value?: unknown })?.value;
    if (typeof id !== "string" || !id) throw new ScimError(400, "Each member needs a value (the SCIM User id)", "invalidValue");
    return id;
  });
}

function applyGroupAttribute(state: GroupPatchState, op: string, attribute: string, value: unknown): void {
  const filtered = MEMBER_FILTER.exec(attribute);
  if (filtered) {
    if (op !== "remove") throw new ScimError(400, `Only remove is supported on ${attribute}`, "invalidSyntax");
    state.members.delete(filtered[1]);
    return;
  }
  switch (attribute.replace(/^urn:ietf:params:scim:schemas:core:2\.0:Group:/i, "").toLowerCase()) {
    case "members": {
      const ids = memberIds(value);
      if (op === "add") for (const id of ids) state.members.add(id);
      else if (op === "replace") state.members = new Set(ids);
      else if (ids.length > 0) for (const id of ids) state.members.delete(id);
      else state.members.clear();
      return;
    }
    case "displayname":
      if (op === "remove") throw new ScimError(400, "displayName is required and cannot be removed", "mutability");
      state.displayName = stringValue("displayName", value);
      return;
    case "externalid":
      state.externalId = op === "remove" ? null : stringValue("externalId", value);
      return;
    default:
      return;
  }
}

export function applyGroupPatch(state: GroupPatchState, body: PatchRequest): GroupPatchState {
  const next: GroupPatchState = { ...state, members: new Set(state.members) };
  for (const { op, path, value } of operationsOf(body)) {
    if (path) {
      applyGroupAttribute(next, op, path, value);
      continue;
    }
    if (op === "remove") throw new ScimError(400, "A remove operation needs a path", "noTarget");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ScimError(400, "A PATCH operation without a path needs an object value", "invalidSyntax");
    }
    for (const [attribute, attributeValue] of Object.entries(value)) {
      applyGroupAttribute(next, op, attribute, attributeValue);
    }
  }
  return next;
}
