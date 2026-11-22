import { DEFAULT_API_KEY_SCOPES, liveApiKeyScopes } from "./api-key-scopes.ts";

interface StoredApiKeyLike {
  id: string;
  workspaceId: string;
  environmentId?: string | null;
  name: string;
  keyPrefix: string;
  version: number;
  isActive: boolean | string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  expiresAt: Date | null;
  scopes?: string[] | null;
  endUserRequired?: boolean | null;
}

export function toPublicApiKey(apiKey: StoredApiKeyLike) {
  return {
    id: apiKey.id,
    workspaceId: apiKey.workspaceId,
    environmentId: apiKey.environmentId ?? null,
    name: apiKey.name,
    keyPrefix: apiKey.keyPrefix,
    version: apiKey.version,
    isActive: apiKey.isActive === true || apiKey.isActive === "true",
    lastUsedAt: apiKey.lastUsedAt,
    createdAt: apiKey.createdAt,
    expiresAt: apiKey.expiresAt,
    scopes: apiKey.scopes ? liveApiKeyScopes(apiKey.scopes) : [...DEFAULT_API_KEY_SCOPES],
    endUserRequired: apiKey.endUserRequired === true,
  };
}
