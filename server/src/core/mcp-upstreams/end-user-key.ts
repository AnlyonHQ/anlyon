import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { mcpUpstreams, type McpUpstream } from "../../db/schema/mcp-upstreams.ts";
import { ValidationError } from "../../utils/errors.ts";

const KEY = /^mcp-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SECRET_REFERENCE = /\{\{\s*secret:([A-Z0-9_]+)\s*\}\}/g;
const ANY_REFERENCE = /\{\{/g;

export const UPSTREAM_KEY_MARK = "upstreamKey";

export function rowHoldsUpstreamKey(row: { integrationKey: string; connectionConfig: Record<string, unknown> | null }): boolean {
  return KEY.test(row.integrationKey) && row.connectionConfig?.[UPSTREAM_KEY_MARK] === true;
}

export function assertNoHeaderTwice(headers: Record<string, string>): void {
  const spelled = new Set<string>();
  for (const name of Object.keys(headers)) {
    if (spelled.has(name.toLowerCase())) throw new ValidationError(`Header ${name} is given twice, in two spellings. Give each header once.`);
    spelled.add(name.toLowerCase());
  }
}

export function endUserKeyHeader(headers: Record<string, string>, wanted: string): { header: string; secret: string } {
  assertNoHeaderTwice(headers);
  const header = Object.keys(headers).find((name) => name.toLowerCase() === wanted.toLowerCase());
  if (!header) {
    throw new ValidationError(`endUserKey.header names ${wanted}, which is not one of this server's headers. Add it with your own key as a {{secret:NAME}} reference: that key lists the tools and is used for calls made for no end user.`);
  }
  const value = headers[header]!;
  const secrets = [...value.matchAll(SECRET_REFERENCE)].map((match) => match[1]!);
  if (secrets.length !== 1 || (value.match(ANY_REFERENCE) ?? []).length !== 1) {
    throw new ValidationError(`Header ${header} must hold exactly one {{secret:NAME}} reference: an end user's own key is sent in its place.`);
  }
  return { header, secret: secrets[0]! };
}

export const endUserKeyRef = (connection: string) => `{{connection:${connection}}}`;

export const endUserKeySecretName = (connection: string) => `connection:${connection}`;

export function withEndUserKeyRef(headers: Record<string, string>, endUserKey: { connection: string; header: string }): Record<string, string> {
  const { header } = endUserKeyHeader(headers, endUserKey.header);
  return { ...headers, [header]: headers[header]!.replace(SECRET_REFERENCE, () => endUserKeyRef(endUserKey.connection)) };
}

export function withoutEndUserKeyHeader(headers: Record<string, string>, header: string): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== header.toLowerCase()));
}

export const UPSTREAM_KEY_MAX_LENGTH = 4096;

export function readUpstreamKey(given: unknown): string {
  const key = typeof given === "string" ? given.trim() : "";
  if (!key) throw new ValidationError("Enter the key.");
  if (key.length > UPSTREAM_KEY_MAX_LENGTH || !/^[\x21-\x7e]+$/.test(key) || key.includes("{{")) {
    throw new ValidationError(`That does not look like a key: it must be at most ${UPSTREAM_KEY_MAX_LENGTH} characters with no spaces. Nothing was saved.`);
  }
  return key;
}

export type EndUserUpstream = Pick<McpUpstream, "id" | "upstreamId" | "workspaceId" | "environmentId" | "name" | "url" | "headers" | "transport" | "endUserKey"> & {
  connect: "oauth" | "key";
};

export async function liveEndUserUpstream(
  scope: { workspaceId: string; environmentId: string }, integrationKey: string,
): Promise<EndUserUpstream | null> {
  const id = KEY.exec(integrationKey)?.[1];
  if (!id) return null;
  const [row] = await db.select().from(mcpUpstreams).where(and(
    eq(mcpUpstreams.id, id),
    eq(mcpUpstreams.workspaceId, scope.workspaceId),
    eq(mcpUpstreams.environmentId, scope.environmentId),
    isNull(mcpUpstreams.archivedAt),
  ));
  if (!row || (!row.oauth && !row.endUserKey)) return null;
  return {
    id: row.id, upstreamId: row.upstreamId, workspaceId: row.workspaceId, environmentId: row.environmentId,
    name: row.name, url: row.url, headers: row.headers, transport: row.transport, endUserKey: row.endUserKey,
    connect: row.oauth ? "oauth" : "key",
  };
}
