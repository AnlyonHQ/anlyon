import { z } from "zod";
import { validateUrl } from "../../../utils/url-validation.ts";
import { ValidationError } from "../../../utils/errors.ts";

const httpsUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "Must be an https:// URL")
  .refine((value) => {
    try {
      const url = new URL(value);
      return !url.username && !url.password;
    } catch {
      return false;
    }
  }, "The URL must not carry a username or password; put credentials in the sink's credentials");

export function assertDestination(url: string, allowPrivateNetwork: boolean): void {
  const { hostname } = new URL(url);
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host.includes("metadata") || /^169\.254\./.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    throw new ValidationError(`${url} cannot be used as a destination: metadata and link-local addresses are refused.`);
  }
  if (allowPrivateNetwork) return;
  const result = validateUrl(url);
  if (!result.valid) {
    throw new ValidationError(`${url} cannot be used as a destination: ${result.error ?? "refused"}. A self-hosted deployment can allow private network destinations in the audit settings.`);
  }
}

export function destinationUrls(type: SinkType, config: Record<string, unknown>): string[] {
  const urls = type === "webhook" || type === "splunk" ? [config.url] : type === "s3" ? [config.endpoint] : [];
  return urls.filter((url): url is string => typeof url === "string" && url.length > 0);
}

export const DATADOG_SITES = [
  "datadoghq.com",
  "us3.datadoghq.com",
  "us5.datadoghq.com",
  "datadoghq.eu",
  "ap1.datadoghq.com",
  "ap2.datadoghq.com",
  "ddog-gov.com",
] as const;

export const webhookConfigSchema = z.object({ url: httpsUrl }).strict();
export const webhookCredentialsSchema = z.object({ signingSecret: z.string().min(16).max(256) }).strict();

export const s3ConfigSchema = z
  .object({
    bucket: z.string().trim().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, "Not a valid bucket name"),
    region: z.string().trim().min(1).max(64).regex(/^[a-z0-9-]+$/, "Not a valid region"),
    endpoint: httpsUrl.optional(),
    prefix: z
      .string()
      .trim()
      .max(256)
      .regex(/^[A-Za-z0-9!_.*'()/-]*$/, "Use letters, digits and / - _ . ! * ' ( ) only")
      .optional(),
    forcePathStyle: z.boolean().optional(),
  })
  .strict();
export const s3CredentialsSchema = z
  .object({
    accessKeyId: z.string().trim().min(1).max(256),
    secretAccessKey: z.string().min(1).max(512),
    sessionToken: z.string().min(1).max(4096).optional(),
  })
  .strict();

export const datadogConfigSchema = z
  .object({
    site: z.enum(DATADOG_SITES),
    service: z.string().trim().min(1).max(100).optional(),
    tags: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  })
  .strict();
export const datadogCredentialsSchema = z.object({ apiKey: z.string().trim().min(1).max(256) }).strict();

export const splunkConfigSchema = z
  .object({
    url: httpsUrl,
    index: z.string().trim().min(1).max(100).optional(),
    sourcetype: z.string().trim().min(1).max(100).optional(),
    source: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export const splunkCredentialsSchema = z.object({ token: z.string().trim().min(1).max(256) }).strict();

export type SinkType = "webhook" | "s3" | "datadog" | "splunk";
export const SINK_TYPES: readonly SinkType[] = ["webhook", "s3", "datadog", "splunk"];

export type WebhookConfig = z.infer<typeof webhookConfigSchema>;
export type S3Config = z.infer<typeof s3ConfigSchema>;
export type DatadogConfig = z.infer<typeof datadogConfigSchema>;
export type SplunkConfig = z.infer<typeof splunkConfigSchema>;

export type SinkTarget =
  | { type: "webhook"; config: WebhookConfig; credentials: z.infer<typeof webhookCredentialsSchema> }
  | { type: "s3"; config: S3Config; credentials: z.infer<typeof s3CredentialsSchema> }
  | { type: "datadog"; config: DatadogConfig; credentials: z.infer<typeof datadogCredentialsSchema> }
  | { type: "splunk"; config: SplunkConfig; credentials: z.infer<typeof splunkCredentialsSchema> };

export const CONFIG_SCHEMAS = {
  webhook: webhookConfigSchema,
  s3: s3ConfigSchema,
  datadog: datadogConfigSchema,
  splunk: splunkConfigSchema,
} as const;

export const CREDENTIAL_INPUT_SCHEMAS = {
  s3: s3CredentialsSchema,
  datadog: datadogCredentialsSchema,
  splunk: splunkCredentialsSchema,
} as const;

export const BATCH_SIZE: Record<SinkType, number> = { webhook: 100, s3: 1000, datadog: 500, splunk: 200 };

export const IDLE_DELAY_MS: Record<SinkType, number> = { webhook: 0, s3: 60_000, datadog: 0, splunk: 0 };
