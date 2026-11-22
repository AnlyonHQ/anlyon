import { APIError } from "better-auth/api";
import { ALL_OAUTH_SCOPES } from "./oauth-scopes.ts";

export const SCOPE_BEARING_PATHS = ["/oauth2/authorize", "/oauth2/consent", "/oauth2/token", "/oauth2/register"] as const;

const ISSUED = new Set<string>(ALL_OAUTH_SCOPES);

export function unknownScopesIn(scope: unknown): string[] {
  if (typeof scope !== "string") return [];
  return [...new Set(scope.split(/\s+/).filter((name) => name.length > 0 && !ISSUED.has(name)))];
}

export function unknownScopeDescription(unknown: readonly string[]): string {
  const list = unknown.map((name) => `"${name}"`).join(", ");
  return unknown.length === 1
    ? `${list} is not a scope Anlyon issues. Remove it from the scope parameter.`
    : `${list} are not scopes Anlyon issues. Remove them from the scope parameter.`;
}

interface ScopeRequest {
  path?: string;
  query?: unknown;
  body?: unknown;
}

const scopeOf = (source: unknown): unknown =>
  source && typeof source === "object" && !Array.isArray(source) ? (source as { scope?: unknown }).scope : undefined;

const refusedAtRegistration = (name: string): boolean => name.startsWith("anlyon:");

const isScopeBearing = (path: string | undefined): boolean =>
  path !== undefined && (SCOPE_BEARING_PATHS as readonly string[]).includes(path);

const RETIRED = new Set<string>();

export function retireOAuthScopes(scopes: readonly string[]): void {
  for (const scope of scopes) if (!ISSUED.has(scope)) RETIRED.add(scope);
}

export function resetRetiredOAuthScopes(): void {
  RETIRED.clear();
}

export function withoutRetiredScopes(scope: unknown): string | undefined {
  if (typeof scope !== "string" || RETIRED.size === 0) return undefined;
  const names = scope.split(/\s+/).filter((name) => name.length > 0);
  const kept = names.filter((name) => !RETIRED.has(name));
  if (kept.length === names.length || kept.length === 0) return undefined;
  return kept.join(" ");
}

const withScope = (source: unknown, scope: string): Record<string, unknown> => ({ ...(source as Record<string, unknown>), scope });

export function screenOAuthScopes(ctx: ScopeRequest): { query?: Record<string, unknown>; body?: Record<string, unknown> } | undefined {
  if (!isScopeBearing(ctx.path)) return undefined;
  const rewrite: { query?: Record<string, unknown>; body?: Record<string, unknown> } = {};
  if (ctx.path !== "/oauth2/register") {
    const fromQuery = withoutRetiredScopes(scopeOf(ctx.query));
    const fromBody = withoutRetiredScopes(scopeOf(ctx.body));
    if (fromQuery !== undefined) rewrite.query = withScope(ctx.query, fromQuery);
    if (fromBody !== undefined) rewrite.body = withScope(ctx.body, fromBody);
  }
  refuseUnknownOAuthScopes({ path: ctx.path, query: rewrite.query ?? ctx.query, body: rewrite.body ?? ctx.body });
  return rewrite.query || rewrite.body ? rewrite : undefined;
}

export function refuseUnknownOAuthScopes(ctx: ScopeRequest): void {
  if (!isScopeBearing(ctx.path)) return;
  let unknown = [...new Set([...unknownScopesIn(scopeOf(ctx.query)), ...unknownScopesIn(scopeOf(ctx.body))])];
  if (ctx.path === "/oauth2/register") unknown = unknown.filter(refusedAtRegistration);
  if (unknown.length === 0) return;
  throw new APIError("BAD_REQUEST", {
    error: ctx.path === "/oauth2/register" ? "invalid_client_metadata" : "invalid_scope",
    error_description: unknownScopeDescription(unknown),
  });
}
