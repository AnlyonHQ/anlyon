import { pgTable, text, timestamp, uuid, numeric, jsonb, index, pgEnum } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.ts";
import { environments } from "./environments.ts";
import { runs } from "./runs.ts";

export const feedbackSourceEnum = pgEnum("run_feedback_source", ["user", "model", "code"]);

export const runFeedback = pgTable(
  "run_feedback",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: uuid("environment_id")
      .references(() => environments.id, { onDelete: "cascade" })
      .notNull(),
    runId: uuid("run_id")
      .references(() => runs.id, { onDelete: "cascade" })
      .notNull(),
    spanId: text("span_id"),
    feedbackId: text("feedback_id").notNull().unique(),
    source: feedbackSourceEnum("source").notNull().default("user"),
    label: text("label"),
    rating: numeric("rating"),
    comment: text("comment"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    runIdx: index("idx_run_feedback_run_id").on(table.runId),
    wsIdx: index("idx_run_feedback_workspace_id").on(table.workspaceId),
  }),
);

export type RunFeedback = typeof runFeedback.$inferSelect;
export type NewRunFeedback = typeof runFeedback.$inferInsert;
