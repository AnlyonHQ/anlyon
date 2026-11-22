import { eq } from "drizzle-orm";
import { env } from "../../config/env.ts";
import { db } from "../../db/index.ts";
import { workspaceDefaults, type WorkspaceDefaultsRow } from "../../db/schema/workspace-defaults.ts";
import { createLogger } from "../../lib/logger.ts";
import type { AuditActor, StoredAuditContext } from "../audit/event-schema.ts";
import { writeAuditEvents } from "../audit/outbox.ts";
import {
  RECOMMENDED_ACTING_FOR,
  RECOMMENDED_DECIDER,
  type ActingFor,
  type Decider,
  type DefaultsSource,
  type SetupStatus,
} from "./defaults-shape.ts";

export * from "./defaults-shape.ts";

const logger = createLogger({ module: "workspace-defaults" });

export interface WorkspaceDefaultsView {
  actingFor: ActingFor | null;
  endUserDecider: Decider | null;
  approvalWindowHours: number | null;
  effective: { endUserDecider: Decider; approvalWindowHours: number };
  recommended: { actingFor: ActingFor; endUserDecider: Decider; approvalWindowHours: number };
  setup: { status: SetupStatus | null; at: string | null };
  updatedAt: string | null;
}

export interface WorkspaceDefaultsPatch {
  actingFor?: ActingFor | null;
  endUserDecider?: Decider | null;
  approvalWindowHours?: number | null;
  setupStatus?: SetupStatus;
}

export interface WorkspaceDefaultsAudit {
  actor?: AuditActor;
  context?: StoredAuditContext;
  source?: DefaultsSource;
}

const AUDITED_FIELDS = ["actingFor", "endUserDecider", "approvalWindowHours", "setupStatus"] as const;
type AuditedField = (typeof AUDITED_FIELDS)[number];

function answers(row: WorkspaceDefaultsRow | null): Record<AuditedField, string | number | null> {
  return {
    actingFor: row?.actingFor ?? null,
    endUserDecider: row?.endUserDecider ?? null,
    approvalWindowHours: row?.approvalWindowHours ?? null,
    setupStatus: row?.setupStatus ?? null,
  };
}

async function readRow(workspaceId: string): Promise<WorkspaceDefaultsRow | null> {
  const [row] = await db.select().from(workspaceDefaults).where(eq(workspaceDefaults.workspaceId, workspaceId)).limit(1);
  return row ?? null;
}

export function toWorkspaceDefaultsView(row: WorkspaceDefaultsRow | null): WorkspaceDefaultsView {
  const actingFor = row?.actingFor ?? null;
  const endUserDecider = row?.endUserDecider ?? null;
  const approvalWindowHours = row?.approvalWindowHours ?? null;
  const recommended = {
    actingFor: RECOMMENDED_ACTING_FOR,
    endUserDecider: RECOMMENDED_DECIDER,
    approvalWindowHours: env.APPROVAL_DEFAULT_TTL_HOURS,
  };
  return {
    actingFor,
    endUserDecider,
    approvalWindowHours,
    effective: {
      endUserDecider: endUserDecider ?? recommended.endUserDecider,
      approvalWindowHours: approvalWindowHours ?? recommended.approvalWindowHours,
    },
    recommended,
    setup: { status: row?.setupStatus ?? null, at: row?.setupAt ? row.setupAt.toISOString() : null },
    updatedAt: row ? row.updatedAt.toISOString() : null,
  };
}

export async function getWorkspaceDefaults(workspaceId: string): Promise<WorkspaceDefaultsView> {
  return toWorkspaceDefaultsView(await readRow(workspaceId));
}

export async function updateWorkspaceDefaults(
  workspaceId: string,
  userId: string | null,
  patch: WorkspaceDefaultsPatch,
  audit: WorkspaceDefaultsAudit = {},
): Promise<WorkspaceDefaultsView> {
  const now = new Date();
  const values = {
    ...("actingFor" in patch ? { actingFor: patch.actingFor ?? null } : {}),
    ...("endUserDecider" in patch ? { endUserDecider: patch.endUserDecider ?? null } : {}),
    ...("approvalWindowHours" in patch ? { approvalWindowHours: patch.approvalWindowHours ?? null } : {}),
    ...(patch.setupStatus ? { setupStatus: patch.setupStatus, setupAt: now } : {}),
    updatedBy: userId,
    updatedAt: now,
  };
  const source = audit.source ?? "api";
  const row = await db.transaction(async (tx) => {
    const [previous] = await tx
      .select()
      .from(workspaceDefaults)
      .where(eq(workspaceDefaults.workspaceId, workspaceId))
      .for("update");
    const [next] = await tx
      .insert(workspaceDefaults)
      .values({ workspaceId, ...values })
      .onConflictDoUpdate({ target: workspaceDefaults.workspaceId, set: values })
      .returning();

    const before = answers(previous ?? null);
    const after = answers(next);
    const changes = Object.fromEntries(
      AUDITED_FIELDS.filter((field) => before[field] !== after[field]).map((field) => [
        field,
        { before: before[field], after: after[field] },
      ]),
    );
    if (Object.keys(changes).length > 0) {
      await writeAuditEvents(tx, [
        {
          workspaceId,
          type: "workspace.defaults_updated",
          actor: audit.actor ?? (userId ? { type: "user", id: userId } : { type: "system", id: null }),
          resource: { type: "workspace", id: workspaceId },
          context: audit.context ?? null,
          data: {
            source,
            changes,
            effective: {
              before: toWorkspaceDefaultsView(previous ?? null).effective,
              after: toWorkspaceDefaultsView(next).effective,
            },
          },
        },
      ]);
    }
    return next;
  });
  logger.info({ workspaceId, userId, source, fields: Object.keys(patch) }, "Workspace defaults updated");
  return toWorkspaceDefaultsView(row);
}

export async function endUserDeciderFor(workspaceId: string): Promise<Decider> {
  return (await getWorkspaceDefaults(workspaceId)).effective.endUserDecider;
}

export async function approvalWindowHoursFor(workspaceId: string): Promise<number> {
  return (await getWorkspaceDefaults(workspaceId)).effective.approvalWindowHours;
}
