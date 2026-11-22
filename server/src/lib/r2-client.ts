import { S3Client } from "@aws-sdk/client-s3";
import { env } from "../config/env.ts";
import { instanceSetting, onInstanceSettingsChange } from "../core/instance/settings.ts";
import { LocalObjectStore } from "./local-object-store.ts";

export type StorageBackend = "r2" | "s3" | "local" | "none";

let cached: { backend: StorageBackend; client: S3Client | null; bucket: string | undefined } | null = null;

onInstanceSettingsChange((changed) => {
  if (changed.some((key) => key.startsWith("storage."))) {
    cached?.client?.destroy();
    cached = null;
  }
});

export function storageBackend(): StorageBackend {
  if (env.R2_ACCOUNT_ID) return "r2";
  const chosen = instanceSetting("storage.backend") as StorageBackend | undefined;
  if (chosen === "local" || chosen === "none") return chosen;
  const s3Ready = Boolean(
    instanceSetting("storage.s3_bucket") && instanceSetting("storage.s3_access_key_id") && instanceSetting("storage.s3_secret_access_key"),
  );
  return s3Ready ? "s3" : "none";
}

function build(): NonNullable<typeof cached> {
  const backend = storageBackend();
  switch (backend) {
    case "r2":
      return {
        backend,
        client: new S3Client({
          region: "auto",
          endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
          credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! },
        }),
        bucket: env.R2_BUCKET_NAME,
      };
    case "s3": {
      const endpoint = instanceSetting("storage.s3_endpoint");
      return {
        backend,
        client: new S3Client({
          region: instanceSetting("storage.s3_region") ?? "us-east-1",
          ...(endpoint ? { endpoint, forcePathStyle: instanceSetting("storage.s3_force_path_style") !== "false" } : {}),
          credentials: {
            accessKeyId: instanceSetting("storage.s3_access_key_id")!,
            secretAccessKey: instanceSetting("storage.s3_secret_access_key")!,
          },
        }),
        bucket: instanceSetting("storage.s3_bucket"),
      };
    }
    case "local":
      return { backend, client: new LocalObjectStore(instanceSetting("storage.local_dir") ?? "data/storage") as unknown as S3Client, bucket: "local" };
    case "none":
      return { backend, client: null, bucket: undefined };
  }
}

export function storageClient(): S3Client | null {
  cached ??= build();
  return cached.client;
}

export function storageBucket(): string | undefined {
  cached ??= build();
  return cached.bucket;
}

export function isR2Configured(): boolean {
  return storageClient() !== null && storageBucket() !== undefined;
}
