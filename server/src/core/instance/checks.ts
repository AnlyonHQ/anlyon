import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { fromAddress, isEmailConfigured, mailTransport, resendClient } from "../../lib/resend-client.ts";
import { storageBackend, storageBucket, storageClient } from "../../lib/r2-client.ts";
import { verifyLicenseKey } from "../../ee/licensing/license.ts";
import { LICENSE_PUBLIC_KEYS } from "../../ee/licensing/public-key.ts";

export interface CheckResult {
  ok: boolean;
  message: string;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

export async function sendTestEmail(to: string): Promise<CheckResult> {
  if (!isEmailConfigured()) {
    return { ok: false, message: "Email is off: set an SMTP server and a sender address first." };
  }
  try {
    const { id } = await resendClient.emails.send({
      from: fromAddress(),
      to,
      subject: "Anlyon test email",
      text: "This is a test email from your Anlyon server. Email works.",
      html: "<p>This is a test email from your Anlyon server. Email works.</p>",
    });
    if (mailTransport() === "resend" && !id) return { ok: false, message: "The mail service refused the message." };
    return { ok: true, message: `Sent to ${to}. Check that it arrived.` };
  } catch (error) {
    return { ok: false, message: `The mail server refused it: ${reason(error)}` };
  }
}

export async function testStorage(): Promise<CheckResult> {
  const client = storageClient();
  const bucket = storageBucket();
  if (!client || !bucket) return { ok: false, message: "No file storage is configured." };
  const key = `anlyon-storage-check/${randomUUID()}.txt`;
  const body = `anlyon storage check ${new Date().toISOString()}`;
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "text/plain" }));
    const read = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await read.Body?.transformToString();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    if (text !== body) return { ok: false, message: "An object was written but did not read back the same." };
    return { ok: true, message: `Storage works (${storageBackend()}): an object was written, read back and deleted.` };
  } catch (error) {
    return { ok: false, message: `Storage check failed: ${reason(error)}` };
  }
}

export interface LicensePreview {
  valid: boolean;
  message: string;
  tier: string | null;
  org: string | null;
  seats: number | null;
  features: string[];
  expiresAt: string | null;
}

export function previewLicense(key: string, now: Date = new Date()): LicensePreview {
  const result = verifyLicenseKey(key, { publicKeys: LICENSE_PUBLIC_KEYS, now });
  const license = result.license;
  return {
    valid: result.ok,
    message: result.message,
    tier: license?.tier ?? null,
    org: license?.org ?? null,
    seats: license?.seats ?? null,
    features: license?.features ?? [],
    expiresAt: license?.expiresAt.toISOString() ?? null,
  };
}
