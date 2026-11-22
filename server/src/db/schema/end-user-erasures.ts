import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { environments } from "./environments.ts";
import { workspaces } from "./workspaces.ts";

export const endUserErasures = pgTable(
  "end_user_erasures",
  {
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "cascade" }).notNull(),
    erasedAs: text("erased_as").notNull(),
    erasedAt: timestamp("erased_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.environmentId, table.erasedAs] }),
  }),
);
