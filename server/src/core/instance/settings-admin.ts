import { isFeatureEnabled } from "@anlyon/feature-flags";
import { eq } from "drizzle-orm";
import { env } from "../../config/env.ts";
import { db } from "../../db/index.ts";
import { instanceSettings } from "../../db/schema/instance.ts";
import { createLogger } from "../../lib/logger.ts";
import { ConflictError, ValidationError } from "../../utils/errors.ts";
import { encryptSecret } from "../../utils/crypto.ts";
import type { StoredAuditContext } from "../audit/event-schema.ts";
import { writeAuditEvents } from "../audit/outbox.ts";
import { isCloudEdition } from "../edition/edition.ts";
import { instanceAuditRecords } from "./audit.ts";
import { INSTANCE_SETTINGS, instanceSettingDefinition } from "./registry.ts";
import {
  cipherContext,
  definitionOf,
  envValue,
  instanceSetting,
  instanceSettingSource,
  loadInstanceSettings,
  storedInstanceSetting,
  type InstanceSettingSource,
} from "./settings.ts";

const logger = createLogger({ module: "instance-settings" });

export interface InstanceSettingView {
  key: string;
  group: string;
  label: string;
  description: string;
  secret: boolean;
  value?: string | null;
  set: boolean;
  source: InstanceSettingSource;
  env: string;
  default: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export function describeInstanceSettings(): InstanceSettingView[] {
  return INSTANCE_SETTINGS.filter((definition) => !definition.feature || isFeatureEnabled(definition.feature)).map((definition) => {
    const value = instanceSetting(definition.key);
    const row = storedInstanceSetting(definition.key);
    return {
      key: definition.key,
      group: definition.group,
      label: definition.label,
      description: definition.description,
      secret: definition.secret,
      ...(definition.secret ? {} : { value: value ?? null }),
      set: value !== undefined && value !== "",
      source: instanceSettingSource(definition.key),
      env: definition.env,
      default: definition.default ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  });
}

export type InstanceSettingChanges = Record<string, string | null>;

export function validateInstanceSettingChanges(changes: InstanceSettingChanges): Record<string, string | null> {
  const entries = Object.entries(changes);
  if (entries.length === 0) throw new ValidationError("No settings to change");
  const problems: Record<string, string> = {};
  const clean: Record<string, string | null> = {};
  for (const [key, raw] of entries) {
    const definition = instanceSettingDefinition(key);
    if (!definition || (definition.feature && !isFeatureEnabled(definition.feature))) {
      problems[key] = "Unknown setting";
      continue;
    }
    if (envValue(definition) !== undefined) {
      problems[key] = `Set by the environment (${definition.env}); change it there`;
      continue;
    }
    if (raw === null || raw === "") {
      clean[key] = null;
      continue;
    }
    const parsed = definition.schema.safeParse(raw);
    if (!parsed.success) {
      problems[key] = parsed.error.issues[0]?.message ?? "Invalid value";
      continue;
    }
    clean[key] = parsed.data;
  }
  if (Object.keys(problems).length > 0) {
    const envOnly = Object.values(problems).every((problem) => problem.startsWith("Set by the environment"));
    if (envOnly) throw new ConflictError(Object.entries(problems).map(([key, problem]) => `${key}: ${problem}`).join("; "));
    throw new ValidationError("Some settings are not valid", problems);
  }
  return clean;
}

export async function updateInstanceSettings(
  changes: InstanceSettingChanges,
  actorUserId: string,
  context?: StoredAuditContext,
  check?: (clean: Record<string, string | null>) => Promise<void>,
): Promise<string[]> {
  if (isCloudEdition()) throw new Error("Instance settings do not exist on cloud");
  const clean = validateInstanceSettingChanges(changes);
  await check?.(clean);
  const keys = Object.keys(clean);
  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(clean)) {
      if (value === null) {
        await tx.delete(instanceSettings).where(eq(instanceSettings.key, key));
        continue;
      }
      const secret = definitionOf(key).secret;
      const row = {
        value: secret ? null : value,
        encryptedValue: secret ? encryptSecret(value, env.DELIVERY_SECRET_MASTER_KEY, cipherContext(key)) : null,
        updatedBy: actorUserId,
        updatedAt: new Date(),
      };
      await tx.insert(instanceSettings).values({ key, ...row }).onConflictDoUpdate({ target: instanceSettings.key, set: row });
    }
    await writeAuditEvents(
      tx,
      await instanceAuditRecords(tx, "instance.settings_updated", actorUserId, {
        changed: keys.filter((key) => clean[key] !== null),
        cleared: keys.filter((key) => clean[key] === null),
      }, context),
    );
  });
  await loadInstanceSettings();
  logger.info({ keys, by: actorUserId }, "Instance settings changed");
  return keys;
}
