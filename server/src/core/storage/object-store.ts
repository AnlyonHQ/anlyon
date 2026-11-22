import { PutObjectCommand } from "@aws-sdk/client-s3";
import { storageClient, storageBucket, isR2Configured } from "../../lib/r2-client.ts";

export { isR2Configured };

export class ObjectStoreNotConfiguredError extends Error {
  constructor() {
    super("Object storage is not configured. Set the R2_* environment variables to enable it.");
    this.name = "ObjectStoreNotConfiguredError";
  }
}

function requireStore() {
  const client = storageClient();
  const bucket = storageBucket();
  if (!isR2Configured() || !client || !bucket) {
    throw new ObjectStoreNotConfiguredError();
  }
  return { client, bucket };
}

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  const { client, bucket } = requireStore();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}
