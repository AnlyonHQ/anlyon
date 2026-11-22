import { env } from "../../config/env.ts";
import { createLogger } from "../../lib/logger.ts";
import { ConnectionsUnavailableError } from "../../utils/errors.ts";
import { createNativeProvider } from "./native.ts";
import { environmentOAuthClient } from "../end-users/oauth-apps.ts";

export * from "./types.ts";
import type { ConnectionProvider } from "./types.ts";

const logger = createLogger({ module: "connections" });

let override: ConnectionProvider | null | undefined;
let configured: ConnectionProvider | null | undefined;
let warned = false;

export function missingConnectionSettings(): string[] {
  const missing: string[] = [];
  if (!env.CONNECTIONS_ENCRYPTION_KEY) missing.push("CONNECTIONS_ENCRYPTION_KEY");
  return missing;
}

export function connectionProvider(): ConnectionProvider | null {
  if (override !== undefined) return override;
  if (configured !== undefined) return configured;
  const missing = missingConnectionSettings();
  if (missing.length > 0) {
    if (!warned) {
      warned = true;
      logger.warn({ missing }, "Signed-in connected accounts are unavailable on this deployment: connector settings are missing");
    }
    configured = null;
    return configured;
  }
  configured = createNativeProvider({
    origin: env.CONNECT_PUBLIC_URL ?? env.BETTER_AUTH_URL,
    pagesOrigin: env.CONNECT_PAGES_URL ?? null,
    encryptionKey: env.CONNECTIONS_ENCRYPTION_KEY!,
    environmentClient: environmentOAuthClient,
    upstreamApp: async (integrationKey, environmentId) => (await import("../mcp-upstreams/oauth.ts")).upstreamApp(integrationKey, environmentId),
  });
  return configured;
}

export function requireConnectionProvider(): ConnectionProvider {
  const provider = connectionProvider();
  if (!provider) throw new ConnectionsUnavailableError();
  return provider;
}

export function setConnectionProviderForTests(provider: ConnectionProvider | null | undefined): void {
  override = provider;
}
