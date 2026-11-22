import { pgTable, text, timestamp, uuid, pgEnum, index, unique } from "drizzle-orm/pg-core";
import { workspaces, roleEnum } from "./workspaces.ts";
import { user } from "./user.ts";

export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "declined",
  "expired",
  "cancelled",
]);

export const workspaceInvitations = pgTable("workspace_invitations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),

  email: text("email").notNull(),
  role: roleEnum("role").notNull().default("member"),
  status: invitationStatusEnum("status").notNull().default("pending"),

  token: text("token").notNull().unique(),

  invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),

  invitedUserId: text("invited_user_id").references(() => user.id, { onDelete: "set null" }),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  declinedAt: timestamp("declined_at"),
}, (table) => [
  unique("workspace_invitations_workspace_email_pending").on(table.workspaceId, table.email),
  index("idx_workspace_invitations_email").on(table.email),
  index("idx_workspace_invitations_token").on(table.token),
  index("idx_workspace_invitations_workspace_id").on(table.workspaceId),
]);
