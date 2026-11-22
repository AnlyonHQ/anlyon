import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./user.ts";
import { roleEnum, workspaces } from "./workspaces.ts";

export const workspaceScimConfigs = pgTable("workspace_scim_configs", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  tokenPrefix: text("token_prefix").notNull(),
  defaultRole: roleEnum("default_role").notNull().default("member"),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  rotatedAt: timestamp("rotated_at"),
  lastUsedAt: timestamp("last_used_at"),
});

export const workspaceScimUsers = pgTable(
  "workspace_scim_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => user.id, { onDelete: "cascade" })
      .notNull(),
    externalId: text("external_id"),
    userName: text("user_name").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("workspace_scim_users_workspace_user_unique").on(table.workspaceId, table.userId),
    uniqueIndex("workspace_scim_users_workspace_user_name_unique").on(
      table.workspaceId,
      sql`lower(${table.userName})`,
    ),
    uniqueIndex("workspace_scim_users_workspace_external_id_unique")
      .on(table.workspaceId, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
  ],
);

export const workspaceScimGroups = pgTable(
  "workspace_scim_groups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    displayName: text("display_name").notNull(),
    externalId: text("external_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("workspace_scim_groups_workspace_display_name_unique").on(
      table.workspaceId,
      sql`lower(${table.displayName})`,
    ),
  ],
);

export const workspaceScimGroupMembers = pgTable(
  "workspace_scim_group_members",
  {
    groupId: uuid("group_id")
      .references(() => workspaceScimGroups.id, { onDelete: "cascade" })
      .notNull(),
    scimUserId: uuid("scim_user_id")
      .references(() => workspaceScimUsers.id, { onDelete: "cascade" })
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.scimUserId] }),
    index("workspace_scim_group_members_user_idx").on(table.scimUserId),
  ],
);

export const workspaceScimRoleMappings = pgTable(
  "workspace_scim_role_mappings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    groupName: text("group_name").notNull(),
    role: roleEnum("role").notNull(),
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("workspace_scim_role_mappings_workspace_group_unique").on(
      table.workspaceId,
      sql`lower(${table.groupName})`,
    ),
  ],
);

export type WorkspaceScimUserRow = typeof workspaceScimUsers.$inferSelect;
export type WorkspaceScimGroupRow = typeof workspaceScimGroups.$inferSelect;
export type WorkspaceScimRoleMappingRow = typeof workspaceScimRoleMappings.$inferSelect;
