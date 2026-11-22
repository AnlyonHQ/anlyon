import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { environments } from "./environments.ts";
import { workspaces } from "./workspaces.ts";

export const SIGN_OFF_STATUSES = ["pending", "applying", "applied", "rejected", "expired", "cancelled", "failed"] as const;
export type SignOffStatus = (typeof SIGN_OFF_STATUSES)[number];

export const signOffRequests = pgTable(
  "sign_off_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    signOffId: text("sign_off_id").notNull().unique(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "cascade" }).notNull(),
    operation: text("operation").notNull(),
    status: text("status").$type<SignOffStatus>().notNull().default("pending"),
    target: jsonb("target").$type<Record<string, string>>().notNull().default({}),
    sealedInput: text("sealed_input").notNull(),
    baseDigest: text("base_digest").notNull(),
    requestDigest: text("request_digest").notNull(),
    classification: jsonb("classification").$type<Record<string, unknown>>().notNull(),
    summary: text("summary").notNull(),
    resource: jsonb("resource").$type<{ type: string; id: string; name?: string | null }>(),
    requesterScopes: jsonb("requester_scopes").$type<string[] | null>(),
    requestedByType: text("requested_by_type").$type<"api_key" | "oauth_client" | "other">().notNull(),
    requestedByKeyId: uuid("requested_by_key_id"),
    requestedByOAuthClientId: text("requested_by_oauth_client_id"),
    requestedByUserId: text("requested_by_user_id"),
    decidedByUserId: text("decided_by_user_id"),
    decidedVia: text("decided_via").$type<"console" | "email_link">(),
    decisionNote: text("decision_note"),
    result: jsonb("result"),
    error: jsonb("error").$type<{ code: string; message: string }>(),
    expiresAt: timestamp("expires_at").notNull(),
    decidedAt: timestamp("decided_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("sign_off_requests_ws_status_idx").on(table.workspaceId, table.status, table.createdAt),
    index("sign_off_requests_status_expires_idx").on(table.status, table.expiresAt),
    uniqueIndex("sign_off_requests_pending_dedupe")
      .on(table.requestDigest)
      .where(sql`status in ('pending', 'applying')`),
    check(
      "sign_off_requests_status",
      sql`${table.status} in ('pending', 'applying', 'applied', 'rejected', 'expired', 'cancelled', 'failed')`,
    ),
  ],
);

export type SignOffRequestRow = typeof signOffRequests.$inferSelect;
