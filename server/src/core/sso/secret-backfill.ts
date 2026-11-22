import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { ssoProvider } from "../../db/schema/sso.ts";
import { decryptConfig, encryptConfig, hasPlaintextSecret } from "./secret-fields.ts";

export interface SsoSecretBackfill {
  rows: number;
  plaintext: number;
  rewritten: number;
  skippedConcurrent: number;
}

export async function encryptExistingSsoSecrets(apply: boolean): Promise<SsoSecretBackfill> {
  const rows = await db
    .select({
      providerId: ssoProvider.providerId,
      oidcConfig: ssoProvider.oidcConfig,
      samlConfig: ssoProvider.samlConfig,
    })
    .from(ssoProvider);
  const tally: SsoSecretBackfill = { rows: rows.length, plaintext: 0, rewritten: 0, skippedConcurrent: 0 };

  for (const row of rows) {
    const oidcPlain = hasPlaintextSecret(row.oidcConfig, "oidcConfig");
    const samlPlain = hasPlaintextSecret(row.samlConfig, "samlConfig");
    if (!oidcPlain && !samlPlain) continue;
    tally.plaintext++;
    if (!apply) continue;

    const oidcConfig = encryptConfig(row.oidcConfig, row.providerId, "oidcConfig") as string | null;
    const samlConfig = encryptConfig(row.samlConfig, row.providerId, "samlConfig") as string | null;
    if (
      decryptConfig(oidcConfig, row.providerId, "oidcConfig") !== decryptConfig(row.oidcConfig, row.providerId, "oidcConfig") ||
      decryptConfig(samlConfig, row.providerId, "samlConfig") !== decryptConfig(row.samlConfig, row.providerId, "samlConfig")
    ) {
      throw new Error(`Encrypted SSO configuration for ${row.providerId} did not read back; nothing was written`);
    }

    const same = (column: typeof ssoProvider.oidcConfig | typeof ssoProvider.samlConfig, value: string | null) =>
      value === null ? isNull(column) : eq(column, value);
    const updated = await db
      .update(ssoProvider)
      .set({ oidcConfig, samlConfig })
      .where(
        and(
          eq(ssoProvider.providerId, row.providerId),
          same(ssoProvider.oidcConfig, row.oidcConfig),
          same(ssoProvider.samlConfig, row.samlConfig),
        ),
      )
      .returning({ providerId: ssoProvider.providerId });
    if (updated.length === 1) tally.rewritten++;
    else tally.skippedConcurrent++;
  }
  return tally;
}
