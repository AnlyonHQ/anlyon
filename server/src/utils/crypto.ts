import crypto from "crypto";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";

export function generateApiKey(mode: "live" | "test" = "live"): { key: string; hash: string; prefix: string } {
  const randomPart = nanoid(32);
  const key = `anlyon_${mode}_${randomPart}`;
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  const prefix = key.substring(0, 20);

  return { key, hash, prefix };
}

export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export function verifyApiKey(key: string, hash: string): boolean {
  const keyHash = hashApiKey(key);
  return crypto.timingSafeEqual(Buffer.from(keyHash), Buffer.from(hash));
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateVerificationToken(): string {
  return nanoid(32);
}

export function generateMessageId(): string {
  return `msg_${nanoid(21)}`;
}

export function generateQueueId(): string {
  return `que_${nanoid(21)}`;
}

export function generateMcpUpstreamId(): string {
  return `mcpu_${nanoid(21)}`;
}

export function generateAgentId(): string {
  return `agt_${nanoid(21)}`;
}

export function generateAgentVersionId(): string {
  return `agv_${nanoid(21)}`;
}

export function generateRunId(): string {
  return `run_${nanoid(21)}`;
}

export function generateSpanId(): string {
  return `span_${nanoid(21)}`;
}

export function generateEventId(): string {
  return `evt_${nanoid(21)}`;
}

export function generateTopicId(): string {
  return `top_${nanoid(21)}`;
}

export function generateSubscriptionId(): string {
  return `sub_${nanoid(21)}`;
}

export function generateSecretId(): string {
  return `sec_${nanoid(21)}`;
}

export function generateActionVersionId(): string {
  return `acv_${nanoid(21)}`;
}

export function generateActionId(): string {
  return `act_${nanoid(21)}`;
}

export function generateInvocationId(): string {
  return `inv_${nanoid(21)}`;
}

export function generateFunctionId(): string {
  return `fn_${nanoid(21)}`;
}

export function generateFunctionVersionId(): string {
  return `fnv_${nanoid(21)}`;
}

export function generateFunctionRunId(): string {
  return `frn_${nanoid(21)}`;
}

export function generateEffectId(): string {
  return `eff_${nanoid(21)}`;
}

export function generatePreviewId(): string {
  return `prv_${nanoid(21)}`;
}

export function generateLimitId(): string {
  return `lim_${nanoid(21)}`;
}

export function generateApprovalId(): string {
  return `apr_${nanoid(21)}`;
}

export function generateContentHash(content: any): string {
  const normalized = JSON.stringify(content, Object.keys(content).sort());
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export function signWebhook(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = signWebhook(payload, secret);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}

export function generateDeliverySecret(): { secret: string; prefix: string } {
  const randomBytes = crypto.randomBytes(32);
  const secret = `whsec_${randomBytes.toString("base64url")}`;
  const prefix = secret.substring(0, 12);
  return { secret, prefix };
}

export type SecretStore =
  | "delivery"
  | "vault"
  | "event-subscription"
  | "integration"
  | "api-key-history"
  | "oauth-connection"
  | "secret-store"
  | "sso-provider"
  | "notification-webhook"
  | "audit-sink"
  | "instance-setting"
  | "oauth-app"
  | "sign-off";

export interface SecretContext {
  store: SecretStore;
  workspaceId?: string;
  environmentId?: string;
  name?: string;
}

const SECRET_ENVELOPE_VERSION = "v3";
const SECRET_ENVELOPE_V2 = "v2";

export type SecretEnvelopeVersion = "v1" | "v2" | "v3";

export function secretEnvelopeVersion(encryptedData: string): SecretEnvelopeVersion {
  if (encryptedData.startsWith(`${SECRET_ENVELOPE_VERSION}.`)) return "v3";
  if (encryptedData.startsWith(`${SECRET_ENVELOPE_V2}.`)) return "v2";
  return "v1";
}

function legacyEnvelopeReadsAllowed(): boolean {
  return process.env.LEGACY_SECRET_ENVELOPE !== "deny";
}

const HKDF_SALT = Buffer.from("anlyon.secret-envelope.v2");

function hkdf(masterKey: string, info: string, bytes: number): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(masterKey, "utf8"), HKDF_SALT, Buffer.from(info, "utf8"), bytes)
  );
}

export function masterKeyId(masterKey: string): string {
  return hkdf(masterKey, "key-id", 4).toString("hex");
}

function retiredMasterKeys(): string[] {
  return (process.env.SECRET_RETIRED_MASTER_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length >= 32);
}

function masterKeyForEnvelope(keyId: string, masterKey: string): string {
  if (keyId === masterKeyId(masterKey)) return masterKey;
  return retiredMasterKeys().find((retired) => masterKeyId(retired) === keyId) ?? masterKey;
}

export function isUnderAnotherMasterKey(encryptedData: string, masterKey: string): boolean {
  if (secretEnvelopeVersion(encryptedData) === "v1") return false;
  return encryptedData.split(".")[1] !== masterKeyId(masterKey);
}

function aad(ctx: SecretContext): Buffer {
  return Buffer.from(
    `${SECRET_ENVELOPE_VERSION}|${ctx.store}|${ctx.workspaceId ?? ""}|${ctx.environmentId ?? ""}|${ctx.name ?? ""}`,
    "utf8"
  );
}

function aadV2(ctx: SecretContext): Buffer {
  const workspaceId = ctx.store === "integration" ? "" : (ctx.workspaceId ?? "");
  return Buffer.from(`${SECRET_ENVELOPE_V2}|${ctx.store}|${workspaceId}`, "utf8");
}

export function encryptSecret(secret: string, masterKey: string, ctx: SecretContext): string {
  const key = hkdf(masterKey, `store:${ctx.store}`, 32);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(ctx));
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const combined = Buffer.concat([iv, encrypted, authTag]);
  return `${SECRET_ENVELOPE_VERSION}.${masterKeyId(masterKey)}.${combined.toString("base64")}`;
}

export function decryptSecret(encryptedData: string, masterKey: string, ctx: SecretContext): string {
  const version = secretEnvelopeVersion(encryptedData);
  if (version === "v3" || version === "v2") {
    const parts = encryptedData.split(".");
    if (parts.length !== 3) {
      throw new Error("Malformed secret envelope");
    }
    const key = hkdf(masterKeyForEnvelope(parts[1], masterKey), `store:${ctx.store}`, 32);
    return decryptCombined(Buffer.from(parts[2], "base64"), key, version === "v3" ? aad(ctx) : aadV2(ctx));
  }

  if (!legacyEnvelopeReadsAllowed()) {
    throw new Error("Legacy v1 secret envelope refused (LEGACY_SECRET_ENVELOPE is set to deny). Re-encrypt it with the backfill script.");
  }
  const legacyKey = crypto.createHash("sha256").update(masterKey).digest();
  return decryptCombined(Buffer.from(encryptedData, "base64"), legacyKey, undefined);
}

export function upgradeSecretEnvelope(
  encryptedData: string,
  masterKey: string,
  ctx: SecretContext
): { version: SecretEnvelopeVersion; readable: boolean; upgraded: string | null; retiredKey: boolean } {
  const version = secretEnvelopeVersion(encryptedData);
  const previous = process.env.LEGACY_SECRET_ENVELOPE;
  let plaintext: string;
  try {
    process.env.LEGACY_SECRET_ENVELOPE = "allow";
    plaintext = decryptSecret(encryptedData, masterKey, ctx);
  } catch {
    return { version, readable: false, upgraded: null, retiredKey: false };
  } finally {
    if (previous === undefined) delete process.env.LEGACY_SECRET_ENVELOPE;
    else process.env.LEGACY_SECRET_ENVELOPE = previous;
  }
  const retiredKey = isUnderAnotherMasterKey(encryptedData, masterKey);
  if (version === "v3" && !retiredKey) return { version, readable: true, upgraded: null, retiredKey };
  const upgraded = encryptSecret(plaintext, masterKey, ctx);
  if (decryptSecret(upgraded, masterKey, ctx) !== plaintext) {
    return { version, readable: true, upgraded: null, retiredKey };
  }
  return { version, readable: true, upgraded, retiredKey };
}

export function isLegacySecretEnvelope(encryptedData: string): boolean {
  return secretEnvelopeVersion(encryptedData) !== "v3";
}

function decryptCombined(combined: Buffer, key: Buffer, additionalData: Buffer | undefined): string {
  if (combined.length < 28) {
    throw new Error("Ciphertext too short to be a valid secret envelope");
  }

  const iv = combined.subarray(0, 12);
  const authTag = combined.subarray(combined.length - 16);
  const encrypted = combined.subarray(12, combined.length - 16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  if (additionalData) decipher.setAAD(additionalData);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function appendDeliverySignature(header: string, other: string): string {
  const extra = other
    .split(",")
    .filter((part) => part.startsWith("v1=") || part.startsWith("v2="))
    .join(",");
  return extra ? `${header},${extra}` : header;
}

export function signDeliveryPayload(
  payload: string,
  secret: string,
  timestamp: number
): string {
  const signedPayload = `${timestamp}.${payload}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");

  return `t=${timestamp},v1=${signature}`;
}

export function signDeliveryPayloadForEnvironment(
  payload: string,
  secret: string,
  environmentId: string,
  timestamp: number,
): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(environmentId)) {
    throw new Error("Invalid delivery environment identifier");
  }
  const legacy = signDeliveryPayload(payload, secret, timestamp);
  const signature = crypto.createHmac("sha256", secret)
    .update(`anlyon-delivery-v2.${timestamp}.${environmentId}.${payload}`).digest("hex");
  return `${legacy},env=${environmentId},v2=${signature}`;
}

export function standardWebhookKey(secret: string): Buffer {
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("A Standard Webhooks secret is whsec_ followed by base64");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length < 24 || key.length > 64) {
    throw new Error("A Standard Webhooks secret must decode to 24-64 bytes");
  }
  return key;
}

export function signStandardWebhook(id: string, timestamp: number, body: string, secret: string): string {
  const signature = crypto
    .createHmac("sha256", standardWebhookKey(secret))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return `v1,${signature}`;
}

export function verifyDeliverySignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds: number = 300
): { valid: boolean; error?: string } {
  const parts = signatureHeader.split(",");
  const timestampPart = parts.find((p) => p.startsWith("t="));
  const signaturePart = parts.find((p) => p.startsWith("v1="));

  if (!timestampPart || !signaturePart) {
    return { valid: false, error: "Invalid signature format" };
  }

  const timestamp = parseInt(timestampPart.substring(2), 10);
  const signature = signaturePart.substring(3);

  if (isNaN(timestamp)) {
    return { valid: false, error: "Invalid timestamp" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return { valid: false, error: "Timestamp outside tolerance window" };
  }

  const signedPayload = `${timestamp}.${payload}`;
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");

  try {
    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
    return { valid: isValid };
  } catch {
    return { valid: false, error: "Signature verification failed" };
  }
}

export function encryptIntegrationToken(
  token: string,
  encryptionKey: string,
  workspaceId: string
): string {
  return encryptSecret(token, encryptionKey, { store: "integration", workspaceId });
}

export function decryptIntegrationToken(
  encryptedToken: string,
  encryptionKey: string,
  workspaceId: string
): string {
  return decryptSecret(encryptedToken, encryptionKey, { store: "integration", workspaceId });
}

export function generateOAuthState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function generateFeedbackId(): string {
  return `fbk_${nanoid(21)}`;
}
