import { sql } from "drizzle-orm";
import { pgTable, pgEnum, text, timestamp, uuid, boolean, unique, index } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.ts";
export const environmentKindEnum = pgEnum("environment_kind", ["development", "staging", "production"]);

export const environments = pgTable(
  "environments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    kind: environmentKindEnum("kind").notNull().default("production"),
    isDefault: boolean("is_default").default(false).notNull(),
    isProtected: boolean("is_protected").default(false).notNull(),
    haltedAt: timestamp("halted_at"),
    haltedReason: text("halted_reason"),
    haltedBy: text("halted_by"),
    allowedRedirectUrls: text("allowed_redirect_urls").array().notNull().default(sql`'{}'::text[]`),
    defaultRedirectUrl: text("default_redirect_url"),
    connectConfirmation: text("connect_confirmation").$type<"required" | "off">().notNull().default("required"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    slugUnique: unique("environments_workspace_slug_unique").on(table.workspaceId, table.slug),
    workspaceIdx: index("idx_environments_workspace_id").on(table.workspaceId),
  }),
);

export type Environment = typeof environments.$inferSelect;
export type NewEnvironment = typeof environments.$inferInsert;
