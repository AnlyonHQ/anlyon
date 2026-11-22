import { z } from "zod";
import "../utils/zod-compat.ts";
import dotenv from "dotenv";
import { applyPublicUrl, applyRootKey, type DerivedKeyName } from "./root-key.ts";
import { EDITIONS, EditionConfigError, editionDecision, type Edition } from "../core/edition/edition.ts";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  
  DATABASE_URL: z.string().url().min(1),
  MIGRATE_DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().min(1),
  BETTER_AUTH_SECRET: z.string().min(32, "Secret must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url(),
  API_KEY_SECRET: z.string().min(32, "Secret must be at least 32 characters"),
  DELIVERY_SECRET_MASTER_KEY: z.string().min(32, "Master key must be at least 32 characters"),

  RESEND_API_KEY: z.string().startsWith("re_").optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  FROM_EMAIL: z.string().email().optional(),
  CONSOLE_URL: z.string().url().default("https://console.anlyon.com"),
  REQUIRE_EMAIL_VERIFICATION: z.enum(["true", "false"]).optional(),
  METRICS_TOKEN: z.string().min(16).optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
  ENABLE_WORKERS: z
    .string()
    .optional()
    .transform((value) => !value || !["false", "0", "no", "off"].includes(value.trim().toLowerCase())),
  CONSUMER_WORKERS: z.string().optional(),
  TRACE_REDACTION: z.string().optional(),
  TRACE_MAX_PAYLOAD_BYTES: z.string().optional(),
  SCHEDULER_POLL_INTERVAL: z.string().optional(),
  RATE_LIMIT_WINDOW: z.string().optional(),
  RATE_LIMIT_MAX: z.coerce.number().optional(),
  DEFAULT_MAX_RETRIES: z.string().optional(),
  MAX_MESSAGE_SIZE: z.string().optional(),

  INTERNAL_AUTH_SECRET: z.string().min(32).optional(),

  FUNCTION_RUNNER_URL: z.string().url().optional(),
  RUNNER_SHARED_SECRET: z.string().min(32, "RUNNER_SHARED_SECRET must be at least 32 characters").optional(),
  RUNNER_SHARED_SECRET_ROTATING: z.string().min(32, "RUNNER_SHARED_SECRET_ROTATING must be at least 32 characters").optional(),

  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_RELEASE: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
  SENTRY_PROFILES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
  SENTRY_DEBUG: z.string().optional(),

  DATADOG_API_KEY: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
  API_BASE_URL: z.string().url().optional(),
  FRONTEND_URL: z.string().url().optional(),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),

  LEGACY_SECRET_ENVELOPE: z.enum(["allow", "deny"]).optional(),

  INTEGRATION_ENCRYPTION_KEY: z.string().min(32).optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET_NAME: z.string().min(1).optional(),
  AUDIT_ARCHIVE_R2_BUCKET: z.string().min(1).optional(),
  AUDIT_ARCHIVE_R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  AUDIT_ARCHIVE_R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),

  LOG_RETENTION_HOT_DAYS: z.coerce.number().int().positive().default(7),
  LOG_ARCHIVAL_ENABLED: z.string().optional(),
  LOG_ARCHIVAL_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(3),

  OPENROUTER_API_KEY: z.string().startsWith("sk-or-").optional(),
  EMBEDDING_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  LLM_MODEL: z.string().default("openai/gpt-4o-mini"),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  TYPESAFE_API_KEY: z.string().min(1).optional(),
  TYPESAFE_BASE_URL: z.string().url().default("https://api.typesafe.ai/v1"),
  TYPESAFE_MODEL: z.string().default("jev-1.13.0"),
  TYPESAFE_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(5000),
  ASSISTANT_AUTO_APPROVE_DISABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  ASSISTANT_PLATFORM_MONTHLY_REVIEW_CEILING: z.coerce.number().int().positive().default(2_000_000),
  MAINTENANCE_SWEEP_INTERVAL_MS: z.coerce.number().int().min(60000).default(3600000),
  EVENTS_FANOUT_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  EVENTS_STREAM_MAXLEN: z.coerce.number().int().min(1000).default(100000),

  ACTION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
  ACTION_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).default(65536),
  APPROVAL_DEFAULT_TTL_HOURS: z.coerce.number().int().min(1).default(24),

  CONNECTIONS_ENCRYPTION_KEY: z.string().min(32, "Key must be at least 32 characters").optional(),
  SECRET_RETIRED_MASTER_KEYS: z.string().optional(),
  CONNECT_PUBLIC_URL: z.string().url().optional(),
  CONNECT_PAGES_URL: z.string().url().refine((value) => {
    const url = new URL(value);
    return (url.protocol === "https:" || url.hostname === "localhost") && (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash;
  }, "An https origin with no path, such as https://connect.anlyon.com").optional(),
  HUBSPOT_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  HUBSPOT_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  SLACK_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  SLACK_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  LINEAR_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  LINEAR_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  SALESFORCE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  SALESFORCE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  NOTION_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  NOTION_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  CONNECTIONS_ALLOW_UNVERIFIED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  CONNECTION_HEALTH_CHECK_INTERVAL_MS: z.coerce.number().int().min(60 * 60 * 1000).default(24 * 60 * 60 * 1000),

  EDITION: z.enum(EDITIONS).optional(),
  ANLYON_LICENSE_KEY: z.string().min(1).optional(),
  SIGNUP_MODE: z.enum(["open", "invite", "closed"]).optional(),
  SMTP_URL: z.string().url().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  ENFORCE_HTTPS: z.enum(["true", "false"]).optional(),

  ANLYON_ROOT_KEY: z.string().min(32, "Root key must be at least 32 characters").optional(),
  ANLYON_PUBLIC_URL: z.string().url().optional(),
  ANLYON_SETUP_TOKEN: z.string().min(32, "Setup token must be at least 32 characters (the installers write 43)").optional(),
  ANLYON_TELEMETRY: z.enum(["on", "off", "1", "0", "true", "false"]).optional(),
  ANLYON_TELEMETRY_URL: z.string().url().default("https://telemetry.anlyon.com/v1/ping"),
  STORAGE_BACKEND: z.enum(["none", "local", "s3"]).optional(),
  STORAGE_LOCAL_DIR: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.NODE_ENV === "production" && value.FUNCTION_RUNNER_URL && !value.FUNCTION_RUNNER_URL.startsWith("https://")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["FUNCTION_RUNNER_URL"], message: "Must be an https:// URL in production" });
  }
});

function withoutEmptyValues(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== "") out[key] = value;
  }
  return out;
}

let derivedFromRootKey: DerivedKeyName[] = [];

function validateEnv() {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
    const testEnv = {
      NODE_ENV: 'test' as const,
      PORT: 4000,
      HOST: '0.0.0.0',
      DATABASE_URL: process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test',
      REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || 'test-secret-at-least-32-characters-long',
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL || 'http://localhost:4000',
      API_KEY_SECRET: process.env.API_KEY_SECRET || 'test-api-key-secret-32-chars-min',
      DELIVERY_SECRET_MASTER_KEY: process.env.DELIVERY_SECRET_MASTER_KEY || 'test-delivery-master-key-00000000',
      GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID || 'test-github-client-id',
      GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET || 'test-github-client-secret',
      INTEGRATION_ENCRYPTION_KEY: process.env.INTEGRATION_ENCRYPTION_KEY || 'test-integration-encryption-key-32c',
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || 'test-google-client-id',
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || 'test-google-client-secret',
      ...withoutEmptyValues(process.env),
    };

    return envSchema.parse(testEnv);
  }

  let edition: Edition;
  try {
    edition = editionDecision().edition;
  } catch (error) {
    if (!(error instanceof EditionConfigError)) throw error;
    console.error(`❌ Invalid environment variables:
  EDITION: ${error.message}`);
    process.exit(1);
  }

  const rootKey = applyRootKey(applyPublicUrl(withoutEmptyValues(process.env), edition), edition);
  if (rootKey.error) {
    console.error(`❌ Invalid environment variables:
  ANLYON_ROOT_KEY: ${rootKey.error}`);
    process.exit(1);
  }
  derivedFromRootKey = rootKey.derived;

  const result = envSchema.safeParse(rootKey.env);
  const issues = result.success ? [] : result.error.issues.map((err) => `  ${err.path.join(".")}: ${err.message}`);
  if (edition === "cloud") {
    for (const key of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"] as const) {
      if (!rootKey.env[key]) issues.push(`  ${key}: Required in the cloud edition`);
    }
  }

  if (!result.success || issues.length > 0) {
    console.error("❌ Invalid environment variables:");
    issues.forEach((issue) => console.error(issue));
    process.exit(1);
  }

  return result.data;
}

export const env = validateEnv();

export function keysDerivedFromRootKey(): readonly DerivedKeyName[] {
  return derivedFromRootKey;
}
