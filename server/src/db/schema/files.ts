import { bigint, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.ts";

export const traceArchives = pgTable("trace_archives", {
  r2Key: text("r2_key").primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
