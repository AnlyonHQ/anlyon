import { createHash, createHmac } from "node:crypto";

export interface SigV4Request {
  method: string;
  path: string;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

export function encodeS3Key(key: string): string {
  return key
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join("/");
}

export function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export function signV4(request: SigV4Request): string {
  const service = request.service ?? "s3";
  const date = request.headers["x-amz-date"];
  if (!date) throw new Error("x-amz-date header is required");
  const day = date.slice(0, 8);
  const names = Object.keys(request.headers).map((name) => name.toLowerCase()).sort();
  const canonicalHeaders = names.map((name) => `${name}:${request.headers[name].trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [request.method, request.path, "", canonicalHeaders, signedHeaders, request.payloadHash].join("\n");
  const scope = `${day}/${request.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${request.secretAccessKey}`, day);
  const kRegion = hmac(kDate, request.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
