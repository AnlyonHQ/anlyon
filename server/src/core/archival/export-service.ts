import { pool } from "../../db/index.ts";
import { createLogger } from "../../lib/logger.ts";
import { gzipSync } from "zlib";
import type { LogType } from "./partition-manager.ts";
import {
  buildLogObjectKey,
  uploadLogFile,
  uploadManifest,
  manifestExists,
  type ArchivalManifest,
  type ManifestFile,
} from "./r2-storage.ts";

const logger = createLogger({ module: "export-service" });

const BATCH_SIZE = 10000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export interface ExportResult {
  success: boolean;
  workspaceId: string;
  logType: LogType;
  date: Date;
  totalRecords: number;
  filesUploaded: number;
  manifestKey?: string;
  error?: string;
}

interface LogRecord {
  id: string;
  [key: string]: unknown;
}

export async function exportPartitionForWorkspace(
  partitionName: string,
  workspaceId: string,
  logType: LogType,
  partitionDate: Date
): Promise<ExportResult> {
  const result: ExportResult = {
    success: false,
    workspaceId,
    logType,
    date: partitionDate,
    totalRecords: 0,
    filesUploaded: 0,
  };

  try {
    const alreadyArchived = await manifestExists(workspaceId, logType, partitionDate);
    if (alreadyArchived) {
      logger.info(
        { workspaceId, logType, partitionDate },
        "Workspace already archived for this date, skipping"
      );
      result.success = true;
      return result;
    }

    const totalCount = await getWorkspaceRecordCount(partitionName, workspaceId);
    if (totalCount === 0) {
      logger.debug(
        { workspaceId, partitionName },
        "No records for workspace in partition"
      );
      result.success = true;
      return result;
    }

    result.totalRecords = totalCount;
    logger.info(
      { workspaceId, partitionName, totalRecords: totalCount },
      "Starting export for workspace"
    );

    const files: ManifestFile[] = [];
    let offset = 0;
    let batchNumber = 1;

    while (offset < totalCount) {
      const records = await fetchRecordsBatch(partitionName, workspaceId, offset, BATCH_SIZE);

      if (records.length === 0) break;

      const jsonlContent = records.map((r) => JSON.stringify(r)).join("\n");
      const compressed = gzipSync(Buffer.from(jsonlContent, "utf-8"));

      const objectKey = buildLogObjectKey(workspaceId, logType, partitionDate, batchNumber);
      const uploaded = await uploadWithRetry(objectKey, compressed);

      if (!uploaded) {
        throw new Error(`Failed to upload batch ${batchNumber} after ${MAX_RETRIES} retries`);
      }

      files.push({
        name: objectKey.split("/").pop()!,
        records: records.length,
        size: compressed.length,
      });

      result.filesUploaded++;
      offset += records.length;
      batchNumber++;

      logger.debug(
        { workspaceId, batch: batchNumber - 1, records: records.length, offset },
        "Batch exported"
      );
    }

    const manifest: ArchivalManifest = {
      workspace_id: workspaceId,
      log_type: logType,
      date: formatDateISO(partitionDate),
      archived_at: new Date().toISOString(),
      total_records: result.totalRecords,
      files,
    };

    result.manifestKey = await uploadManifest(workspaceId, logType, partitionDate, manifest);
    result.success = true;

    logger.info(
      { workspaceId, logType, partitionDate, totalRecords: result.totalRecords, files: files.length },
      "Export completed for workspace"
    );

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.error = errorMessage;
    logger.error(
      { workspaceId, partitionName, error: errorMessage },
      "Failed to export partition for workspace"
    );
    return result;
  }
}

async function getWorkspaceRecordCount(
  partitionName: string,
  workspaceId: string
): Promise<number> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM ${partitionName} WHERE workspace_id = $1`,
      [workspaceId]
    );
    return parseInt(result.rows[0]?.count || "0", 10);
  } finally {
    client.release();
  }
}

async function fetchRecordsBatch(
  partitionName: string,
  workspaceId: string,
  offset: number,
  limit: number
): Promise<LogRecord[]> {
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '60000'");

    const result = await client.query<LogRecord>(
      `SELECT * FROM ${partitionName}
       WHERE workspace_id = $1
       ORDER BY id
       OFFSET $2 LIMIT $3`,
      [workspaceId, offset, limit]
    );

    return result.rows;
  } finally {
    client.release();
  }
}

async function uploadWithRetry(key: string, data: Buffer): Promise<boolean> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await uploadLogFile(key, data, data.length);
      return true;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.warn(
        { key, attempt, maxRetries: MAX_RETRIES, error: lastError.message },
        "Upload attempt failed"
      );

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }
  }

  logger.error({ key, error: lastError?.message }, "Upload failed after all retries");
  return false;
}

export async function exportPartition(
  partitionName: string,
  logType: LogType,
  partitionDate: Date,
  workspaceIds: string[]
): Promise<{
  totalExported: number;
  failedWorkspaces: string[];
  manifestKeys: string[];
}> {
  const result = {
    totalExported: 0,
    failedWorkspaces: [] as string[],
    manifestKeys: [] as string[],
  };

  for (const workspaceId of workspaceIds) {
    const exportResult = await exportPartitionForWorkspace(
      partitionName,
      workspaceId,
      logType,
      partitionDate
    );

    if (exportResult.success) {
      result.totalExported += exportResult.totalRecords;
      if (exportResult.manifestKey) {
        result.manifestKeys.push(exportResult.manifestKey);
      }
    } else {
      result.failedWorkspaces.push(workspaceId);
    }
  }

  return result;
}

export async function resumeExportForWorkspace(
  partitionName: string,
  workspaceId: string,
  logType: LogType,
  partitionDate: Date,
  startOffset: number
): Promise<ExportResult> {
  const result: ExportResult = {
    success: false,
    workspaceId,
    logType,
    date: partitionDate,
    totalRecords: 0,
    filesUploaded: 0,
  };

  try {
    const totalCount = await getWorkspaceRecordCount(partitionName, workspaceId);
    if (totalCount === 0) {
      result.success = true;
      return result;
    }

    result.totalRecords = totalCount;
    logger.info(
      { workspaceId, partitionName, totalRecords: totalCount, startOffset },
      "Resuming export for workspace"
    );

    const files: ManifestFile[] = [];
    let offset = startOffset;
    let batchNumber = Math.floor(startOffset / BATCH_SIZE) + 1;

    while (offset < totalCount) {
      const records = await fetchRecordsBatch(partitionName, workspaceId, offset, BATCH_SIZE);

      if (records.length === 0) break;

      const jsonlContent = records.map((r) => JSON.stringify(r)).join("\n");
      const compressed = gzipSync(Buffer.from(jsonlContent, "utf-8"));

      const objectKey = buildLogObjectKey(workspaceId, logType, partitionDate, batchNumber);
      const uploaded = await uploadWithRetry(objectKey, compressed);

      if (!uploaded) {
        throw new Error(`Failed to upload batch ${batchNumber} after ${MAX_RETRIES} retries`);
      }

      files.push({
        name: objectKey.split("/").pop()!,
        records: records.length,
        size: compressed.length,
      });

      result.filesUploaded++;
      offset += records.length;
      batchNumber++;
    }

    const manifest: ArchivalManifest = {
      workspace_id: workspaceId,
      log_type: logType,
      date: formatDateISO(partitionDate),
      archived_at: new Date().toISOString(),
      total_records: result.totalRecords,
      files,
    };

    result.manifestKey = await uploadManifest(workspaceId, logType, partitionDate, manifest);
    result.success = true;

    logger.info(
      { workspaceId, logType, partitionDate, totalRecords: result.totalRecords, files: files.length },
      "Resume export completed for workspace"
    );

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.error = errorMessage;
    logger.error(
      { workspaceId, partitionName, error: errorMessage },
      "Failed to resume export for workspace"
    );
    return result;
  }
}

function formatDateISO(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
