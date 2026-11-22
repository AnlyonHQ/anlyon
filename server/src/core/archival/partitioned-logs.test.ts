import { afterEach, describe, expect, it } from "vitest";
import {
  MESSAGE_EXECUTION_LOGS, addPartitionedLog, createPartitionedTableSql, partitionFunctionSql, partitionedLogs, resetPartitionedLogs,
  type PartitionedLogSpec,
} from "./partitioned-logs.ts";

afterEach(() => resetPartitionedLogs());

const other: PartitionedLogSpec = {
  logType: "other_event", table: "other_event_logs", partitionColumn: "at", partitionFunction: "create_other_log_partition",
  columns: ["id uuid NOT NULL", "at timestamp NOT NULL"], primaryKey: ["id", "at"], indexes: [{ name: "idx_other_at", columns: ["at"] }],
};

describe("partitioned logs", () => {
  it("are core's message log, then what extensions add, until reset", () => {
    expect(partitionedLogs()).toEqual([MESSAGE_EXECUTION_LOGS]);
    addPartitionedLog(other);
    expect(partitionedLogs().map((spec) => spec.table)).toEqual(["message_execution_logs", "other_event_logs"]);
    resetPartitionedLogs();
    expect(partitionedLogs()).toEqual([MESSAGE_EXECUTION_LOGS]);
  });

  it("refuse a second description of the same table, type or function, and names that are not plain identifiers", () => {
    expect(() => addPartitionedLog({ ...other, table: "message_execution_logs" })).toThrow(/already registered/);
    expect(() => addPartitionedLog({ ...other, logType: "message_execution" })).toThrow(/already registered/);
    expect(() => addPartitionedLog({ ...other, table: "x; DROP TABLE y" })).toThrow(/not a plain identifier/);
    expect(() => addPartitionedLog({ ...other, primaryKey: ["id"] })).toThrow(/must include at/);
    expect(() => addPartitionedLog({ ...other, columns: ["id uuid; --"] })).toThrow(/not plain SQL/);
  });

  it("render the table, its default partition, its indexes and its self-healing function", () => {
    expect(createPartitionedTableSql(other)).toBe([
      "CREATE TABLE other_event_logs (\n  id uuid NOT NULL,\n  at timestamp NOT NULL,\n  PRIMARY KEY (id, at)\n) PARTITION BY RANGE (at);",
      "CREATE TABLE other_event_logs_default PARTITION OF other_event_logs DEFAULT;",
      "CREATE INDEX idx_other_at ON other_event_logs (at);",
    ].join("\n"));
    const fn = partitionFunctionSql(other, "other_event_logs_partitioned");
    expect(fn).toContain("CREATE OR REPLACE FUNCTION create_other_log_partition(partition_date DATE)");
    expect(fn).toContain("partition_name := 'other_event_logs_' || TO_CHAR(partition_date, 'YYYYMMDD');");
    expect(fn).toContain("ALTER TABLE other_event_logs_partitioned DETACH PARTITION other_event_logs_default;");
    expect(fn).toContain("WHERE at >= start_date AND at < end_date;");
  });
});
