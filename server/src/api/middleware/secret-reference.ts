import type { Context, Next } from "hono";
import { callerAuthority } from "./auth.ts";
import { extractSecretNames } from "../../core/actions/template.ts";
import { endUserIntegrationsFor, loadSecretPolicies } from "../../core/actions/secrets.ts";
import { AuthorizationError } from "../../utils/errors.ts";

export function requireSecretReferenceAuthority(
  pick: (body: unknown) => Array<{ headers?: Record<string, unknown> | null; url?: string }>,
) {
  return async function secretReferenceMiddleware(c: Context, next: Next) {
    const entries = pick(c.get("validatedBody"));
    const names = [...new Set(entries.flatMap((e) => extractSecretNames(e.headers ?? {})))];

    if (names.length === 0) {
      await next();
      return;
    }

    const authority = callerAuthority(c);
    if (authority.scopes !== null && !authority.scopes.includes("secrets:read")) {
      throw new AuthorizationError(
        `Referencing a secret requires the "secrets:read" scope. This request references: ${names.join(", ")}.`,
      );
    }

    await loadSecretPolicies(c.get("workspaceId"), names, c.get("environmentId"));

    if (c.get("endUserRequired") === true) {
      const integrations = await endUserIntegrationsFor(c.get("workspaceId"), names, c.get("environmentId"));
      if (integrations.length > 0) {
        throw new AuthorizationError(
          `This API key acts only for end users, so it cannot send the workspace's connected accounts (${integrations.join(", ")}) in delivery headers.`,
        );
      }
    }

    await next();
  };
}
