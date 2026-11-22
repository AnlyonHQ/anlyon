import crypto from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignInput {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  now: Date;
}

const sha256Hex = (data: string) => crypto.createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: Buffer | string, data: string) => crypto.createHmac("sha256", key).update(data, "utf8").digest();

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export function canonicalRequest(input: SignInput, headers: Record<string, string>): { request: string; signedHeaders: string } {
  const url = new URL(input.url);
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map((n) => `${n}:${String(lower[n]).trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const request = [
    input.method,
    url.pathname || "/",
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    sha256Hex(input.body),
  ].join("\n");
  return { request, signedHeaders };
}

export function signAwsRequest(input: SignInput): Record<string, string> {
  const { amzDate, dateStamp } = amzDates(input.now);
  const headers: Record<string, string> = {
    ...input.headers,
    host: new URL(input.url).host,
    "x-amz-date": amzDate,
    ...(input.credentials.sessionToken ? { "x-amz-security-token": input.credentials.sessionToken } : {}),
  };
  const { request, signedHeaders } = canonicalRequest(input, headers);
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(request)].join("\n");
  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
