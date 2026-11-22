import type { Pool } from "pg";

export async function resetMessageUsage(pool: Pool, workspaceId: string, month: string, messages = 0) {
  await pool.query("DELETE FROM message_quota_reservations WHERE workspace_id = $1", [workspaceId]);
  await pool.query(`INSERT INTO workspace_usage_periods (workspace_id, month, messages_billed)
    VALUES ($1, $2, $3) ON CONFLICT (workspace_id, month) DO UPDATE
    SET messages_billed = $3, messages_reserved = 0, bandwidth_billed = 0, bandwidth_reserved = 0`,
  [workspaceId, month, messages]);
}

export async function messageUsage(pool: Pool, workspaceId: string, month: string) {
  const { rows } = await pool.query(`SELECT
    (messages_billed + messages_reserved)::float8 AS messages,
    (bandwidth_billed + bandwidth_reserved)::float8 AS bandwidth
    FROM workspace_usage_periods WHERE workspace_id = $1 AND month = $2`, [workspaceId, month]);
  return rows[0] ?? { messages: 0, bandwidth: 0 };
}
