import { pool } from "../db/index.ts";
import { encryptExistingSsoSecrets } from "../core/sso/secret-backfill.ts";

const apply = process.argv.includes("--apply");

encryptExistingSsoSecrets(apply)
  .then(async (tally) => {
    console.log(
      `sso_provider: ${tally.rows} row(s), ${tally.plaintext} with a secret in the clear` +
        (apply ? `, rewritten=${tally.rewritten} skipped(concurrent change)=${tally.skippedConcurrent}` : " (dry run)"),
    );
    await pool.end().catch(() => {});
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await pool.end().catch(() => {});
    process.exit(1);
  });
