import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.ts";
import { environments } from "./environments.ts";

export const environmentOauthApps = pgTable(
  "environment_oauth_apps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),
    integrationKey: text("integration_key").notNull(),
    clientId: text("client_id").notNull(),
    clientSecretEncrypted: text("client_secret_encrypted").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    environmentIntegrationUnique: unique("environment_oauth_apps_env_integration_unique").on(table.environmentId, table.integrationKey),
  }),
);

export type EnvironmentOAuthAppRow = typeof environmentOauthApps.$inferSelect;
