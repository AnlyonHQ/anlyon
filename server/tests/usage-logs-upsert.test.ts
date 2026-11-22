import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { usageLogs } from "../src/db/schema/billing.ts";
import { migratedDatabase } from "./support/pglite-schema.ts";

const ws = "00000000-0000-4000-8000-0000000000e1";
let client: Awaited<ReturnType<typeof migratedDatabase>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await migratedDatabase();
  db = drizzle(client);
  await client.query("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'ws', 'ws-usage')", [ws]);
}, 120_000);

const upsert = (actionInvokes: number) =>
  db
    .insert(usageLogs)
    .values({ workspaceId: ws, date: "2026-09-28", actionInvokes })
    .onConflictDoUpdate({
      target: [usageLogs.workspaceId, usageLogs.date],
      set: { actionInvokes, updatedAt: new Date() },
    });

describe("usage_logs daily upsert", () => {
  it("inserts once and then updates the same row for the day", async () => {
    await upsert(70);
    await upsert(81);
    const { rows } = await client.query<{ action_invokes: string }>(
      "SELECT action_invokes FROM usage_logs WHERE workspace_id = $1 AND date = '2026-09-28'",
      [ws],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.action_invokes)).toBe(81);
  });

  it("refuses a second row for the same workspace and day", async () => {
    await expect(
      client.query("INSERT INTO usage_logs (workspace_id, date) VALUES ($1, '2026-09-28')", [ws]),
    ).rejects.toThrow(/usage_logs_workspace_date_unique/);
  });
});
