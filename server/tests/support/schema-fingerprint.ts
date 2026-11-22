import type { Pool } from "pg";

export interface SchemaFingerprint {
  lines: string[];
  columnOrder: Record<string, string[]>;
}

const NOT_FROM_EXTENSION = (oid: string, catalog: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${catalog}'::regclass AND d.objid = ${oid} AND d.deptype = 'e')`;

export async function schemaFingerprint(pool: Pool): Promise<SchemaFingerprint> {
  const lines: string[] = [];
  const add = (rows: Record<string, unknown>[], kind: string) => {
    for (const row of rows) lines.push(`${kind}|${Object.values(row).map((v) => (v === null ? "∅" : String(v))).join("|")}`);
  };
  const q = async (text: string) => (await pool.query(text)).rows as Record<string, unknown>[];

  add(await q(`
    SELECT c.relname, c.relkind, c.relpersistence, coalesce(pg_get_partkeydef(c.oid), '') AS partkey
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
      AND ${NOT_FROM_EXTENSION("c.oid", "pg_class")}`), "relation");

  const columns = await q(`
    SELECT c.relname, a.attname, a.attnum, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
           pg_get_expr(ad.adbin, ad.adrelid) AS default_expr, a.attidentity, a.attgenerated,
           coalesce(col.collname, '') AS collation
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    LEFT JOIN pg_collation col ON col.oid = a.attcollation AND a.attcollation <> 0 AND col.collname <> 'default'
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
      AND a.attnum > 0 AND NOT a.attisdropped AND ${NOT_FROM_EXTENSION("c.oid", "pg_class")}
    ORDER BY c.relname, a.attnum`);
  const columnOrder: Record<string, string[]> = {};
  for (const column of columns) {
    (columnOrder[String(column.relname)] ??= []).push(String(column.attname));
    const { attnum: _position, ...rest } = column;
    add([rest], "column");
  }

  add(await q(`
    SELECT cl.relname, co.conname, co.contype, pg_get_constraintdef(co.oid) AS def, co.condeferrable, co.condeferred, co.convalidated
    FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_namespace n ON n.oid = co.connamespace
    WHERE n.nspname = 'public' AND NOT cl.relispartition`), "constraint");

  add(await q(`
    SELECT ic.relname AS index, pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class tc ON tc.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = ic.relnamespace
    WHERE n.nspname = 'public' AND NOT tc.relispartition AND ${NOT_FROM_EXTENSION("tc.oid", "pg_class")}`), "index");

  add(await q(`
    SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid) AS def, t.tgenabled
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal AND NOT c.relispartition`), "trigger");

  add(await q(`
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND ${NOT_FROM_EXTENSION("p.oid", "pg_proc")}`), "function");

  add(await q(`
    SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' GROUP BY t.typname`), "enum");

  add(await q(`
    SELECT t.typname, t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype IN ('d', 'c') AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c')
      AND ${NOT_FROM_EXTENSION("t.oid", "pg_type")}`), "type");

  add(await q(`
    SELECT sequencename, data_type, start_value, min_value, max_value, increment_by, cycle, cache_size
    FROM pg_sequences WHERE schemaname = 'public'`), "sequence");

  add(await q(`SELECT extname FROM pg_extension WHERE extname <> 'plpgsql'`), "extension");

  return { lines: lines.sort(), columnOrder };
}

export function fingerprintDiff(a: SchemaFingerprint, b: SchemaFingerprint): { onlyInA: string[]; onlyInB: string[] } {
  const inB = new Set(b.lines);
  const inA = new Set(a.lines);
  return { onlyInA: a.lines.filter((line) => !inB.has(line)), onlyInB: b.lines.filter((line) => !inA.has(line)) };
}

export function columnOrderDiff(a: SchemaFingerprint, b: SchemaFingerprint): Record<string, [string[], string[]]> {
  const out: Record<string, [string[], string[]]> = {};
  for (const [table, order] of Object.entries(a.columnOrder)) {
    const other = b.columnOrder[table];
    if (other && other.join(",") !== order.join(",")) out[table] = [order, other];
  }
  return out;
}

export function fingerprintTables(fingerprint: SchemaFingerprint): string[] {
  return fingerprint.lines.filter((line) => line.startsWith("relation|")).map((line) => line.split("|")[1]!).sort();
}
