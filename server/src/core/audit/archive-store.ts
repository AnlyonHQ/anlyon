import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "../../config/env.ts";
import { storageBackend, storageClient } from "../../lib/r2-client.ts";

export interface AuditArchiveStore {
  put(key: string, body: Buffer, contentType: string, metadata?: Record<string, string>): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  head(key: string): Promise<{ sizeBytes: number } | null>;
  delete(key: string): Promise<void>;
}

function notFound(error: unknown): boolean {
  const name = (error as { name?: string }).name;
  return name === "NotFound" || name === "NoSuchKey" || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
}

export function s3ArchiveStore(client: S3Client, bucket: string): AuditArchiveStore {
  return {
    async put(key, body, contentType, metadata) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length, Metadata: metadata }));
    },
    async get(key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!response.Body) return null;
        return Buffer.from(await response.Body.transformToByteArray());
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    async head(key) {
      try {
        const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { sizeBytes: response.ContentLength ?? 0 };
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

let testStore: AuditArchiveStore | null | undefined;
let built: { store: AuditArchiveStore | null } | null = null;

function build(): AuditArchiveStore | null {
  const bucket = env.AUDIT_ARCHIVE_R2_BUCKET;
  if (!bucket || storageBackend() !== "r2") return null;
  if (env.AUDIT_ARCHIVE_R2_ACCESS_KEY_ID && env.AUDIT_ARCHIVE_R2_SECRET_ACCESS_KEY) {
    return s3ArchiveStore(new S3Client({
      region: "auto",
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: env.AUDIT_ARCHIVE_R2_ACCESS_KEY_ID, secretAccessKey: env.AUDIT_ARCHIVE_R2_SECRET_ACCESS_KEY },
    }), bucket);
  }
  const shared = storageClient();
  return shared ? s3ArchiveStore(shared, bucket) : null;
}

export function auditArchiveStore(): AuditArchiveStore | null {
  if (testStore !== undefined) return testStore;
  built ??= { store: build() };
  return built.store;
}

export function setAuditArchiveStoreForTest(store: AuditArchiveStore | null | undefined): void {
  testStore = store;
  built = null;
}
