import { pgTable, text, timestamp, uuid, index, unique, foreignKey } from "drizzle-orm/pg-core";
import { roleEnum, workspaceMembers, workspaces } from "./workspaces.ts";
import { environments } from "./environments.ts";
import { user } from "./user.ts";

export const memberEnvironmentRoles = pgTable(
  "member_environment_roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id").notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),
    role: roleEnum("role").notNull(),
    grantedBy: text("granted_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("member_environment_roles_member_env_unique").on(table.workspaceId, table.userId, table.environmentId),
    index("idx_member_environment_roles_environment_id").on(table.environmentId),
    foreignKey({
      name: "member_environment_roles_membership_fk",
      columns: [table.workspaceId, table.userId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
    }).onDelete("cascade"),
  ],
);

export type MemberEnvironmentRole = typeof memberEnvironmentRoles.$inferSelect;
