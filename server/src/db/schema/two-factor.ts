import { boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./user.ts";

export const twoFactor = pgTable(
  "twoFactor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true).notNull(),
    failedVerificationCount: integer("failed_verification_count").default(0).notNull(),
    lockedUntil: timestamp("locked_until"),
  },
  (table) => [index("two_factor_user_id_idx").on(table.userId)],
);
