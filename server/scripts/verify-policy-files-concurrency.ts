import pg from "pg";
import { readFileSync } from "node:fs";

const base = (process.env.POLICY_FILES_PG_URL ?? "").replace(/\/+$/, "");
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(base)) {
  throw new Error("POLICY_FILES_PG_URL must be a loopback server URL without a database name, e.g. postgres://u:p@127.0.0.1:5432");
}
const admin = new pg.Client(`${base}/postgres`);
await admin.connect();
await admin.query("DROP DATABASE IF EXISTS policy_files_check WITH (FORCE)");
await admin.query("CREATE DATABASE policy_files_check");
await admin.end();
const url = `${base}/policy_files_check`;
{
  const c = new pg.Client(url);
  await c.connect();
  const journal = JSON.parse(readFileSync(new URL("../src/db/migrations/meta/_journal.json", import.meta.url), "utf8")).entries as { tag: string }[];
  await c.query("BEGIN");
  for (const { tag } of journal) {
    const sql = readFileSync(new URL(`../src/db/migrations/${tag}.sql`, import.meta.url), "utf8")
      .replace(/vector\(\d+\)/g, "real[]").replace(/CREATE INDEX[^;]*USING hnsw[^;]*;/gi, "");
    for (const statement of sql.split("--> statement-breakpoint")) if (statement.trim()) await c.query(statement);
  }
  await c.query("COMMIT");
  await c.query("INSERT INTO workspaces (id, name, slug) VALUES ('00000000-0000-4000-8000-0000000000a1', 'w', 'w')");
  await c.query("INSERT INTO environments (id, workspace_id, name, slug) VALUES ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'prod', 'prod')");
  await c.query(`INSERT INTO actions (workspace_id, environment_id, action_id, name, url_template, input_schema)
    VALUES ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'act_r', 'refund_order', 'https://e.test', '{"type":"object","properties":{"amount":{"type":"number"}}}')`);
  await c.end();
}
process.env.DATABASE_URL = url;
const ws = "00000000-0000-4000-8000-0000000000a1";
const env = "00000000-0000-4000-8000-0000000000b1";
const files = await import("../src/core/approvals/policy-files.ts");
const { createPolicy, updatePolicy, listPolicies } = await import("../src/core/approvals/policy.ts");
const { pool } = await import("../src/db/index.ts");
const operator = { environmentId: env, actor: { type: "api_key" as const, id: "key_ci" } };
const file = (approvals: number) => `apiVersion: anlyon.com/policies/v1
file: payments/refunds
environment: prod
policies:
  big:
    name: Big refunds
    target: { action: refund_order }
    when: input.amount >= 50000
    approvals: ${approvals}
`;
const results: [string, boolean, unknown][] = [];

const plan = await files.planPolicyFile(ws, env, file(2));
const applies = await Promise.allSettled(Array.from({ length: 10 }, () => files.applyPolicyFile(ws, env, file(2), plan.digest, operator)));
const wins = applies.filter((a) => a.status === "fulfilled").length;
const losers = applies.filter((a) => a.status === "rejected").map((a) => (a as PromiseRejectedResult).reason?.code);
results.push(["10 concurrent applies of one plan: exactly one wins, the rest 409 STALE_PLAN", wins === 1 && losers.every((c) => c === "STALE_PLAN"), { wins, losers }]);
results.push(["one policy exists after the race", (await listPolicies(ws, env)).length === 1, (await listPolicies(ws, env)).length]);

const consolePolicy = await createPolicy(ws, { environmentId: env, name: "Console rule", matchKind: "custom", priority: 500 }, operator);
const consoleEdits = 20;
const settled = await Promise.allSettled([
  ...Array.from({ length: consoleEdits }, (_, i) => (async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      try { return await updatePolicy(ws, consolePolicy.id, { priority: 600 + i }, operator); }
      catch (error) { if ((error as { statusCode?: number }).statusCode !== 409) throw error; }
    }
    throw new Error("console edit starved");
  })()),
  ...Array.from({ length: 5 }, async (_, i) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const p = await files.planPolicyFile(ws, env, file(3 + i));
      try { return await files.applyPolicyFile(ws, env, file(3 + i), p.digest, operator); }
      catch (error) { if ((error as { code?: string }).code !== "STALE_PLAN") throw error; }
    }
    throw new Error("apply starved");
  }),
]);
const failures = settled.filter((s) => s.status === "rejected").map((s) => String((s as PromiseRejectedResult).reason));
const { rows: [consoleRow] } = await pool.query("SELECT version FROM approval_policies WHERE policy_id = $1", [consolePolicy.id]);
const { rows: [fileRow] } = await pool.query("SELECT version FROM approval_policies WHERE managed_key = 'big'");
const { rows: history } = await pool.query(
  "SELECT policy_id, count(*)::int AS n, max(version) AS latest FROM approval_policy_versions GROUP BY policy_id",
);
const consoleHistory = history.find((h) => h.policy_id === consolePolicy.id);
results.push(["every console edit and every apply eventually committed", failures.length === 0, failures.slice(0, 3)]);
results.push(["console policy: 1 create + 20 edits = version 21, all in history",
  consoleRow.version === 1 + consoleEdits && consoleHistory?.n === 1 + consoleEdits, { version: consoleRow.version, history: consoleHistory }]);
results.push(["file policy: created once + 5 applied updates = version 6", fileRow.version === 6, fileRow]);

{
  const source = file(9);
  const racePlan = await files.planPolicyFile(ws, env, source);
  const historyBefore = (await pool.query("SELECT count(*)::int AS n FROM approval_policy_versions")).rows[0].n;
  const editor = await pool.connect();
  await editor.query("BEGIN");
  await editor.query(`UPDATE actions SET input_schema = '{"type":"object","properties":{"amount":{"type":"number"},"reason":{"type":"string"}}}'
    WHERE action_id = 'act_r'`);
  let settledEarly = false;
  const apply = files.applyPolicyFile(ws, env, source, racePlan.digest, operator)
    .then((v) => { settledEarly = true; return { ok: true as const, v }; }, (e) => { settledEarly = true; return { ok: false as const, e }; });
  await new Promise((r) => setTimeout(r, 750));
  const waited = !settledEarly;
  await editor.query("COMMIT");
  editor.release();
  const outcome = await apply;
  const historyAfter = (await pool.query("SELECT count(*)::int AS n FROM approval_policy_versions")).rows[0].n;
  results.push(["apply waits for a concurrent action schema edit (row lock held)", waited, { settledEarly }]);
  results.push(["after the edit commits, apply refuses as STALE_PLAN and writes nothing",
    !outcome.ok && (outcome.e as { code?: string }).code === "STALE_PLAN" && historyAfter === historyBefore,
    { outcome: outcome.ok ? "applied" : (outcome.e as { code?: string }).code, historyBefore, historyAfter }]);
}

{
  const tie = `apiVersion: anlyon.com/policies/v1
file: tie/order
environment: prod
policies:
  zeta-approve:
    name: Zeta approve
    target: { customRequests: true }
    effect: auto_approve
    priority: 50
  alpha-deny:
    name: Alpha deny
    target: { customRequests: true }
    effect: auto_deny
    priority: 50
`;
  const predicted = await files.testPolicyFile(ws, env, tie, [
    { name: "custom request", request: { kind: "custom", input: {} }, expect: { policy: null } },
  ]);
  const tiePlan = await files.planPolicyFile(ws, env, tie);
  await files.applyPolicyFile(ws, env, tie, tiePlan.digest, operator);
  const { evaluatePolicies } = await import("../src/core/approvals/policy.ts");
  const live = await evaluatePolicies(env, { kind: "custom", payload: {}, tags: [] });
  const byId = new Map((await listPolicies(ws, env)).map((p) => [p.id, p.managedBy?.key ?? p.id]));
  const liveKey = live.matchedPolicyId ? byId.get(live.matchedPolicyId) : null;
  results.push(["equal-priority new policies: fixture test predicts the live winner",
    predicted.results[0].policy === liveKey && predicted.results[0].effect === live.effect,
    { predicted: [predicted.results[0].policy, predicted.results[0].effect], live: [liveKey, live.effect] }]);
}

await pool.end();
for (const [name, ok, detail] of results) console.log(ok ? "PASS" : "FAIL", name, ok ? "" : JSON.stringify(detail));
console.log(`${results.filter((r) => r[1]).length}/${results.length} passed`);
process.exit(results.every((r) => r[1]) ? 0 : 1);
