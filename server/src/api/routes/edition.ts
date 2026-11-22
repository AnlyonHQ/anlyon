import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { requireSession } from "../middleware/auth.ts";
import { db } from "../../db/index.ts";
import { workspaceMembers } from "../../db/schema/workspaces.ts";
import { currentEdition } from "../../core/edition/edition.ts";
import { licenseSummary } from "../../core/edition/features.ts";

const editionRouter = new Hono();

editionRouter.get("/", requireSession, async (c: Context) => {
  const userId = c.get("userId") as string;
  const [adminOf] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.role, "admin")))
    .limit(1);
  return c.json({
    success: true,
    data: {
      edition: currentEdition(),
      license: adminOf ? await licenseSummary() : null,
    },
  });
});

export default editionRouter;
