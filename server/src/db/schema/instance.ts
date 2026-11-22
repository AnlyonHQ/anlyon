import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./user.ts";

export const instanceSettings = pgTable("instance_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  encryptedValue: text("encrypted_value"),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type InstanceSettingRow = typeof instanceSettings.$inferSelect;

export const instanceAdmins = pgTable("instance_admins", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  grantedBy: text("granted_by"),
  grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
});

export type InstanceAdminRow = typeof instanceAdmins.$inferSelect;
