import { Pool } from "pg";

const url = process.env.REPORT_DATABASE_URL;
if (!url) {
  console.error("REPORT_DATABASE_URL is required. This script never falls back to DATABASE_URL.");
  process.exit(2);
}

const SAMPLE = 20;

const checks: Array<{ name: string; why: string; count: string; sample: string }> = [
  {
    name: "approvals decided before they were created",
    why: "decided_at < created_at: the clock-skew signature (decision stamped by an app clock behind the database)",
    count: `SELECT count(*)::int AS n FROM approvals WHERE decided_at IS NOT NULL AND decided_at < created_at`,
    sample: `SELECT approval_id AS id FROM approvals WHERE decided_at IS NOT NULL AND decided_at < created_at ORDER BY created_at DESC LIMIT ${SAMPLE}`,
  },
  {
    name: "votes recorded before their approval existed",
    why: "approval_decisions.decided_at < approvals.created_at",
    count: `SELECT count(*)::int AS n FROM approval_decisions d JOIN approvals a ON a.id = d.approval_id WHERE d.decided_at < a.created_at`,
    sample: `SELECT a.approval_id AS id FROM approval_decisions d JOIN approvals a ON a.id = d.approval_id WHERE d.decided_at < a.created_at ORDER BY a.created_at DESC LIMIT ${SAMPLE}`,
  },
  {
    name: "invocations completed before they were created",
    why: "completed_at < created_at",
    count: `SELECT count(*)::int AS n FROM action_invocations WHERE completed_at IS NOT NULL AND completed_at < created_at`,
    sample: `SELECT invocation_id AS id FROM action_invocations WHERE completed_at IS NOT NULL AND completed_at < created_at ORDER BY created_at DESC LIMIT ${SAMPLE}`,
  },
  {
    name: "approvals created before the invocation they gate",
    why: "approvals.created_at < action_invocations.created_at",
    count: `SELECT count(*)::int AS n FROM action_invocations i JOIN approvals a ON a.approval_id = i.approval_id WHERE a.created_at < i.created_at`,
    sample: `SELECT i.invocation_id AS id FROM action_invocations i JOIN approvals a ON a.approval_id = i.approval_id WHERE a.created_at < i.created_at ORDER BY i.created_at DESC LIMIT ${SAMPLE}`,
  },
  {
    name: "decided approvals with no recorded origin",
    why: "status is not pending but decision_origin is NULL: the backfill did not run or a writer skipped it",
    count: `SELECT count(*)::int AS n FROM approvals WHERE status <> 'pending' AND decision_origin IS NULL`,
    sample: `SELECT approval_id AS id FROM approvals WHERE status <> 'pending' AND decision_origin IS NULL ORDER BY created_at DESC LIMIT ${SAMPLE}`,
  },
];

async function main() {
  const pool = new Pool({ connectionString: url, max: 1, options: "-c default_transaction_read_only=on" });
  try {
    for (const check of checks) {
      const { rows } = await pool.query(check.count);
      const n = rows[0].n as number;
      console.log(`${n === 0 ? "ok  " : "WARN"} ${check.name}: ${n}`);
      if (n > 0) {
        console.log(`       ${check.why}`);
        const ids = (await pool.query(check.sample)).rows.map((r) => r.id);
        console.log(`       newest ${ids.length}: ${ids.join(", ")}`);
      }
    }
    const origins = await pool.query(
      `SELECT coalesce(decision_origin::text, 'pending/null') AS origin, count(*)::int AS n FROM approvals GROUP BY 1 ORDER BY 1`,
    );
    console.log("\napprovals by decision_origin (review before trusting the backfill):");
    for (const row of origins.rows) console.log(`  ${row.origin}: ${row.n}`);
    console.log("\n`unknown` means the evidence did not settle who decided. It is reported as unknown, never guessed.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("report failed:", error instanceof Error ? error.name : "error");
  process.exit(1);
});
