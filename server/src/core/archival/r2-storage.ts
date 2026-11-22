import {
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { storageClient, storageBucket, isR2Configured } from "../../lib/r2-client.ts";
import { createLogger } from "../../lib/logger.ts";
import type { LogType } from "./partition-manager.ts";

const logger = createLogger({ module: "r2-storage" });

export interface ManifestFile {
  name: string;
  records: number;
  size: number;
}

export interface ArchivalManifest {
  workspace_id: string;
  log_type: LogType;
  date: string;
  archived_at: string;
  total_records: number;
  files: ManifestFile[];
}

export function buildLogObjectKey(
  workspaceId: string,
  logType: LogType,
  date: Date,
  batchNumber: number
): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const dateStr = `${year}${month}${day}`;
  const batch = String(batchNumber).padStart(3, "0");

  return `logs/${workspaceId}/${logType}/${year}/${month}/${day}/logs_${dateStr}_${batch}.jsonl.gz`;
}

export function buildManifestKey(
  workspaceId: string,
  logType: LogType,
  date: Date
): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `logs/${workspaceId}/${logType}/${year}/${month}/${day}/manifest.json`;
}

export async function uploadLogFile(
  key: string,
  data: Buffer,
  contentLength: number
): Promise<boolean> {
  if (!isR2Configured() || !storageClient()) {
    logger.warn("R2 not configured, skipping upload");
    return false;
  }

  try {
    await storageClient()!.send(
      new PutObjectCommand({
        Bucket: storageBucket(),
        Key: key,
        Body: data,
        ContentType: "application/gzip",
        ContentLength: contentLength,
        ContentEncoding: "gzip",
      })
    );

    logger.debug({ key, size: contentLength }, "Uploaded log file to R2");
    return true;
  } catch (error) {
    logger.error({ key, error }, "Failed to upload log file to R2");
    throw error;
  }
}

export async function uploadManifest(
  workspaceId: string,
  logType: LogType,
  date: Date,
  manifest: ArchivalManifest
): Promise<string> {
  if (!isR2Configured() || !storageClient()) {
    throw new Error("R2 not configured");
  }

  const key = buildManifestKey(workspaceId, logType, date);
  const manifestJson = JSON.stringify(manifest, null, 2);
  const data = Buffer.from(manifestJson, "utf-8");

  try {
    await storageClient()!.send(
      new PutObjectCommand({
        Bucket: storageBucket(),
        Key: key,
        Body: data,
        ContentType: "application/json",
        ContentLength: data.length,
      })
    );

    logger.info({ key, totalRecords: manifest.total_records }, "Uploaded manifest to R2");
    return key;
  } catch (error) {
    logger.error({ key, error }, "Failed to upload manifest to R2");
    throw error;
  }
}

export async function manifestExists(
  workspaceId: string,
  logType: LogType,
  date: Date
): Promise<boolean> {
  if (!isR2Configured() || !storageClient()) {
    return false;
  }

  const key = buildManifestKey(workspaceId, logType, date);

  try {
    await storageClient()!.send(
      new HeadObjectCommand({
        Bucket: storageBucket(),
        Key: key,
      })
    );
    return true;
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name;
    if (errorName === "NotFound" || errorName === "NoSuchKey") {
      return false;
    }
    logger.error({ key, error }, "Error checking manifest existence");
    throw error;
  }
}

export async function getManifest(
  workspaceId: string,
  logType: LogType,
  date: Date
): Promise<ArchivalManifest | null> {
  if (!isR2Configured() || !storageClient()) {
    return null;
  }

  const key = buildManifestKey(workspaceId, logType, date);

  try {
    const response = await storageClient()!.send(
      new GetObjectCommand({
        Bucket: storageBucket(),
        Key: key,
      })
    );

    if (!response.Body) {
      return null;
    }

    const bodyString = await response.Body.transformToString();
    return JSON.parse(bodyString) as ArchivalManifest;
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name;
    if (errorName === "NotFound" || errorName === "NoSuchKey") {
      return null;
    }
    logger.error({ key, error }, "Error getting manifest");
    throw error;
  }
}

export async function verifyManifestFiles(
  workspaceId: string,
  logType: LogType,
  date: Date
): Promise<{ valid: boolean; missingFiles: string[] }> {
  if (!isR2Configured() || !storageClient()) {
    return { valid: false, missingFiles: [] };
  }

  const manifest = await getManifest(workspaceId, logType, date);
  if (!manifest) {
    return { valid: false, missingFiles: ["manifest.json"] };
  }

  const missingFiles: string[] = [];
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const prefix = `logs/${workspaceId}/${logType}/${year}/${month}/${day}/`;

  for (const file of manifest.files) {
    const key = `${prefix}${file.name}`;
    try {
      await storageClient()!.send(
        new HeadObjectCommand({
          Bucket: storageBucket(),
          Key: key,
        })
      );
    } catch (error: unknown) {
      const errorName = (error as { name?: string })?.name;
      if (errorName === "NotFound" || errorName === "NoSuchKey") {
        missingFiles.push(file.name);
      } else {
        throw error;
      }
    }
  }

  return {
    valid: missingFiles.length === 0,
    missingFiles,
  };
}

export async function listArchivedDates(
  workspaceId: string,
  logType: LogType
): Promise<Date[]> {
  if (!isR2Configured() || !storageClient()) {
    return [];
  }

  const prefix = `logs/${workspaceId}/${logType}/`;
  const dates: Date[] = [];

  try {
    let continuationToken: string | undefined;

    do {
      const response = await storageClient()!.send(
        new ListObjectsV2Command({
          Bucket: storageBucket(),
          Prefix: prefix,
          Delimiter: "/",
          ContinuationToken: continuationToken,
        })
      );

      if (response.CommonPrefixes) {
        for (const yearPrefix of response.CommonPrefixes) {
          if (!yearPrefix.Prefix) continue;

          const monthResponse = await storageClient()!.send(
            new ListObjectsV2Command({
              Bucket: storageBucket(),
              Prefix: yearPrefix.Prefix,
              Delimiter: "/",
            })
          );

          if (monthResponse.CommonPrefixes) {
            for (const monthPrefix of monthResponse.CommonPrefixes) {
              if (!monthPrefix.Prefix) continue;

              const dayResponse = await storageClient()!.send(
                new ListObjectsV2Command({
                  Bucket: storageBucket(),
                  Prefix: monthPrefix.Prefix,
                  Delimiter: "/",
                })
              );

              if (dayResponse.CommonPrefixes) {
                for (const dayPrefix of dayResponse.CommonPrefixes) {
                  if (!dayPrefix.Prefix) continue;

                  const match = dayPrefix.Prefix.match(/(\d{4})\/(\d{2})\/(\d{2})\/$/);
                  if (match) {
                    const [, year, month, day] = match;
                    dates.push(new Date(parseInt(year), parseInt(month) - 1, parseInt(day)));
                  }
                }
              }
            }
          }
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return dates.sort((a, b) => a.getTime() - b.getTime());
  } catch (error) {
    logger.error({ workspaceId, logType, error }, "Error listing archived dates");
    return [];
  }
}
