import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.ts";
import { environments } from "./environments.ts";

export const oauthConnections = pgTable(
  "oauth_connections",
  {
    id: text("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),
    integrationKey: text("integration_key").notNull(),
    endUserId: text("end_user_id").notNull(),
    subjectEndUserId: text("subject_end_user_id"),
    oauthClientId: text("oauth_client_id"),
    pendingConfirmationUntil: timestamp("pending_confirmation_until", { withTimezone: true }),

    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    scopes: text("scopes"),
    connectionConfig: jsonb("connection_config").$type<Record<string, unknown>>().default({}).notNull(),

    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    refreshLeaseUntil: timestamp("refresh_lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    workspaceEnvIdx: index("oauth_connections_workspace_env_idx").on(table.workspaceId, table.environmentId),
    endUserUnique: uniqueIndex("oauth_connections_end_user_unique")
      .on(table.environmentId, table.integrationKey, table.subjectEndUserId)
      .where(sql`subject_end_user_id IS NOT NULL AND revoked_at IS NULL AND pending_confirmation_until IS NULL`),
    endUserIdx: index("oauth_connections_end_user_idx").on(table.environmentId, table.subjectEndUserId),
  }),
);

export type OAuthConnectionRow = typeof oauthConnections.$inferSelect;
