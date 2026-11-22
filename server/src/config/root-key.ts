import { hkdfSync } from "node:crypto";

export const ROOT_KEY_LABELS = {
  BETTER_AUTH_SECRET: "anlyon/root-key/v1/better-auth-secret",
  API_KEY_SECRET: "anlyon/root-key/v1/api-key-secret",
  DELIVERY_SECRET_MASTER_KEY: "anlyon/root-key/v1/delivery-secret-master-key",
  CONNECTIONS_ENCRYPTION_KEY: "anlyon/root-key/v1/connections-encryption-key",
  INTEGRATION_ENCRYPTION_KEY: "anlyon/root-key/v1/integration-encryption-key",
} as const;

export type DerivedKeyName = keyof typeof ROOT_KEY_LABELS;
export const DERIVED_KEY_NAMES = Object.keys(ROOT_KEY_LABELS) as DerivedKeyName[];

const SALT = "anlyon-root-key";
const KEY_BYTES = 32;
export const MIN_ROOT_KEY_LENGTH = 32;

export function deriveFromRootKey(rootKey: string, label: string): string {
  return Buffer.from(hkdfSync("sha256", Buffer.from(rootKey, "utf8"), SALT, label, KEY_BYTES)).toString("base64url");
}

export interface RootKeyResult {
  env: Record<string, string | undefined>;
  derived: DerivedKeyName[];
  error?: string;
}

export function applyRootKey(source: Record<string, string | undefined>, edition: string): RootKeyResult {
  const rootKey = source.ANLYON_ROOT_KEY;
  if (!rootKey) return { env: source, derived: [] };
  if (edition === "cloud") {
    return {
      env: source,
      derived: [],
      error: "ANLYON_ROOT_KEY is for self-hosted editions. Cloud keeps its separate keys; unset ANLYON_ROOT_KEY.",
    };
  }
  if (rootKey.length < MIN_ROOT_KEY_LENGTH) {
    return { env: source, derived: [], error: `ANLYON_ROOT_KEY must be at least ${MIN_ROOT_KEY_LENGTH} characters.` };
  }
  const env = { ...source };
  const derived: DerivedKeyName[] = [];
  for (const name of DERIVED_KEY_NAMES) {
    if (env[name]) continue;
    env[name] = deriveFromRootKey(rootKey, ROOT_KEY_LABELS[name]);
    derived.push(name);
  }
  return { env, derived };
}

export function applyPublicUrl(source: Record<string, string | undefined>, edition: string): Record<string, string | undefined> {
  const publicUrl = source.ANLYON_PUBLIC_URL?.replace(/\/+$/, "");
  if (!publicUrl || edition === "cloud") return source;
  const env = { ...source };
  for (const name of ["BETTER_AUTH_URL", "FRONTEND_URL", "CONSOLE_URL", "API_BASE_URL"]) {
    if (!env[name]) env[name] = publicUrl;
  }
  if (!env.ENFORCE_HTTPS) env.ENFORCE_HTTPS = publicUrl.startsWith("https://") ? "true" : "false";
  return env;
}
