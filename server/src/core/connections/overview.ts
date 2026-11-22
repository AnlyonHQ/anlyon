import { and, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { env } from "../../config/env.ts";
import { oauthConnections } from "../../db/schema/oauth-connections.ts";
import { listSecrets } from "../actions/secrets.ts";
import { sharedAppOffered } from "../end-users/connect.ts";
import { consentRedirectUri, listEnvironmentOAuthApps } from "../end-users/oauth-apps.ts";
import { CATALOGUE, integrationView, keyAuthOf, type IntegrationEntry } from "./catalogue.ts";
import { OAUTH_APPS } from "./oauth-apps.ts";
import { connectionProvider } from "./provider.ts";

type Scope = { workspaceId: string; environmentId: string };

export type SignInApp = "own" | "anlyon" | "own_required" | "unavailable";

export interface IntegrationOverview extends ReturnType<typeof integrationView> {
  connectable: boolean;
  signIn: { app: SignInApp; redirectUri: string } | null;
  workspace: { connected: number; needsAttention: number };
  endUsers: { connected: number; needsReconnect: number };
}

function connectableWithKey(entry: IntegrationEntry): boolean {
  if (entry.verificationStatus === "paused") return false;
  return (entry.verificationStatus === "verified" && entry.exercised) || env.CONNECTIONS_ALLOW_UNVERIFIED;
}

export async function integrationsOverview(scope: Scope): Promise<IntegrationOverview[]> {
  const provider = connectionProvider();
  const [secrets, ownApps, endUserRows] = await Promise.all([
    listSecrets(scope.workspaceId, scope.environmentId),
    provider ? listEnvironmentOAuthApps(scope) : Promise.resolve([]),
    db.select({
      integration: oauthConnections.integrationKey,
      connected: count(),
      needsReconnect: sql<number>`count(*) filter (where ${oauthConnections.revokedAt} is not null)`,
    }).from(oauthConnections).where(and(
      eq(oauthConnections.workspaceId, scope.workspaceId),
      eq(oauthConnections.environmentId, scope.environmentId),
      isNotNull(oauthConnections.subjectEndUserId),
      isNull(oauthConnections.pendingConfirmationUntil),
    )).groupBy(oauthConnections.integrationKey),
  ]);

  const workspace = new Map<string, { connected: number; needsAttention: number }>();
  for (const secret of secrets) {
    if (!secret.integrationId) continue;
    const counts = workspace.get(secret.integrationId) ?? { connected: 0, needsAttention: 0 };
    counts.connected += 1;
    if (secret.health && secret.health.status !== "active") counts.needsAttention += 1;
    workspace.set(secret.integrationId, counts);
  }
  const endUsers = new Map(endUserRows.map((row) => [row.integration, { connected: Number(row.connected), needsReconnect: Number(row.needsReconnect) }]));
  const own = new Set(ownApps.filter((app) => app.configured).map((app) => app.integration));
  const redirectUri = consentRedirectUri();

  return CATALOGUE.flatMap((entry): IntegrationOverview[] => {
    const counts = { workspace: workspace.get(entry.id) ?? { connected: 0, needsAttention: 0 }, endUsers: endUsers.get(entry.id) ?? { connected: 0, needsReconnect: 0 } };
    const inUse = counts.workspace.connected + counts.endUsers.connected > 0;
    if (entry.auth.kind === "api_key") {
      const connectable = connectableWithKey(entry);
      return connectable || inUse ? [{ ...integrationView(entry), connectable, signIn: null, ...counts }] : [];
    }
    if (!OAUTH_APPS[entry.id]) return [];
    const app: SignInApp = !provider
      ? "unavailable"
      : own.has(entry.id)
        ? "own"
        : sharedAppOffered(entry) && provider.supports(entry.id)
          ? "anlyon"
          : "own_required";
    const signsIn = app === "own" || app === "anlyon";
    if (keyAuthOf(entry)) {
      const connectable = signsIn || connectableWithKey(entry);
      return connectable || inUse ? [{ ...integrationView(entry, { signIn: signsIn }), connectable, signIn: { app, redirectUri }, ...counts }] : [];
    }
    return [{ ...integrationView(entry), connectable: signsIn, signIn: { app, redirectUri }, ...counts }];
  });
}
