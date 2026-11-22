import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.ts";
import { environments } from "./environments.ts";

export type SecretStoreType = "aws_secrets_manager" | "hashicorp_vault";

export interface AwsSecretStoreConfig {
  region: string;
  auth: "access_key" | "assume_role";
  roleArn?: string | null;
  externalId?: string | null;
}

export interface VaultSecretStoreConfig {
  address: string;
  namespace?: string | null;
  mount: string;
  auth: "token" | "approle";
  authMount?: string | null;
}

export type SecretStoreConfig = AwsSecretStoreConfig | VaultSecretStoreConfig;

export type SecretStoreFailure =
  | "store_unreachable"
  | "store_denied"
  | "reference_not_found";

export interface SecretStoreHealth {
  status: "active" | "unreachable";
  checkedAt: string;
  reason: SecretStoreFailure | null;
}

export const secretStores = pgTable(
  "secret_stores",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),
    storeId: text("store_id").notNull().unique(),
    name: text("name").notNull(),
    type: text("type").$type<SecretStoreType>().notNull(),
    config: jsonb("config").$type<SecretStoreConfig>().notNull(),
    credentialEncrypted: text("credential_encrypted").notNull(),
    allowedPaths: jsonb("allowed_paths").$type<string[]>(),
    cacheTtlSeconds: integer("cache_ttl_seconds").default(30).notNull(),
    health: jsonb("health").$type<SecretStoreHealth>(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    nameUnique: uniqueIndex("secret_stores_ws_env_name_unique").on(table.workspaceId, table.environmentId, table.name),
  }),
);

export const secretStoreSettings = pgTable("secret_store_settings", {
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" })
    .primaryKey(),
  allowPrivateNetwork: boolean("allow_private_network").default(false).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text("updated_by"),
});
