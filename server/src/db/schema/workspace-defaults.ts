import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./user.ts";
import { workspaces } from "./workspaces.ts";

export const workspaceDefaults = pgTable(
  "workspace_defaults",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actingFor: text("acting_for").$type<"team" | "users" | "both">(),
    endUserDecider: text("end_user_decider").$type<"team" | "end_user">(),
    approvalWindowHours: integer("approval_window_hours"),
    setupStatus: text("setup_status").$type<"completed" | "skipped">(),
    setupAt: timestamp("setup_at"),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check("workspace_defaults_acting_for", sql`${table.actingFor} in ('team', 'users', 'both')`),
    check("workspace_defaults_end_user_decider", sql`${table.endUserDecider} in ('team', 'end_user')`),
    check("workspace_defaults_approval_window", sql`${table.approvalWindowHours} between 1 and 168`),
    check("workspace_defaults_setup_status", sql`${table.setupStatus} in ('completed', 'skipped')`),
  ],
);

export type WorkspaceDefaultsRow = typeof workspaceDefaults.$inferSelect;
