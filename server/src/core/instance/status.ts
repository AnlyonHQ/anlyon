import { env, keysDerivedFromRootKey } from "../../config/env.ts";
import { db } from "../../db/index.ts";
import type { StoredAuditContext } from "../audit/event-schema.ts";
import { writeAuditEvents } from "../audit/outbox.ts";
import { currentEdition } from "../edition/edition.ts";
import { instanceAuditRecords } from "./audit.ts";
import { readInternal, writeInternal } from "./internal.ts";
import { INTERNAL_KEYS } from "./registry.ts";
import { telemetryEnabled } from "./telemetry.ts";

export interface InstanceStatus {
  edition: string;
  setupCompletedAt: string | null;
  rootKey: {
    inUse: boolean;
    derivedKeys: string[];
    backupConfirmedAt: string | null;
    backupConfirmedBy: string | null;
  };
  telemetry: { enabled: boolean; endpoint: string };
}

export async function instanceStatus(): Promise<InstanceStatus> {
  const [completed, backup] = await Promise.all([readInternal(INTERNAL_KEYS.setupCompletedAt), readInternal(INTERNAL_KEYS.rootKeyBackupConfirmedAt)]);
  return {
    edition: currentEdition(),
    setupCompletedAt: completed?.value ?? null,
    rootKey: {
      inUse: Boolean(env.ANLYON_ROOT_KEY),
      derivedKeys: [...keysDerivedFromRootKey()],
      backupConfirmedAt: backup?.value ?? null,
      backupConfirmedBy: backup?.updatedBy ?? null,
    },
    telemetry: { enabled: telemetryEnabled(), endpoint: env.ANLYON_TELEMETRY_URL },
  };
}

export async function confirmRootKeyBackup(userId: string, context?: StoredAuditContext): Promise<InstanceStatus> {
  await db.transaction(async (tx) => {
    await writeInternal(INTERNAL_KEYS.rootKeyBackupConfirmedAt, new Date().toISOString(), userId, tx);
    await writeAuditEvents(tx, await instanceAuditRecords(tx, "instance.root_key_backup_confirmed", userId, {}, context));
  });
  return instanceStatus();
}
