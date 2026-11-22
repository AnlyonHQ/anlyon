import { isNotNull, isNull, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const ACTING_FOR = ["workspace", "end_users"] as const;
export type ActingFor = (typeof ACTING_FOR)[number];

export function actingForCondition(endUserColumn: AnyPgColumn, actingFor: ActingFor | undefined): SQL | undefined {
  if (actingFor === "workspace") return isNull(endUserColumn);
  if (actingFor === "end_users") return isNotNull(endUserColumn);
  return undefined;
}
