import type { FeatureKey } from "@anlyon/feature-flags";
import { z } from "zod";

export type InstanceSettingGroup = "email" | "storage" | "accounts" | "license" | "telemetry" | "oauth" | "slack" | "mcp" | "network";

export interface InstanceSettingDefinition {
  key: string;
  group: InstanceSettingGroup;
  label: string;
  env: string;
  secret: boolean;
  description: string;
  schema: z.ZodType<string>;
  default?: string;
  fromEnv?: (raw: string) => string;
  feature?: FeatureKey;
}

export const AUDIT_HOT_DAYS_DEFAULT = 90;
export const NOTIFICATION_EMAIL_ALERT_DEFAULT = 10_000;
export const MCP_TOOL_CHECK_INTERVAL_DEFAULT_HOURS = 24;
export const PRIVATE_DESTINATION_POLICIES = ["workspace", "off"] as const;
export type PrivateDestinationPolicy = (typeof PRIVATE_DESTINATION_POLICIES)[number];
export const MCP_TOOL_CHECK_INTERVAL_MAX_HOURS = 168;

const nonEmpty = z.string().trim().min(1).max(4096);
const bool = z.enum(["true", "false"]);
const clientId = z.string().trim().min(1).max(512);
const clientSecret = z.string().trim().min(1).max(2048);

const OAUTH_PROVIDERS = [
  { id: "hubspot", env: "HUBSPOT", label: "HubSpot" },
  { id: "slack", env: "SLACK", label: "Slack (connected accounts)" },
  { id: "google", env: "GOOGLE", label: "Google (Calendar and Gmail)" },
  { id: "linear", env: "LINEAR", label: "Linear" },
  { id: "salesforce", env: "SALESFORCE", label: "Salesforce" },
  { id: "github", env: "GITHUB", label: "GitHub (OAuth app or GitHub App)" },
  { id: "notion", env: "NOTION", label: "Notion (public integration)" },
] as const;

export const INSTANCE_SETTINGS: readonly InstanceSettingDefinition[] = [
  {
    key: "email.smtp_url",
    group: "email",
    label: "SMTP server",
    env: "SMTP_URL",
    secret: true,
    description: "smtp://user:password@host:587 or smtps://user:password@host:465. Unset means email is off.",
    schema: z
      .string()
      .trim()
      .url()
      .refine((value) => /^smtps?:\/\//.test(value), "Must start with smtp:// or smtps://"),
  },
  {
    key: "email.from",
    group: "email",
    label: "Sender address",
    env: "FROM_EMAIL",
    secret: false,
    description: "The address email is sent from.",
    schema: z.string().trim().email(),
  },
  {
    key: "email.notification_alert_threshold",
    group: "email",
    label: "Notification email alert",
    env: "NOTIFICATION_EMAIL_ALERT_THRESHOLD",
    secret: false,
    description: `Warn in the server log and Sentry each time one workspace's notification emails in a month pass a multiple of this number. Nothing is blocked. 0 turns it off; ${NOTIFICATION_EMAIL_ALERT_DEFAULT} by default.`,
    schema: z.string().trim().regex(/^\d+$/, "A whole number"),
    default: String(NOTIFICATION_EMAIL_ALERT_DEFAULT),
  },
  {
    key: "storage.backend",
    group: "storage",
    label: "File storage",
    env: "STORAGE_BACKEND",
    secret: false,
    description: "none, local (a directory on this server) or s3 (any S3-compatible store). Holds log archives.",
    schema: z.enum(["none", "local", "s3"]),
  },
  {
    key: "storage.local_dir",
    group: "storage",
    label: "Local directory",
    env: "STORAGE_LOCAL_DIR",
    secret: false,
    description: "Where local storage writes. Relative to the server's working directory; the bundled compose file keeps it on a volume.",
    schema: nonEmpty
      .max(1024)
      .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value), "Must be a relative path")
      .refine((value) => value.split(/[\\/]/).every((segment) => segment !== ".."), "Must stay inside the working directory"),
    default: "data/storage",
  },
  {
    key: "storage.s3_endpoint",
    group: "storage",
    label: "S3 endpoint",
    env: "S3_ENDPOINT",
    secret: false,
    description: "For MinIO, Ceph and other S3-compatible stores. Empty for AWS S3.",
    schema: z.string().trim().url(),
  },
  {
    key: "storage.s3_region",
    group: "storage",
    label: "S3 region",
    env: "S3_REGION",
    secret: false,
    description: "The bucket's region.",
    schema: nonEmpty.max(64),
    default: "us-east-1",
  },
  { key: "storage.s3_bucket", group: "storage", label: "S3 bucket", env: "S3_BUCKET", secret: false, description: "The bucket name.", schema: nonEmpty.max(255) },
  {
    key: "storage.s3_access_key_id",
    group: "storage",
    label: "S3 access key id",
    env: "S3_ACCESS_KEY_ID",
    secret: false,
    description: "The access key id.",
    schema: nonEmpty.max(256),
  },
  {
    key: "storage.s3_secret_access_key",
    group: "storage",
    label: "S3 secret access key",
    env: "S3_SECRET_ACCESS_KEY",
    secret: true,
    description: "The secret access key.",
    schema: nonEmpty.max(1024),
  },
  {
    key: "storage.s3_force_path_style",
    group: "storage",
    label: "Path-style URLs",
    env: "S3_FORCE_PATH_STYLE",
    secret: false,
    description: "MinIO and most self-hosted stores need it.",
    schema: bool,
    default: "true",
  },
  {
    key: "storage.audit_archive_paused",
    group: "storage",
    label: "Pause the audit archive",
    env: "AUDIT_ARCHIVE_PAUSED",
    secret: false,
    description:
      "Stops moving audit records to the archive and deleting archived ones. Records stay in the database meanwhile; nothing is lost. Records past their retention are still deleted from the database.",
    schema: bool,
    default: "false",
  },
  {
    key: "storage.audit_hot_days",
    group: "storage",
    label: "Audit records kept in the database",
    env: "AUDIT_HOT_DAYS",
    secret: false,
    description: `Days an audit record stays in the database, listed in the console, before it moves to the archive. 30 to 365; ${AUDIT_HOT_DAYS_DEFAULT} by default.`,
    schema: z.string().trim().regex(/^\d+$/, "A whole number of days").refine((value) => Number(value) >= 30 && Number(value) <= 365, "From 30 to 365 days"),
    default: String(AUDIT_HOT_DAYS_DEFAULT),
  },
  {
    key: "accounts.signup_mode",
    group: "accounts",
    label: "Sign-up",
    env: "SIGNUP_MODE",
    secret: false,
    description: "invite: only people holding an invitation. open: anyone who can reach the console. closed: nobody; accounts come from the command line.",
    schema: z.enum(["open", "invite", "closed"]),
    default: "invite",
  },
  {
    key: "license.key",
    group: "license",
    label: "Licence key",
    env: "ANLYON_LICENSE_KEY",
    secret: true,
    description: "A Team or Enterprise licence key. Verified offline; nothing is sent anywhere.",
    schema: z.string().trim().min(1).max(8192),
  },
  {
    key: "telemetry.enabled",
    group: "telemetry",
    label: "Anonymous telemetry",
    env: "ANLYON_TELEMETRY",
    secret: false,
    description: "One anonymous report a day: a random instance id, the version, the edition and counts. No names, emails, payloads or hostnames.",
    schema: bool,
    default: "true",
    fromEnv: (raw) => (["off", "0", "false"].includes(raw.trim().toLowerCase()) ? "false" : "true"),
  },
  ...OAUTH_PROVIDERS.flatMap(({ id, env, label }): InstanceSettingDefinition[] => [
    {
      key: `oauth.${id}.client_id`,
      group: "oauth",
      label: `${label} client id`,
      env: `${env}_OAUTH_CLIENT_ID`,
      secret: false,
      description: `The client id of your ${label} OAuth app. Redirect URI: <public URL>/api/v2/connection-consent/callback.`,
      schema: clientId,
    },
    {
      key: `oauth.${id}.client_secret`,
      group: "oauth",
      label: `${label} client secret`,
      env: `${env}_OAUTH_CLIENT_SECRET`,
      secret: true,
      description: `The client secret of your ${label} OAuth app.`,
      schema: clientSecret,
    },
  ]),
  {
    key: "mcp.tool_check_interval_hours",
    group: "mcp",
    label: "Check tools every",
    env: "MCP_TOOL_CHECK_INTERVAL_HOURS",
    secret: false,
    description: `Hours between re-listing each MCP server, so people hear that a tool changed before an agent calls it. 1 to ${MCP_TOOL_CHECK_INTERVAL_MAX_HOURS}; ${MCP_TOOL_CHECK_INTERVAL_DEFAULT_HOURS} by default. Applies from each server's next check.`,
    schema: z.string().trim().regex(/^\d+$/, "A whole number of hours").refine((value) => Number(value) >= 1 && Number(value) <= MCP_TOOL_CHECK_INTERVAL_MAX_HOURS, `From 1 to ${MCP_TOOL_CHECK_INTERVAL_MAX_HOURS} hours`),
    default: String(MCP_TOOL_CHECK_INTERVAL_DEFAULT_HOURS),
    feature: "mcp-upstreams",
  },
  {
    key: "network.private_destinations",
    group: "network",
    label: "Private network destinations",
    env: "PRIVATE_NETWORK_DESTINATIONS",
    secret: false,
    description:
      "Whether audit sinks and secret stores may reach addresses on a private network (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, localhost). workspace: each workspace's admins decide, off until they turn it on. off: no workspace may, whatever it chose. Link-local and cloud metadata addresses are never reachable.",
    schema: z.enum(PRIVATE_DESTINATION_POLICIES),
    default: "workspace",
  },
  {
    key: "slack.client_id",
    group: "slack",
    label: "Slack app client id",
    env: "SLACK_CLIENT_ID",
    secret: false,
    description: "The Slack app that posts notifications and approval requests.",
    schema: clientId,
  },
  { key: "slack.client_secret", group: "slack", label: "Slack app client secret", env: "SLACK_CLIENT_SECRET", secret: true, description: "The Slack app's client secret.", schema: clientSecret },
  {
    key: "slack.signing_secret",
    group: "slack",
    label: "Slack signing secret",
    env: "SLACK_SIGNING_SECRET",
    secret: true,
    description: "Verifies that approve and deny clicks come from Slack.",
    schema: clientSecret,
  },
];

export type InstanceSettingKey = string;

const BY_KEY = new Map(INSTANCE_SETTINGS.map((definition) => [definition.key, definition]));

export function instanceSettingDefinition(key: string): InstanceSettingDefinition | undefined {
  return BY_KEY.get(key);
}

export const INTERNAL_KEYS = {
  setupCompletedAt: "internal.setup_completed_at",
  setupTokenHash: "internal.setup_token_hash",
  instanceId: "internal.instance_id",
  telemetryLastSentAt: "internal.telemetry_last_sent_at",
  rootKeyBackupConfirmedAt: "internal.root_key_backup_confirmed_at",
} as const;

export function oauthClientKeys(credentials: string): { clientId: string; clientSecret: string } {
  const id = credentials.toLowerCase();
  return { clientId: `oauth.${id}.client_id`, clientSecret: `oauth.${id}.client_secret` };
}
