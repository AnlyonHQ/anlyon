import { pool, db } from "../../db/index.ts";
import { archivalTracking } from "../../db/schema/messages.ts";
import { createLogger } from "../../lib/logger.ts";
import { eq, and, lt, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { env } from "../../config/env.ts";
import { partitionFunctionSql, partitionedLogs, type PartitionedLogSpec } from "./partitioned-logs.ts";

const logger = createLogger({ module: "partition-manager" });

export type LogType = string;

export interface PartitionInfo {
  partitionName: string;
  partitionDate: Date;
  logType: LogType;
}

function specFor(logType: LogType): PartitionedLogSpec {
  const spec = partitionedLogs().find((candidate) => candidate.logType === logType);
  if (!spec) throw new Error(`Unknown partitioned log type: ${logType}`);
  return spec;
}

export async function ensureHelperFunctions(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(partitionedLogs().map((spec) => partitionFunctionSql(spec)).join("\n"));

    logger.info("Ensured self-healing partition helper functions are up-to-date");
  } finally {
    client.release();
  }
}

export async function ensurePartitionsExist(daysAhead: number = 7): Promise<void> {
  await ensureHelperFunctions();

  const client = await pool.connect();
  try {
    for (let i = 0; i < daysAhead; i++) {
      const date = new Date();
      date.setDate(date.getDate() + i);
      const dateStr = formatDateForPartition(date);

      for (const spec of partitionedLogs()) {
        await client.query(`SELECT ${spec.partitionFunction}($1::date)`, [dateStr]);
      }
    }

    logger.info({ daysAhead }, "Ensured partitions exist for upcoming days");
  } finally {
    client.release();
  }
}

export async function getExpiredPartitions(hotDays: number = env.LOG_RETENTION_HOT_DAYS): Promise<PartitionInfo[]> {
  const client = await pool.connect();
  const expiredPartitions: PartitionInfo[] = [];

  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - hotDays);
    cutoffDate.setHours(0, 0, 0, 0);

    for (const spec of partitionedLogs()) {
      const partitions = await client.query<{ partition_name: string; partition_date: Date }>(
        `SELECT partition_name, partition_date
         FROM get_log_partitions($1)
         WHERE partition_date < $2`,
        [spec.table, cutoffDate]
      );

      for (const row of partitions.rows) {
        expiredPartitions.push({
          partitionName: row.partition_name,
          partitionDate: row.partition_date,
          logType: spec.logType,
        });
      }
    }

    logger.debug({ count: expiredPartitions.length, cutoffDate }, "Found expired partitions");
    return expiredPartitions;
  } finally {
    client.release();
  }
}

export async function getAllPartitions(logType: LogType): Promise<PartitionInfo[]> {
  const client = await pool.connect();
  const partitions: PartitionInfo[] = [];

  try {
    const parentTable = specFor(logType).table;
    const result = await client.query<{ partition_name: string; partition_date: Date }>(
      `SELECT partition_name, partition_date FROM get_log_partitions($1)`,
      [parentTable]
    );

    for (const row of result.rows) {
      partitions.push({
        partitionName: row.partition_name,
        partitionDate: row.partition_date,
        logType,
      });
    }

    return partitions;
  } finally {
    client.release();
  }
}

export async function dropPartition(partitionName: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query(`SELECT drop_log_partition($1)`, [partitionName]);
    logger.info({ partitionName }, "Dropped partition");
    return true;
  } catch (error) {
    logger.error({ partitionName, error }, "Failed to drop partition");
    return false;
  } finally {
    client.release();
  }
}

export async function getPartitionRecordCount(partitionName: string): Promise<number> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM ${partitionName}`
    );
    return parseInt(result.rows[0]?.count || "0", 10);
  } catch (error) {
    logger.error({ partitionName, error }, "Failed to get partition record count");
    return 0;
  } finally {
    client.release();
  }
}

export async function getPartitionWorkspaceIds(partitionName: string): Promise<string[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ workspace_id: string }>(
      `SELECT DISTINCT workspace_id FROM ${partitionName} WHERE workspace_id IS NOT NULL`
    );
    return result.rows.map((row) => row.workspace_id);
  } catch (error) {
    logger.error({ partitionName, error }, "Failed to get partition workspace IDs");
    return [];
  } finally {
    client.release();
  }
}

export async function partitionExists(partitionName: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = $1
        AND n.nspname = 'public'
      ) as exists`,
      [partitionName]
    );
    return result.rows[0]?.exists ?? false;
  } finally {
    client.release();
  }
}

export async function createArchivalTrackingEntry(
  partitionInfo: PartitionInfo,
  totalRecords: number
): Promise<void> {
  await db
    .insert(archivalTracking)
    .values({
      partitionName: partitionInfo.partitionName,
      logType: partitionInfo.logType,
      partitionDate: partitionInfo.partitionDate,
      totalRecords,
      status: "pending",
    })
    .onConflictDoNothing();
}

export async function updateArchivalTrackingStatus(
  partitionName: string,
  logType: LogType,
  status: string,
  additionalData?: {
    archivedRecords?: number;
    r2ManifestKeys?: string[];
    archivalStartedAt?: Date;
    archivalCompletedAt?: Date;
    partitionDroppedAt?: Date;
    lastError?: string;
    retryCount?: number;
  }
): Promise<void> {
  const updateData: Record<string, unknown> = { status };

  if (additionalData?.archivedRecords !== undefined) {
    updateData.archivedRecords = additionalData.archivedRecords;
  }
  if (additionalData?.r2ManifestKeys !== undefined) {
    updateData.r2ManifestKeys = additionalData.r2ManifestKeys;
  }
  if (additionalData?.archivalStartedAt !== undefined) {
    updateData.archivalStartedAt = additionalData.archivalStartedAt;
  }
  if (additionalData?.archivalCompletedAt !== undefined) {
    updateData.archivalCompletedAt = additionalData.archivalCompletedAt;
  }
  if (additionalData?.partitionDroppedAt !== undefined) {
    updateData.partitionDroppedAt = additionalData.partitionDroppedAt;
  }
  if (additionalData?.lastError !== undefined) {
    updateData.lastError = additionalData.lastError;
  }
  if (additionalData?.retryCount !== undefined) {
    updateData.retryCount = additionalData.retryCount;
  }

  await db
    .update(archivalTracking)
    .set(updateData)
    .where(
      and(
        eq(archivalTracking.partitionName, partitionName),
        eq(archivalTracking.logType, logType)
      )
    );
}

export async function getArchivalTrackingEntry(
  partitionName: string,
  logType: LogType
) {
  const results = await db
    .select()
    .from(archivalTracking)
    .where(
      and(
        eq(archivalTracking.partitionName, partitionName),
        eq(archivalTracking.logType, logType)
      )
    )
    .limit(1);

  return results[0] || null;
}

export async function getPartitionsReadyForDrop(): Promise<
  Array<{ partitionName: string; logType: LogType; partitionDate: Date }>
> {
  const results = await db
    .select({
      partitionName: archivalTracking.partitionName,
      logType: archivalTracking.logType,
      partitionDate: archivalTracking.partitionDate,
    })
    .from(archivalTracking)
    .where(eq(archivalTracking.status, "archived"));

  return results.map((r) => ({
    partitionName: r.partitionName,
    logType: r.logType as LogType,
    partitionDate: r.partitionDate,
  }));
}

function formatDateForPartition(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function extractDateFromPartitionName(partitionName: string): Date | null {
  const match = partitionName.match(/(\d{8})$/);
  if (!match) return null;

  const dateStr = match[1];
  const year = parseInt(dateStr.substring(0, 4), 10);
  const month = parseInt(dateStr.substring(4, 6), 10) - 1;
  const day = parseInt(dateStr.substring(6, 8), 10);

  return new Date(year, month, day);
}
