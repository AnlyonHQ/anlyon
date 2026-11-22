import type { Context, Next } from "hono";
import { isApiKeyScope } from "../core/auth/api-key-scopes.ts";
import { ApiError } from "../utils/errors.ts";

export async function refuseUnknownApiKeyScopes(c: Context, next: Next): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    body = undefined;
  }
  const scopes = body && typeof body === "object" && !Array.isArray(body) ? (body as { scopes?: unknown }).scopes : undefined;
  const invalid = Array.isArray(scopes)
    ? [...new Set(scopes.filter((scope): scope is string => typeof scope === "string" && !isApiKeyScope(scope)))]
    : [];
  if (invalid.length > 0) {
    const list = invalid.map((scope) => `"${scope}"`).join(", ");
    throw new ApiError(
      400,
      "INVALID_SCOPE",
      invalid.length === 1
        ? `${list} is not a scope Anlyon grants. Remove it from "scopes".`
        : `${list} are not scopes Anlyon grants. Remove them from "scopes".`,
      { invalidScopes: invalid },
    );
  }
  await next();
}
