import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { environments } from "./environments.ts";
import { workspaces } from "./workspaces.ts";

export interface McpToolSnapshot {
  name: string;
  hash: string;
  definition: Record<string, unknown>;
  suggestedClass: "read" | "write" | "irreversible" | "destructive";
  reasons: string[];
}

export interface McpUpstreamOAuth {
  resource: string;
  issuer: string;
  authorizationServers?: string[];
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopesSupported: string[];
  scopes: string[];
  clientRegistration?: "pre_registered" | "client_metadata_document" | "dynamic";
  clientId: string;
  clientSecretName: string | null;
  tokenEndpointAuthMethod?: "none" | "client_secret_post" | "client_secret_basic";
  clientSecretExpiresAt?: number;
  registrationEndpoint?: string | null;
  authorizationResponseIss?: boolean;
  tokenEndpointAuthMethods?: string[];
  advertised: { dynamicRegistration: boolean; clientIdMetadataDocuments: boolean; pkceS256: boolean };
}

export interface McpUpstreamEndUserKey {
  header: string;
}

export interface McpUpstreamError {
  code: string;
  message: string;
  at: string;
}

export interface McpToolChange {
  tool: string;
  kind: "changed" | "removed" | "added";
  action: string | null;
  actionId: string | null;
  pinnedHash: string | null;
  currentHash: string | null;
  suggestedClass: McpToolSnapshot["suggestedClass"] | null;
  before: Record<string, unknown> | null;
  detectedAt: string;
}

export interface McpToolChanges {
  items: McpToolChange[];
  pending: Record<string, string>;
}

export const mcpUpstreams = pgTable(
  "mcp_upstreams",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    upstreamId: text("upstream_id").notNull().unique(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    registryName: text("registry_name"),
    protocolVersion: text("protocol_version"),
    transport: text("transport").$type<"streamable-http" | "sse" | null>(),
    serverInfo: jsonb("server_info").$type<{ name?: string; title?: string; version?: string } | null>(),
    tools: jsonb("tools").$type<McpToolSnapshot[]>().notNull().default([]),
    toolsHash: text("tools_hash"),
    listedAt: timestamp("listed_at"),
    lastError: jsonb("last_error").$type<McpUpstreamError | null>(),
    oauth: jsonb("oauth").$type<McpUpstreamOAuth | null>(),
    endUserKey: jsonb("end_user_key").$type<McpUpstreamEndUserKey | null>(),
    operatorConnectionId: text("operator_connection_id"),
    listedWith: text("listed_with").$type<"anonymous" | "headers" | "operator" | null>(),
    checkedAt: timestamp("checked_at"),
    nextCheckAt: timestamp("next_check_at").defaultNow().notNull(),
    checkFailures: integer("check_failures").notNull().default(0),
    toolChanges: jsonb("tool_changes").$type<McpToolChanges | null>(),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    nameUnique: uniqueIndex("mcp_upstreams_env_name_unique")
      .on(table.workspaceId, table.environmentId, table.name)
      .where(sql`${table.archivedAt} is null`),
    environmentIdx: index("mcp_upstreams_environment_idx").on(table.environmentId),
    checkDueIdx: index("mcp_upstreams_check_due_idx").on(table.nextCheckAt).where(sql`${table.archivedAt} is null`),
  }),
);

export type McpUpstream = typeof mcpUpstreams.$inferSelect;
