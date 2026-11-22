import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { environments } from "../../db/schema/environments.ts";
import { AuthorizationError, ValidationError } from "../../utils/errors.ts";

export async function resolveEnvironmentId(c: Context): Promise<string> {
  const bound = c.get("environmentId") as string | undefined;
  if (bound) return bound;

  const authType = c.get("authType") as string | undefined;
  if (authType !== "session") {
    throw new AuthorizationError(
      "This credential is not bound to an environment. Re-issue the API key, or authenticate from the dashboard.",
    );
  }

  const workspaceId = c.get("workspaceId");
  const [row] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.workspaceId, workspaceId), eq(environments.isDefault, true)));
  if (!row) throw new ValidationError("Workspace environment not found");
  return row.id;
}
