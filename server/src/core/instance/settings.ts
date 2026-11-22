import { inArray } from "drizzle-orm";
import { env } from "../../config/env.ts";
import { db } from "../../db/index.ts";
import { instanceSettings, type InstanceSettingRow } from "../../db/schema/instance.ts";
import { createLogger } from "../../lib/logger.ts";
import { decryptSecret } from "../../utils/crypto.ts";
import { isCloudEdition } from "../edition/edition.ts";
import { INSTANCE_SETTINGS, instanceSettingDefinition, type InstanceSettingDefinition } from "./registry.ts";

const logger = createLogger({ module: "instance-settings" });

const REFRESH_INTERVAL_MS = 30_000;

interface StoredSetting {
  value: string;
  updatedBy: string | null;
  updatedAt: Date;
}

let stored = new Map<string, StoredSetting>();

export function storedInstanceSetting(key: string): Readonly<StoredSetting> | undefined {
  return stored.get(key);
}
const listeners = new Set<(changed: string[]) => void>();
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export const cipherContext = (key: string) => ({ store: "instance-setting" as const, name: key });

export function envValue(definition: InstanceSettingDefinition): string | undefined {
  const raw = process.env[definition.env]?.trim();
  if (!raw) return undefined;
  return definition.fromEnv ? definition.fromEnv(raw) : raw;
}

export function definitionOf(key: string): InstanceSettingDefinition {
  const definition = instanceSettingDefinition(key);
  if (!definition) throw new Error(`Unknown instance setting "${key}"`);
  return definition;
}

export function instanceSetting(key: string): string | undefined {
  const definition = definitionOf(key);
  const fromEnv = envValue(definition);
  if (fromEnv !== undefined) return fromEnv;
  if (!isCloudEdition()) {
    const value = stored.get(key)?.value;
    if (value) return value;
  }
  return definition.default;
}

export type InstanceSettingSource = "environment" | "database" | "default" | "unset";

export function instanceSettingSource(key: string): InstanceSettingSource {
  const definition = definitionOf(key);
  if (envValue(definition) !== undefined) return "environment";
  if (!isCloudEdition() && stored.get(key)?.value) return "database";
  return definition.default !== undefined ? "default" : "unset";
}

export function onInstanceSettingsChange(listener: (changed: string[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function decode(row: InstanceSettingRow): string | null {
  if (row.encryptedValue) {
    try {
      return decryptSecret(row.encryptedValue, env.DELIVERY_SECRET_MASTER_KEY, cipherContext(row.key));
    } catch (error) {
      logger.error({ key: row.key, error: error instanceof Error ? error.message : error }, "An instance setting could not be decrypted; it is ignored");
      return null;
    }
  }
  return row.value;
}

export async function loadInstanceSettings(): Promise<void> {
  if (isCloudEdition()) return;
  const keys = INSTANCE_SETTINGS.map((definition) => definition.key);
  const rows = await db.select().from(instanceSettings).where(inArray(instanceSettings.key, keys));
  const next = new Map<string, StoredSetting>();
  for (const row of rows) {
    const value = decode(row);
    if (value) next.set(row.key, { value, updatedBy: row.updatedBy, updatedAt: row.updatedAt });
  }
  const changed = keys.filter((key) => stored.get(key)?.value !== next.get(key)?.value);
  stored = next;
  if (changed.length > 0) notify(changed);
}

function notify(changed: string[]): void {
  for (const listener of listeners) {
    try {
      listener(changed);
    } catch (error) {
      logger.error({ error, changed }, "An instance settings listener failed");
    }
  }
}

export async function startInstanceSettingsRefresh(intervalMs: number = REFRESH_INTERVAL_MS): Promise<void> {
  if (isCloudEdition()) return;
  await loadInstanceSettings();
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    loadInstanceSettings().catch((error) => logger.warn({ error: error instanceof Error ? error.message : error }, "Instance settings refresh failed"));
  }, intervalMs);
  refreshTimer.unref?.();
}

export function stopInstanceSettingsRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

export function setStoredInstanceSettingsForTest(values: Record<string, string>): void {
  const before = stored;
  stored = new Map(Object.entries(values).map(([key, value]) => [key, { value, updatedBy: null, updatedAt: new Date(0) }]));
  const keys = new Set([...before.keys(), ...stored.keys()]);
  notify([...keys]);
}
