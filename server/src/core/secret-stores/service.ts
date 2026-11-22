import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.ts";
import {
  secretStoreSettings,
  secretStores,
  type AwsSecretStoreConfig,
  type SecretStoreConfig,
  type SecretStoreFailure,
  type SecretStoreHealth,
  type SecretStoreType,
  type VaultSecretStoreConfig,
} from "../../db/schema/secret-stores.ts";
import { workspaceSecrets } from "../../db/schema/actions.ts";
import { env } from "../../config/env.ts";
import { createLogger } from "../../lib/logger.ts";
import { decryptSecret, encryptSecret, secretEnvelopeVersion } from "../../utils/crypto.ts";
import {
  SecretStoreCheckFailedError,
  SecretStoreInUseError,
  SecretStoreNotFoundError,
  SecretStoresUnavailableError,
  ValidationError,
} from "../../utils/errors.ts";
import {
  awsStoreConfigSchema,
  awsStoreCredentialSchema,
  vaultStoreConfigSchema,
  vaultStoreCredentialSchema,
} from "../../utils/validation.ts";
import { assertNotProtected } from "../environments/service.ts";
import { isFeatureEnabled } from "../edition/features.ts";
import { isCloudEdition } from "../edition/edition.ts";
import { privateDestinationsOffered, privateDestinationsRefusal } from "../instance/network.ts";
import { awsCheck, awsRead, type AwsStoreCredential } from "./aws.ts";
import { cacheDropStore, cacheGet, cacheSet } from "./cache.ts";
import { StoreReadError } from "./http.ts";
import type { ExternalLocation, StoreClientContext } from "./types.ts";
import { vaultCheck, vaultPathIsValid, vaultRead, type VaultStoreCredential } from "./vault.ts";

const logger = createLogger({ module: "secret-stores" });

export const BYO_VAULT_FEATURE = "byo_vault";

export const DEFAULT_STORE_CACHE_TTL_SECONDS = 30;

export interface Scope {
  workspaceId: string;
  environmentId: string;
}

type StoreRow = typeof secretStores.$inferSelect;
type StoreCredential = AwsStoreCredential | VaultStoreCredential;

export interface SecretStoreView {
  id: string;
  name: string;
  type: SecretStoreType;
  description: string | null;
  config: SecretStoreConfig;
  credentialKind: "access_key" | "token" | "approle";
  allowedPaths: string[] | null;
  cacheTtlSeconds: number;
  health: { status: "active" | "unreachable"; checkedAt: Date; reason: SecretStoreFailure | null } | null;
  createdAt: Date;
  updatedAt: Date;
}

export function assertSecretStoresAvailable(): void {
  if (!isFeatureEnabled(BYO_VAULT_FEATURE)) throw new SecretStoresUnavailableError();
}

function credentialKindOf(row: Pick<StoreRow, "type" | "config">): SecretStoreView["credentialKind"] {
  if (row.type === "aws_secrets_manager") return "access_key";
  return (row.config as VaultSecretStoreConfig).auth === "approle" ? "approle" : "token";
}

function toView(row: StoreRow): SecretStoreView {
  return {
    id: row.storeId,
    name: row.name,
    type: row.type,
    description: row.description,
    config: row.config,
    credentialKind: credentialKindOf(row),
    allowedPaths: row.allowedPaths ?? null,
    cacheTtlSeconds: row.cacheTtlSeconds,
    health: row.health
      ? { status: row.health.status, checkedAt: new Date(row.health.checkedAt), reason: row.health.reason ?? null }
      : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function envelope(scope: Scope, storeId: string) {
  return { store: "secret-store" as const, workspaceId: scope.workspaceId, environmentId: scope.environmentId, name: storeId };
}

function decryptCredential(row: StoreRow): StoreCredential {
  if (secretEnvelopeVersion(row.credentialEncrypted) !== "v3") {
    throw new StoreReadError("store_denied", "The store's credential is not in the expected envelope format; set it again.");
  }
  const plain = decryptSecret(row.credentialEncrypted, env.DELIVERY_SECRET_MASTER_KEY, envelope(row, row.storeId));
  return JSON.parse(plain) as StoreCredential;
}

function clientContext(row: Pick<StoreRow, "id" | "storeId" | "updatedAt">, privateNetwork: boolean): StoreClientContext {
  return { cacheKey: `${row.id}|${row.updatedAt.getTime()}`, storeId: row.storeId, privateNetwork };
}

export interface SecretStoreSettingsView {
  allowPrivateNetwork: boolean;
  available: boolean;
  effective: boolean;
  updatedAt: Date | null;
}

export async function privateNetworkAllowed(workspaceId: string): Promise<boolean> {
  if (!privateDestinationsOffered()) return false;
  const [row] = await db.select({ allow: secretStoreSettings.allowPrivateNetwork })
    .from(secretStoreSettings).where(eq(secretStoreSettings.workspaceId, workspaceId));
  return row?.allow ?? false;
}

export async function getSecretStoreSettings(workspaceId: string): Promise<SecretStoreSettingsView> {
  assertSecretStoresAvailable();
  const [row] = await db.select().from(secretStoreSettings).where(eq(secretStoreSettings.workspaceId, workspaceId));
  const available = privateDestinationsOffered();
  const allow = row?.allowPrivateNetwork ?? false;
  return { allowPrivateNetwork: allow, available, effective: available && allow, updatedAt: row?.updatedAt ?? null };
}

export async function updateSecretStoreSettings(
  workspaceId: string, input: { allowPrivateNetwork: boolean }, actor: string | null,
): Promise<SecretStoreSettingsView> {
  assertSecretStoresAvailable();
  if (isCloudEdition()) {
    throw new ValidationError(privateDestinationsRefusal("secret stores")!);
  }
  const refusal = privateDestinationsRefusal("secret stores");
  if (input.allowPrivateNetwork && refusal) throw new ValidationError(refusal);
  const now = new Date();
  await db.insert(secretStoreSettings)
    .values({ workspaceId, allowPrivateNetwork: input.allowPrivateNetwork, updatedAt: now, updatedBy: actor })
    .onConflictDoUpdate({
      target: secretStoreSettings.workspaceId,
      set: { allowPrivateNetwork: input.allowPrivateNetwork, updatedAt: now, updatedBy: actor },
    });
  logger.info({ workspaceId, allowPrivateNetwork: input.allowPrivateNetwork, actor }, "Secret store settings changed");
  return getSecretStoreSettings(workspaceId);
}

function parseStore(type: SecretStoreType, config: unknown, credential: unknown, privateNetwork: boolean): { config: SecretStoreConfig; credential: StoreCredential } {
  const fail = (what: string, error: { issues: Array<{ path: PropertyKey[]; message: string }> }) => {
    const issue = error.issues[0];
    throw new ValidationError(`Invalid ${what}${issue ? `: ${issue.path.map(String).join(".") || what} ${issue.message}` : ""}`);
  };
  if (type === "aws_secrets_manager") {
    const parsedConfig = awsStoreConfigSchema.safeParse(config);
    if (!parsedConfig.success) fail("config", parsedConfig.error);
    const parsedCredential = awsStoreCredentialSchema.safeParse(credential);
    if (!parsedCredential.success) fail("credential", parsedCredential.error);
    return { config: parsedConfig.data as AwsSecretStoreConfig, credential: parsedCredential.data! };
  }
  const parsedConfig = vaultStoreConfigSchema.safeParse(config);
  if (!parsedConfig.success) fail("config", parsedConfig.error);
  const vault = parsedConfig.data! as VaultSecretStoreConfig;
  const parsedCredential = vaultStoreCredentialSchema.safeParse(credential);
  if (!parsedCredential.success) fail("credential", parsedCredential.error);
  const cred = parsedCredential.data!;
  if (vault.auth === "approle" && !("roleId" in cred)) throw new ValidationError("An approle store needs credential.roleId and credential.secretId.");
  if (vault.auth === "token" && !("token" in cred)) throw new ValidationError("A token store needs credential.token.");
  const address = new URL(vault.address);
  if (address.username || address.password || address.search || address.hash || (address.pathname !== "/" && address.pathname !== "")) {
    throw new ValidationError("config.address is the Vault origin alone, such as https://vault.example.com:8200, with no path or credentials.");
  }
  if (address.protocol !== "https:" && !(address.protocol === "http:" && privateNetwork)) {
    throw new ValidationError("config.address must use https. Plain http is accepted only for a store on a private network, on a self-hosted edition whose admin allowed it.");
  }
  return { config: { ...vault, address: address.origin }, credential: cred };
}

const DESTINATION_FIELDS: Record<SecretStoreType, readonly string[]> = {
  hashicorp_vault: ["address", "namespace", "mount", "auth", "authMount"],
  aws_secrets_manager: ["region", "auth", "roleArn", "externalId"],
};

export function destinationChanges(type: SecretStoreType, before: SecretStoreConfig, after: SecretStoreConfig): string[] {
  const value = (config: SecretStoreConfig, field: string) => (config as unknown as Record<string, unknown>)[field] ?? null;
  return DESTINATION_FIELDS[type].filter((field) => value(before, field) !== value(after, field));
}

async function authenticate(type: SecretStoreType, config: SecretStoreConfig, credential: StoreCredential, ctx: StoreClientContext): Promise<void> {
  if (type === "aws_secrets_manager") await awsCheck(config as AwsSecretStoreConfig, credential as AwsStoreCredential, ctx);
  else await vaultCheck(config as VaultSecretStoreConfig, credential as VaultStoreCredential, ctx);
}

function healthNow(failure: SecretStoreFailure | null): SecretStoreHealth {
  return { status: failure ? "unreachable" : "active", checkedAt: new Date().toISOString(), reason: failure };
}

async function findRow(scope: Scope, name: string): Promise<StoreRow> {
  const [row] = await db.select().from(secretStores).where(and(
    eq(secretStores.workspaceId, scope.workspaceId), eq(secretStores.environmentId, scope.environmentId), eq(secretStores.name, name),
  ));
  if (!row) throw new SecretStoreNotFoundError(name);
  return row;
}

export async function listSecretStores(scope: Scope): Promise<SecretStoreView[]> {
  assertSecretStoresAvailable();
  const rows = await db.select().from(secretStores).where(and(
    eq(secretStores.workspaceId, scope.workspaceId), eq(secretStores.environmentId, scope.environmentId),
  ));
  return rows.map(toView);
}

export async function getSecretStore(scope: Scope, name: string): Promise<SecretStoreView> {
  assertSecretStoresAvailable();
  return toView(await findRow(scope, name));
}

export interface CreateSecretStoreInput {
  name: string;
  type: SecretStoreType;
  config: unknown;
  credential: unknown;
  description?: string;
  allowedPaths?: string[] | null;
  cacheTtlSeconds?: number;
}

export async function createSecretStore(scope: Scope, input: CreateSecretStoreInput): Promise<SecretStoreView> {
  assertSecretStoresAvailable();
  const privateNetwork = await privateNetworkAllowed(scope.workspaceId);
  const { config, credential } = parseStore(input.type, input.config, input.credential, privateNetwork);
  const [existing] = await db.select({ id: secretStores.id }).from(secretStores).where(and(
    eq(secretStores.workspaceId, scope.workspaceId), eq(secretStores.environmentId, scope.environmentId), eq(secretStores.name, input.name),
  ));
  if (existing) throw new ValidationError(`A secret store named ${input.name} already exists in this environment.`);

  const storeId = `sst_${nanoid(21)}`;
  try {
    await authenticate(input.type, config, credential, { cacheKey: `new|${storeId}`, storeId, privateNetwork });
  } catch (error) {
    if (error instanceof StoreReadError) {
      logger.warn({ ...scope, store: input.name, type: input.type, reason: error.reason, detail: error.message }, "Secret store check failed; nothing was saved");
      throw new SecretStoreCheckFailedError(input.name, error.reason);
    }
    throw error;
  }

  const [created] = await db.insert(secretStores).values({
    workspaceId: scope.workspaceId,
    environmentId: scope.environmentId,
    storeId,
    name: input.name,
    type: input.type,
    config,
    credentialEncrypted: encryptSecret(JSON.stringify(credential), env.DELIVERY_SECRET_MASTER_KEY, envelope(scope, storeId)),
    allowedPaths: input.allowedPaths ?? null,
    cacheTtlSeconds: input.cacheTtlSeconds ?? DEFAULT_STORE_CACHE_TTL_SECONDS,
    description: input.description ?? null,
    health: healthNow(null),
  }).returning();
  logger.info({ ...scope, store: input.name, type: input.type }, "Secret store created");
  return toView(created);
}

export interface UpdateSecretStoreInput {
  description?: string | null;
  config?: Record<string, unknown>;
  credential?: Record<string, unknown>;
  allowedPaths?: string[] | null;
  cacheTtlSeconds?: number;
}

export async function updateSecretStore(scope: Scope, name: string, input: UpdateSecretStoreInput, options: { confirmProtected?: boolean } = {}): Promise<SecretStoreView> {
  assertSecretStoresAvailable();
  const row = await findRow(scope, name);
  if (input.config !== undefined || input.credential !== undefined || input.allowedPaths !== undefined) {
    await assertNotProtected(scope.workspaceId, scope.environmentId, "changing a secret store", options.confirmProtected);
  }
  let config = row.config;
  let credentialEncrypted = row.credentialEncrypted;
  if (input.config !== undefined || input.credential !== undefined) {
    const credential = input.credential ?? decryptCredential(row);
    const privateNetwork = await privateNetworkAllowed(scope.workspaceId);
    const parsed = parseStore(row.type, { ...row.config, ...(input.config ?? {}) }, credential, privateNetwork);
    const moved = destinationChanges(row.type, row.config, parsed.config);
    if (moved.length > 0 && input.credential === undefined) {
      throw new ValidationError(`Changing config.${moved.join(", config.")} sends the store's credential somewhere new, so send credential again in the same request.`);
    }
    try {
      await authenticate(row.type, parsed.config, parsed.credential, { cacheKey: `check|${row.id}|${Date.now()}`, storeId: row.storeId, privateNetwork });
    } catch (error) {
      if (error instanceof StoreReadError) {
        logger.warn({ ...scope, store: name, reason: error.reason, detail: error.message }, "Secret store check failed; nothing was changed");
        throw new SecretStoreCheckFailedError(name, error.reason, "The store, with these settings,");
      }
      throw error;
    }
    config = parsed.config;
    if (input.credential !== undefined) {
      credentialEncrypted = encryptSecret(JSON.stringify(parsed.credential), env.DELIVERY_SECRET_MASTER_KEY, envelope(scope, row.storeId));
    }
  }
  const [updated] = await db.update(secretStores).set({
    config,
    credentialEncrypted,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.allowedPaths !== undefined ? { allowedPaths: input.allowedPaths } : {}),
    ...(input.cacheTtlSeconds !== undefined ? { cacheTtlSeconds: input.cacheTtlSeconds } : {}),
    ...(input.config !== undefined || input.credential !== undefined ? { health: healthNow(null) } : {}),
    updatedAt: new Date(),
  }).where(eq(secretStores.id, row.id)).returning();
  cacheDropStore(row.id);
  logger.info({ ...scope, store: name }, "Secret store updated");
  return toView(updated);
}

export async function deleteSecretStore(scope: Scope, name: string, options: { confirmProtected?: boolean } = {}): Promise<void> {
  assertSecretStoresAvailable();
  await assertNotProtected(scope.workspaceId, scope.environmentId, "deleting a secret store", options.confirmProtected);
  const row = await findRow(scope, name);
  const users = await db.select({ name: workspaceSecrets.name }).from(workspaceSecrets).where(eq(workspaceSecrets.secretStoreId, row.id));
  if (users.length > 0) throw new SecretStoreInUseError(name, users.map((u) => u.name).sort());
  await db.delete(secretStores).where(eq(secretStores.id, row.id));
  cacheDropStore(row.id);
  logger.info({ ...scope, store: name }, "Secret store deleted");
}

export async function checkSecretStore(scope: Scope, name: string): Promise<SecretStoreView> {
  assertSecretStoresAvailable();
  const row = await findRow(scope, name);
  let failure: SecretStoreFailure | null = null;
  try {
    await authenticate(row.type, row.config, decryptCredential(row), clientContext(row, await privateNetworkAllowed(scope.workspaceId)));
  } catch (error) {
    if (!(error instanceof StoreReadError)) throw error;
    failure = error.reason;
    logger.warn({ ...scope, store: name, reason: error.reason, detail: error.message }, "Secret store check failed");
  }
  const [updated] = await db.update(secretStores).set({ health: healthNow(failure) })
    .where(eq(secretStores.id, row.id)).returning();
  return toView(updated);
}

export interface ResolvedReference {
  storeRowId: string;
  store: string;
  storeType: SecretStoreType;
  location: ExternalLocation;
}

function pathAllowed(row: Pick<StoreRow, "allowedPaths">, path: string): boolean {
  const prefixes = row.allowedPaths;
  if (!prefixes || prefixes.length === 0) return true;
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
}

export async function resolveReference(scope: Scope, input: { store: string; path: string; key?: string | null; version?: string | null }): Promise<ResolvedReference> {
  assertSecretStoresAvailable();
  const row = await findRow(scope, input.store);
  const location: ExternalLocation = { path: input.path, key: input.key ?? null, version: input.version ?? null };
  if (!pathAllowed(row, location.path)) {
    throw new ValidationError(`Secret store ${row.name} allows only paths under ${row.allowedPaths!.join(", ")}.`);
  }
  if (row.type === "hashicorp_vault") {
    if (!vaultPathIsValid(location.path)) throw new ValidationError("A Vault path is the secret's path under the store's mount, such as payments/stripe, with no leading or trailing slash.");
    if (location.key === null) throw new ValidationError("A Vault secret is a map of keys, so name the key to use.");
    if (location.version !== null && !/^[1-9]\d{0,9}$/.test(location.version)) throw new ValidationError("A Vault version is a version number, such as 3.");
  }
  return { storeRowId: row.id, store: row.name, storeType: row.type, location };
}

export async function readExternalValue(
  scope: Scope,
  storeRowId: string,
  location: ExternalLocation,
  options: { bypassCache?: boolean } = {},
): Promise<{ value: string; store: string }> {
  assertSecretStoresAvailable();
  const [row] = await db.select().from(secretStores).where(and(
    eq(secretStores.id, storeRowId), eq(secretStores.workspaceId, scope.workspaceId), eq(secretStores.environmentId, scope.environmentId),
  ));
  if (!row) throw new StoreReadError("reference_not_found", "The secret store this secret points at no longer exists in its environment.");
  if (!pathAllowed(row, location.path)) throw new StoreReadError("store_denied", "The path is outside the store's allowed paths.");

  const ctx = clientContext(row, await privateNetworkAllowed(scope.workspaceId));
  const cacheKey = `${ctx.cacheKey}|value|${location.path}|${location.key ?? ""}|${location.version ?? ""}`;
  if (!options.bypassCache) {
    const cached = cacheGet<string>(cacheKey);
    if (cached !== undefined) return { value: cached, store: row.name };
  }
  const credential = decryptCredential(row);
  const value = row.type === "aws_secrets_manager"
    ? await awsRead(row.config as AwsSecretStoreConfig, credential as AwsStoreCredential, location, ctx)
    : await vaultRead(row.config as VaultSecretStoreConfig, credential as VaultStoreCredential, location, ctx);
  if (!options.bypassCache) cacheSet(cacheKey, value, row.cacheTtlSeconds * 1000);
  return { value, store: row.name };
}
