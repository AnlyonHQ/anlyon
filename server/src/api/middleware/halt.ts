import type { Context, Next } from "hono";
import { isEnvironmentHalted } from "../../core/environments/halt.ts";
import {
  haltBlocks,
  haltBlocksIntakeFrom,
  type EffectClass,
} from "../../core/environments/effects.ts";
import { EnvironmentHaltedError } from "../../utils/errors.ts";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function haltGuard(effect: EffectClass) {
  return async function haltMiddleware(c: Context, next: Next) {
    if (READ_METHODS.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }

    const blocked =
      effect === "intake"
        ? haltBlocksIntakeFrom({
            authType: c.get("authType") as string | undefined,
            scopes: (c.get("apiKeyScopes") as string[] | undefined) ?? null,
          })
        : haltBlocks(effect);

    if (!blocked) {
      await next();
      return;
    }

    if (c.get("authType") === "session") {
      await next();
      return;
    }

    const environmentId = c.get("environmentId") as string | undefined;
    if (!environmentId) {
      await next();
      return;
    }

    if (await isEnvironmentHalted(environmentId)) {
      throw new EnvironmentHaltedError();
    }

    await next();
  };
}
