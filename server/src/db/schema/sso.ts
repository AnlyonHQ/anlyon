import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./user.ts";
import { session } from "./session.ts";
import { roleEnum, workspaces } from "./workspaces.ts";

export const ssoProvider = pgTable(
  "sso_provider",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    oidcConfig: text("oidc_config"),
    samlConfig: text("saml_config"),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    providerId: text("provider_id").notNull().unique(),
    organizationId: uuid("organization_id").references(() => workspaces.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    domainVerified: boolean("domain_verified").default(false),
  },
  (table) => [index("sso_provider_organization_id_idx").on(table.organizationId)],
);

export const workspaceSsoConnections = pgTable("workspace_sso_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  providerId: text("provider_id")
    .references(() => ssoProvider.providerId, { onDelete: "cascade" })
    .notNull()
    .unique(),
  protocol: text("protocol").notNull(),
  domains: jsonb("domains").$type<string[]>().notNull(),
  domainVerificationToken: text("domain_verification_token").notNull(),
  domainsVerifiedAt: timestamp("domains_verified_at"),
  enforced: boolean("enforced").notNull().default(false),
  defaultRole: roleEnum("default_role").notNull().default("member"),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const ssoSessions = pgTable(
  "sso_sessions",
  {
    sessionId: text("session_id")
      .primaryKey()
      .references(() => session.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("sso_sessions_provider_id_idx").on(table.providerId)],
);

export type WorkspaceSsoConnectionRow = typeof workspaceSsoConnections.$inferSelect;
