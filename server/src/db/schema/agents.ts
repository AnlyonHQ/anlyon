import { pgTable, text, timestamp, uuid, integer, jsonb, unique, index } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.ts";
import { environments } from "./environments.ts";

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),
    agentId: text("agent_id").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    currentVersionId: uuid("current_version_id"),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    nameUnique: unique("agents_env_name_unique").on(table.environmentId, table.name),
    workspaceIdx: index("idx_agents_workspace_id").on(table.workspaceId),
    environmentIdx: index("idx_agents_environment_id").on(table.environmentId),
  }),
);

export const agentVersions = pgTable(
  "agent_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),
    agentId: uuid("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    agentVersionId: text("agent_version_id").notNull().unique(),
    version: integer("version").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    versionUnique: unique("agent_versions_agent_version_unique").on(table.agentId, table.version),
    agentIdx: index("idx_agent_versions_agent_id").on(table.agentId),
    environmentIdx: index("idx_agent_versions_environment_id").on(table.environmentId),
  }),
);

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type AgentVersion = typeof agentVersions.$inferSelect;
export type NewAgentVersion = typeof agentVersions.$inferInsert;
