import { and, eq, isNotNull } from "drizzle-orm";
import { db, pool } from "../db/index.ts";
import { env } from "../config/env.ts";
import { workspaceSecrets } from "../db/schema/actions.ts";
import { eventSubscriptions } from "../db/schema/events.ts";
import { integrationConnections } from "../db/schema/integrations.ts";
import { notificationPreferences } from "../db/schema/notifications.ts";
import { apiKeyHistory, deliverySecrets } from "../db/schema/workspaces.ts";
import { oauthConnections } from "../db/schema/oauth-connections.ts";
import {
  decryptSecret,
  encryptSecret,
  secretEnvelopeVersion,
  upgradeSecretEnvelope,
  type SecretContext,
} from "../utils/crypto.ts";

type Tally = { v1: number; v2: number; v3: number; plaintext: number; unreadable: number; rewritten: number; skippedConcurrent: number; retiredKey: number };

interface Target {
  label: string;
  masterKey: string | undefined;
  load: () => Promise<Array<{ id: string; value: string; ctx: SecretContext }>>;
  write: (id: string, from: string, to: string) => Promise<number>;
  legacyIsPlaintext?: boolean;
}

function encryptPlaintext(value: string, masterKey: string, ctx: SecretContext): string | null {
  const encrypted = encryptSecret(value, masterKey, ctx);
  return decryptSecret(encrypted, masterKey, ctx) === value ? encrypted : null;
}

const targets: Target[] = [
  {
    label: "workspace_secrets.value_encrypted (vault)",
    masterKey: env.DELIVERY_SECRET_MASTER_KEY,
    load: async () =>
      (await db
        .select({ id: workspaceSecrets.id, value: workspaceSecrets.valueEncrypted, workspaceId: workspaceSecrets.workspaceId, environmentId: workspaceSecrets.environmentId, name: workspaceSecrets.name })
        .from(workspaceSecrets)).map((r) => ({
        id: r.id,
        value: r.value,
        ctx: { store: "vault", workspaceId: r.workspaceId, environmentId: r.environmentId, name: r.name },
      })),
    write: async (id, from, to) =>
      (await db.update(workspaceSecrets).set({ valueEncrypted: to })
        .where(and(eq(workspaceSecrets.id, id), eq(workspaceSecrets.valueEncrypted, from)))
        .returning({ id: workspaceSecrets.id })).length,
  },
  {
    label: "delivery_secrets.secret_encrypted",
    masterKey: env.DELIVERY_SECRET_MASTER_KEY,
    load: async () =>
      (await db.select({ id: deliverySecrets.id, value: deliverySecrets.secretEncrypted, workspaceId: deliverySecrets.workspaceId }).from(deliverySecrets))
        .map((r) => ({ id: r.id, value: r.value, ctx: { store: "delivery", workspaceId: r.workspaceId } })),
    write: async (id, from, to) =>
      (await db.update(deliverySecrets).set({ secretEncrypted: to })
        .where(and(eq(deliverySecrets.id, id), eq(deliverySecrets.secretEncrypted, from)))
        .returning({ id: deliverySecrets.id })).length,
  },
  {
    label: "event_subscriptions.secret_encrypted",
    masterKey: env.DELIVERY_SECRET_MASTER_KEY,
    load: async () =>
      (await db.select({ id: eventSubscriptions.id, value: eventSubscriptions.secretEncrypted, workspaceId: eventSubscriptions.workspaceId })
        .from(eventSubscriptions).where(isNotNull(eventSubscriptions.secretEncrypted)))
        .map((r) => ({ id: r.id, value: r.value as string, ctx: { store: "event-subscription", workspaceId: r.workspaceId } })),
    write: async (id, from, to) =>
      (await db.update(eventSubscriptions).set({ secretEncrypted: to })
        .where(and(eq(eventSubscriptions.id, id), eq(eventSubscriptions.secretEncrypted, from)))
        .returning({ id: eventSubscriptions.id })).length,
  },
  {
    label: "integration_connections.slack_access_token_encrypted",
    masterKey: env.INTEGRATION_ENCRYPTION_KEY,
    load: async () =>
      (await db.select({ id: integrationConnections.id, value: integrationConnections.slackAccessTokenEncrypted, workspaceId: integrationConnections.workspaceId })
        .from(integrationConnections).where(isNotNull(integrationConnections.slackAccessTokenEncrypted)))
        .map((r) => ({ id: r.id, value: r.value as string, ctx: { store: "integration", workspaceId: r.workspaceId } })),
    write: async (id, from, to) =>
      (await db.update(integrationConnections).set({ slackAccessTokenEncrypted: to })
        .where(and(eq(integrationConnections.id, id), eq(integrationConnections.slackAccessTokenEncrypted, from)))
        .returning({ id: integrationConnections.id })).length,
  },
  {
    label: "integration_connections.discord_webhook_url_encrypted",
    masterKey: env.INTEGRATION_ENCRYPTION_KEY,
    load: async () =>
      (await db.select({ id: integrationConnections.id, value: integrationConnections.discordWebhookUrlEncrypted, workspaceId: integrationConnections.workspaceId })
        .from(integrationConnections).where(isNotNull(integrationConnections.discordWebhookUrlEncrypted)))
        .map((r) => ({ id: r.id, value: r.value as string, ctx: { store: "integration", workspaceId: r.workspaceId } })),
    write: async (id, from, to) =>
      (await db.update(integrationConnections).set({ discordWebhookUrlEncrypted: to })
        .where(and(eq(integrationConnections.id, id), eq(integrationConnections.discordWebhookUrlEncrypted, from)))
        .returning({ id: integrationConnections.id })).length,
  },
  {
    label: "api_key_history.previous_key_hash_encrypted",
    masterKey: env.API_KEY_SECRET,
    load: async () =>
      (await db.select({ id: apiKeyHistory.id, value: apiKeyHistory.previousKeyHashEncrypted, workspaceId: apiKeyHistory.workspaceId }).from(apiKeyHistory))
        .map((r) => ({ id: r.id, value: r.value, ctx: { store: "api-key-history", workspaceId: r.workspaceId } })),
    write: async (id, from, to) =>
      (await db.update(apiKeyHistory).set({ previousKeyHashEncrypted: to })
        .where(and(eq(apiKeyHistory.id, id), eq(apiKeyHistory.previousKeyHashEncrypted, from)))
        .returning({ id: apiKeyHistory.id })).length,
  },
  {
    label: "notification_preferences.webhook_secret",
    masterKey: env.DELIVERY_SECRET_MASTER_KEY,
    legacyIsPlaintext: true,
    load: async () =>
      (await db.select({ id: notificationPreferences.id, value: notificationPreferences.webhookSecret, workspaceId: notificationPreferences.workspaceId })
        .from(notificationPreferences).where(isNotNull(notificationPreferences.webhookSecret)))
        .filter((r) => r.value !== "")
        .map((r) => ({ id: r.id, value: r.value as string, ctx: { store: "notification-webhook", workspaceId: r.workspaceId, name: "webhook_secret" } })),
    write: async (id, from, to) =>
      (await db.update(notificationPreferences).set({ webhookSecret: to })
        .where(and(eq(notificationPreferences.id, id), eq(notificationPreferences.webhookSecret, from)))
        .returning({ id: notificationPreferences.id })).length,
  },
  {
    label: "oauth_connections.access_token_encrypted",
    masterKey: env.CONNECTIONS_ENCRYPTION_KEY,
    load: async () =>
      (await db.select({ id: oauthConnections.id, value: oauthConnections.accessTokenEncrypted, workspaceId: oauthConnections.workspaceId }).from(oauthConnections))
        .map((r) => ({ id: r.id, value: r.value, ctx: { store: "oauth-connection", workspaceId: r.workspaceId, name: `${r.id}:access` } })),
    write: async (id, from, to) =>
      (await db.update(oauthConnections).set({ accessTokenEncrypted: to })
        .where(and(eq(oauthConnections.id, id), eq(oauthConnections.accessTokenEncrypted, from)))
        .returning({ id: oauthConnections.id })).length,
  },
  {
    label: "oauth_connections.refresh_token_encrypted",
    masterKey: env.CONNECTIONS_ENCRYPTION_KEY,
    load: async () =>
      (await db.select({ id: oauthConnections.id, value: oauthConnections.refreshTokenEncrypted, workspaceId: oauthConnections.workspaceId })
        .from(oauthConnections).where(isNotNull(oauthConnections.refreshTokenEncrypted)))
        .map((r) => ({ id: r.id, value: r.value as string, ctx: { store: "oauth-connection", workspaceId: r.workspaceId, name: `${r.id}:refresh` } })),
    write: async (id, from, to) =>
      (await db.update(oauthConnections).set({ refreshTokenEncrypted: to })
        .where(and(eq(oauthConnections.id, id), eq(oauthConnections.refreshTokenEncrypted, from)))
        .returning({ id: oauthConnections.id })).length,
  },
];

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--apply");
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(" ")}. Usage: reencrypt-secret-envelopes.ts [--apply]`);
  const apply = args.includes("--apply");

  console.log(apply ? "Mode: APPLY (rewriting v1/v2 values, and values under a retired master key, as v3 under the current key)" : "Mode: dry run (no writes; pass --apply to rewrite)");
  let problems = 0;

  for (const target of targets) {
    const tally: Tally = { v1: 0, v2: 0, v3: 0, plaintext: 0, unreadable: 0, rewritten: 0, skippedConcurrent: 0, retiredKey: 0 };
    if (!target.masterKey) {
      console.log(`\n${target.label}: key not configured, skipped`);
      continue;
    }
    const rows = await target.load();
    for (const row of rows) {
      if (target.legacyIsPlaintext && secretEnvelopeVersion(row.value) !== "v3") {
        tally.plaintext++;
        if (!apply) continue;
        const encrypted = encryptPlaintext(row.value, target.masterKey, row.ctx);
        if (!encrypted) {
          tally.unreadable++;
          problems++;
          console.error(`  did not read back after encryption: ${target.label} id=${row.id}`);
          continue;
        }
        if ((await target.write(row.id, row.value, encrypted)) === 1) tally.rewritten++;
        else tally.skippedConcurrent++;
        continue;
      }
      const result = upgradeSecretEnvelope(row.value, target.masterKey, row.ctx);
      tally[result.version]++;
      if (result.retiredKey) tally.retiredKey++;
      if (!result.readable) {
        tally.unreadable++;
        problems++;
        console.error(`  unreadable: ${target.label} id=${row.id} (${result.version})`);
        continue;
      }
      if (apply && result.upgraded) {
        if ((await target.write(row.id, row.value, result.upgraded)) === 1) tally.rewritten++;
        else tally.skippedConcurrent++;
      }
    }
    console.log(`\n${target.label}: ${rows.length} row(s)`);
    console.log(`  ${target.legacyIsPlaintext ? `plaintext=${tally.plaintext}` : `v1=${tally.v1} v2=${tally.v2}`} v3=${tally.v3} under-a-retired-key=${tally.retiredKey} unreadable=${tally.unreadable}` +
      (apply ? ` rewritten=${tally.rewritten} skipped(concurrent change)=${tally.skippedConcurrent}` : ""));
  }

  console.log(problems === 0
    ? "\nEvery value is readable."
    : `\n${problems} value(s) could not be decrypted with the configured key and context. They were not modified.`);
  return problems === 0 ? 0 : 1;
}

main()
  .then(async (code) => {
    await pool.end().catch(() => {});
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await pool.end().catch(() => {});
    process.exit(1);
  });
