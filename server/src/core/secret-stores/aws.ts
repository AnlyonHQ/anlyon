import type { AwsSecretStoreConfig } from "../../db/schema/secret-stores.ts";
import { cacheGet, cacheSet } from "./cache.ts";
import { StoreReadError, discard, pickValue, storeJson, storeRequest, storeText } from "./http.ts";
import { signAwsRequest, type AwsCredentials } from "./sigv4.ts";
import type { ExternalLocation, StoreClientContext } from "./types.ts";

export interface AwsStoreCredential {
  accessKeyId: string;
  secretAccessKey: string;
}

const ASSUMED_ROLE_SECONDS = 900;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const AWS_REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
export const AWS_ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@\/-]{1,512}$/;

const DENIED_CODES = new Set([
  "AccessDenied", "AccessDeniedException", "UnrecognizedClientException", "InvalidClientTokenId",
  "SignatureDoesNotMatch", "InvalidSignatureException", "IncompleteSignature", "ExpiredToken",
  "ExpiredTokenException", "DecryptionFailure", "MissingAuthenticationToken", "RegionDisabledException",
]);
const NOT_FOUND_CODES = new Set(["ResourceNotFoundException", "InvalidRequestException", "InvalidParameterException"]);
const UNAVAILABLE_CODES = new Set(["ThrottlingException", "Throttling", "InternalServiceError", "InternalFailure", "ServiceUnavailable"]);

function classify(status: number, code: string | null, what: string): StoreReadError {
  if (status >= 500 || (code && UNAVAILABLE_CODES.has(code))) {
    return new StoreReadError("store_unreachable", `AWS answered ${status}${code ? ` ${code}` : ""} to ${what}.`);
  }
  if (code && NOT_FOUND_CODES.has(code)) return new StoreReadError("reference_not_found", `AWS answered ${code} to ${what}.`);
  if (status === 401 || status === 403 || (code && DENIED_CODES.has(code))) {
    return new StoreReadError("store_denied", `AWS refused ${what}${code ? ` (${code})` : ""}.`);
  }
  return new StoreReadError("store_denied", `AWS answered ${status}${code ? ` ${code}` : ""} to ${what}.`);
}

function xmlDecode(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function xmlTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? xmlDecode(match[1]!) : null;
}

async function sts(config: AwsSecretStoreConfig, credentials: AwsCredentials, params: Record<string, string>, now: Date): Promise<string> {
  const url = `https://sts.${config.region}.amazonaws.com/`;
  const body = new URLSearchParams({ ...params, Version: "2011-06-15" }).toString();
  const headers = signAwsRequest({
    method: "POST", url, body, region: config.region, service: "sts", credentials, now,
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
  });
  const response = await storeRequest(url, { method: "POST", headers, body });
  let text = "";
  try {
    text = await storeText(response);
  } catch {
    throw new StoreReadError("store_unreachable", `STS answered ${response.status} with an unreadable body.`);
  }
  if (!response.ok) throw classify(response.status, xmlTag(text, "Code"), `the STS ${params.Action} call`);
  return text;
}

export async function awsCredentials(
  config: AwsSecretStoreConfig, credential: AwsStoreCredential, ctx: StoreClientContext, now = new Date(),
): Promise<AwsCredentials> {
  const base: AwsCredentials = { accessKeyId: credential.accessKeyId, secretAccessKey: credential.secretAccessKey };
  if (config.auth !== "assume_role") return base;
  const key = `${ctx.cacheKey}|aws-role`;
  const cached = cacheGet<AwsCredentials>(key, now.getTime());
  if (cached) return cached;
  const xml = await sts(config, base, {
    Action: "AssumeRole",
    RoleArn: config.roleArn ?? "",
    RoleSessionName: `anlyon-${ctx.storeId}`.slice(0, 64),
    DurationSeconds: String(ASSUMED_ROLE_SECONDS),
    ...(config.externalId ? { ExternalId: config.externalId } : {}),
  }, now);
  const accessKeyId = xmlTag(xml, "AccessKeyId");
  const secretAccessKey = xmlTag(xml, "SecretAccessKey");
  const sessionToken = xmlTag(xml, "SessionToken");
  const expiration = Date.parse(xmlTag(xml, "Expiration") ?? "");
  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    throw new StoreReadError("store_unreachable", "STS answered AssumeRole without credentials.");
  }
  const assumed = { accessKeyId, secretAccessKey, sessionToken };
  const lifetime = (Number.isFinite(expiration) ? expiration : now.getTime() + ASSUMED_ROLE_SECONDS * 1000) - now.getTime() - 60_000;
  cacheSet(key, assumed, lifetime, now.getTime());
  return assumed;
}

export async function awsRead(
  config: AwsSecretStoreConfig, credential: AwsStoreCredential, location: ExternalLocation, ctx: StoreClientContext, now = new Date(),
): Promise<string> {
  const credentials = await awsCredentials(config, credential, ctx, now);
  const url = `https://secretsmanager.${config.region}.amazonaws.com/`;
  const body = JSON.stringify({
    SecretId: location.path,
    ...(location.version ? (VERSION_ID.test(location.version) ? { VersionId: location.version } : { VersionStage: location.version }) : {}),
  });
  const headers = signAwsRequest({
    method: "POST", url, body, region: config.region, service: "secretsmanager", credentials, now,
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "secretsmanager.GetSecretValue" },
  });
  const response = await storeRequest(url, { method: "POST", headers, body });
  if (!response.ok) {
    let code: string | null = response.headers.get("x-amzn-errortype")?.split(":")[0] ?? null;
    if (!code) {
      const parsed = await storeJson(response).catch(() => ({} as Record<string, unknown>));
      code = typeof parsed.__type === "string" ? parsed.__type.split("#").pop() ?? null : null;
    } else {
      await discard(response);
    }
    throw classify(response.status, code, "GetSecretValue");
  }
  const parsed = await storeJson(response);
  if (typeof parsed.SecretString !== "string") {
    throw new StoreReadError("reference_not_found", "The secret holds binary data, not a string.");
  }
  return pickValue(parsed.SecretString, location.key);
}

export async function awsCheck(
  config: AwsSecretStoreConfig, credential: AwsStoreCredential, ctx: StoreClientContext, now = new Date(),
): Promise<void> {
  const credentials = await awsCredentials(config, credential, ctx, now);
  await sts(config, credentials, { Action: "GetCallerIdentity" }, now);
}
