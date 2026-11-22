import { sql } from "drizzle-orm";

export const dbUtcNow = () => sql`(clock_timestamp() at time zone 'utc')`;

export async function readDbNow(executor: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }): Promise<Date> {
  const result = (await executor.execute(sql`select clock_timestamp() as now`)) as { rows: Array<{ now: Date | string }> };
  const value = result.rows[0].now;
  return value instanceof Date ? value : new Date(value);
}
