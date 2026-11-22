import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { apiKeys } from "../../db/schema/workspaces.ts";
import { keyBudgets } from "../../db/schema/billing.ts";

export async function oauthBudgetKey(userId: string, clientId: string, workspaceId: string, environmentId: string) {
  const principal = createHash("sha256").update(JSON.stringify([userId, clientId, workspaceId, environmentId])).digest("hex");
  return db.transaction(async tx => {
    await tx.insert(apiKeys).values({
      workspaceId, environmentId, budgetPrincipal: principal,
      name: `OAuth application ${clientId}`, keyHash: randomBytes(32).toString("hex"),
      keyPrefix: "oauth", scopes: [], createdBy: userId,
    }).onConflictDoNothing({ target: apiKeys.budgetPrincipal });
    const [key] = await tx.select().from(apiKeys).where(eq(apiKeys.budgetPrincipal, principal));
    await tx.insert(keyBudgets).values({ workspaceId, apiKeyId: key.id, dimensionCaps: {}, enabled: true })
      .onConflictDoNothing({ target: keyBudgets.apiKeyId });
    return key.id;
  });
}
