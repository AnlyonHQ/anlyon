export interface PartitionedLogSpec {
  logType: string;
  table: string;
  partitionColumn: string;
  partitionFunction: string;
  columns: string[];
  primaryKey: string[];
  indexes: { name: string; columns: string[] }[];
}

export const MESSAGE_EXECUTION_LOGS: PartitionedLogSpec = {
  logType: "message_execution",
  table: "message_execution_logs",
  partitionColumn: "timestamp",
  partitionFunction: "create_message_log_partition",
  columns: [
    "id uuid DEFAULT gen_random_uuid() NOT NULL",
    "message_id text NOT NULL",
    "workspace_id uuid",
    "attempt_number integer NOT NULL",
    "status text NOT NULL",
    "request_url text",
    "request_method text",
    "request_headers jsonb",
    "request_body jsonb",
    "response_status integer",
    "response_headers jsonb",
    "response_body text",
    "error_message text",
    "error_code text",
    "duration integer",
    "timestamp timestamp NOT NULL",
    "created_at timestamp DEFAULT now() NOT NULL",
  ],
  primaryKey: ["id", "timestamp"],
  indexes: [
    { name: "idx_mel_part_message_id", columns: ["message_id"] },
    { name: "idx_mel_part_workspace_id", columns: ["workspace_id"] },
    { name: "idx_mel_part_timestamp", columns: ["timestamp"] },
  ],
};

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function assertPartitionedLogSpec(spec: PartitionedLogSpec): void {
  const names = [spec.logType, spec.table, spec.partitionColumn, spec.partitionFunction, ...spec.primaryKey,
    ...spec.indexes.flatMap((index) => [index.name, ...index.columns])];
  const bad = names.find((name) => !IDENTIFIER.test(name));
  if (bad !== undefined) throw new Error(`Partitioned log ${spec.table}: "${bad}" is not a plain identifier`);
  if (!spec.primaryKey.includes(spec.partitionColumn)) {
    throw new Error(`Partitioned log ${spec.table}: the primary key must include ${spec.partitionColumn}`);
  }
  if (spec.columns.some((column) => /;|--|\/\*/.test(column))) throw new Error(`Partitioned log ${spec.table}: a column definition is not plain SQL`);
}

const registered: PartitionedLogSpec[] = [];

export function addPartitionedLog(spec: PartitionedLogSpec): void {
  assertPartitionedLogSpec(spec);
  const all = partitionedLogs();
  if (all.some((known) => known.table === spec.table || known.logType === spec.logType || known.partitionFunction === spec.partitionFunction)) {
    throw new Error(`Partitioned log ${spec.table} (${spec.logType}) is already registered`);
  }
  registered.push(spec);
}

export function partitionedLogs(): PartitionedLogSpec[] {
  return [MESSAGE_EXECUTION_LOGS, ...registered];
}

export function resetPartitionedLogs(): void {
  registered.length = 0;
}

export function createPartitionedTableSql(spec: PartitionedLogSpec, parent: string = spec.table): string {
  return [
    `CREATE TABLE ${parent} (\n  ${[...spec.columns, `PRIMARY KEY (${spec.primaryKey.join(", ")})`].join(",\n  ")}\n) PARTITION BY RANGE (${spec.partitionColumn});`,
    `CREATE TABLE ${spec.table}_default PARTITION OF ${parent} DEFAULT;`,
    ...spec.indexes.map((index) => `CREATE INDEX ${index.name} ON ${parent} (${index.columns.join(", ")});`),
  ].join("\n");
}

export function partitionFunctionSql(spec: PartitionedLogSpec, parent: string = spec.table): string {
  const t = spec.table;
  const c = spec.partitionColumn;
  return `
      -- Self-healing partition creation for ${t}
      CREATE OR REPLACE FUNCTION ${spec.partitionFunction}(partition_date DATE)
      RETURNS VOID AS $$
      DECLARE
        partition_name TEXT;
        start_date DATE;
        end_date DATE;
        moved_count INTEGER;
      BEGIN
        partition_name := '${t}_' || TO_CHAR(partition_date, 'YYYYMMDD');
        start_date := partition_date;
        end_date := partition_date + INTERVAL '1 day';

        -- Skip if partition already exists
        IF EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = partition_name AND n.nspname = 'public'
        ) THEN
          RETURN;
        END IF;

        -- Try creating partition directly first
        BEGIN
          EXECUTE format(
            'CREATE TABLE %I PARTITION OF ${parent}
             FOR VALUES FROM (%L) TO (%L)',
            partition_name, start_date, end_date
          );
          RETURN;
        EXCEPTION WHEN check_violation THEN
          -- Default partition has conflicting data  self-heal
          RAISE NOTICE 'Default partition has data for %, recovering...', partition_date;
        END;

        -- Detach default, create partition, move data, re-attach
        ALTER TABLE ${parent} DETACH PARTITION ${t}_default;

        EXECUTE format(
          'CREATE TABLE %I PARTITION OF ${parent}
           FOR VALUES FROM (%L) TO (%L)',
          partition_name, start_date, end_date
        );

        -- Move rows from default into the parent (routes to correct partition)
        INSERT INTO ${parent}
        SELECT * FROM ${t}_default
        WHERE ${c} >= start_date AND ${c} < end_date;

        GET DIAGNOSTICS moved_count = ROW_COUNT;

        -- Delete moved rows from default
        DELETE FROM ${t}_default
        WHERE ${c} >= start_date AND ${c} < end_date;

        -- Re-attach default
        ALTER TABLE ${parent} ATTACH PARTITION ${t}_default DEFAULT;

        RAISE NOTICE 'Recovered partition %: moved % rows from default', partition_name, moved_count;
      END;
      $$ LANGUAGE plpgsql;
`;
}

export const SHARED_PARTITION_FUNCTIONS_SQL = `
    -- Function to drop a partition by name
    CREATE OR REPLACE FUNCTION drop_log_partition(partition_name TEXT)
    RETURNS VOID AS $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = partition_name AND n.nspname = 'public'
      ) THEN
        EXECUTE format('DROP TABLE %I', partition_name);
        RAISE NOTICE 'Dropped partition: %', partition_name;
      ELSE
        RAISE NOTICE 'Partition does not exist: %', partition_name;
      END IF;
    END;
    $$ LANGUAGE plpgsql;

    -- Function to get list of partitions for a table
    CREATE OR REPLACE FUNCTION get_log_partitions(parent_table TEXT)
    RETURNS TABLE(partition_name TEXT, partition_date DATE) AS $$
    BEGIN
      RETURN QUERY
      SELECT
        c.relname::TEXT as partition_name,
        TO_DATE(SUBSTRING(c.relname FROM '[0-9]{8}$'), 'YYYYMMDD') as partition_date
      FROM pg_class c
      JOIN pg_inherits i ON c.oid = i.inhrelid
      JOIN pg_class p ON i.inhparent = p.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE p.relname = parent_table
      AND n.nspname = 'public'
      AND c.relname ~ '_[0-9]{8}$'
      ORDER BY partition_date;
    END;
    $$ LANGUAGE plpgsql;
`;
