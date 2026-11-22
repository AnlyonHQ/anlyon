import { randomBytes } from "node:crypto";
import pg from "pg";

export interface ThrowawayDatabase {
  name: string;
  url: string;
  pool: pg.Pool;
  release(): Promise<void>;
  drop(): Promise<void>;
}

function targetUrl(): URL {
  if (process.env.ANLYON_TEST_TARGETS !== "ok" || !process.env.DATABASE_URL) {
    throw new Error("No designated test database (tests/support/test-target.ts)");
  }
  return new URL(process.env.DATABASE_URL);
}

async function onTarget<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: targetUrl().toString() });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function testServerPrivileges(): Promise<{ createDatabases: boolean; superuser: boolean }> {
  return onTarget(async (client) => {
    const { rows: [role] } = await client.query<{ rolsuper: boolean; rolcreatedb: boolean }>(
      "SELECT rolsuper, rolcreatedb FROM pg_roles WHERE rolname = current_user",
    );
    return { createDatabases: Boolean(role?.rolsuper || role?.rolcreatedb), superuser: Boolean(role?.rolsuper) };
  });
}

export async function createThrowawayDatabase(label: string, options: { template?: string } = {}): Promise<ThrowawayDatabase> {
  const base = decodeURIComponent(targetUrl().pathname.replace(/^\//, ""));
  const name = `${base}_${label}_${randomBytes(4).toString("hex")}`.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 63);
  await onTarget((client) => client.query(`CREATE DATABASE "${name}"${options.template ? ` TEMPLATE "${options.template}"` : ""}`));
  const url = new URL(targetUrl().toString());
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  let dropped = false;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await pool.end().catch(() => {});
  };
  return {
    name,
    url: url.toString(),
    pool,
    release,
    async drop() {
      if (dropped) return;
      dropped = true;
      await release();
      await onTarget((client) => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    },
  };
}
