import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { user } from "../../db/schema/user.ts";

export interface PlatformPerson {
  id: string;
  name: string;
  email: string;
}

export async function findPersonByEmail(email: string): Promise<PlatformPerson | null> {
  const [row] = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(eq(sql`lower(${user.email})`, email.toLowerCase()))
    .limit(1);
  return row ?? null;
}

export async function findPeople(ids: string[]): Promise<Map<string, PlatformPerson>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

export async function createPerson(input: { email: string; name: string; emailVerified: boolean }): Promise<PlatformPerson> {
  const { auth } = await import("../../utils/auth.ts");
  const context = await auth.$context;
  const created = await context.internalAdapter.createUser(
    {
      email: input.email.toLowerCase(),
      name: input.name,
      emailVerified: input.emailVerified,
    },
    { method: "scim" },
  );
  return { id: created.id, name: created.name, email: created.email };
}
