import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalObjectStore } from "./local-object-store.ts";

let root: string;
let store: LocalObjectStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "anlyon-local-store-"));
  store = new LocalObjectStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalObjectStore", () => {
  it("writes, reads, heads and deletes an object", async () => {
    await store.send(new PutObjectCommand({ Bucket: "local", Key: "logs/ws/a.json", Body: Buffer.from('{"a":1}') }));
    const read = await store.send(new GetObjectCommand({ Bucket: "local", Key: "logs/ws/a.json" }));
    expect(await read.Body.transformToString()).toBe('{"a":1}');
    expect((await store.send(new HeadObjectCommand({ Bucket: "local", Key: "logs/ws/a.json" }))).ContentLength).toBe(7);
    await store.send(new DeleteObjectCommand({ Bucket: "local", Key: "logs/ws/a.json" }));
    await expect(store.send(new HeadObjectCommand({ Bucket: "local", Key: "logs/ws/a.json" }))).rejects.toMatchObject({ name: "NoSuchKey" });
    await expect(store.send(new GetObjectCommand({ Bucket: "local", Key: "logs/ws/a.json" }))).rejects.toMatchObject({ name: "NoSuchKey" });
  });

  it("lists by prefix, with common prefixes under a delimiter", async () => {
    for (const key of ["logs/w/t/2026/10/19/x.gz", "logs/w/t/2026/10/20/y.gz", "logs/w/t/2026/11/01/z.gz", "logs/other/q.gz"]) {
      await store.send(new PutObjectCommand({ Bucket: "local", Key: key, Body: "x" }));
    }
    const years = await store.send(new ListObjectsV2Command({ Bucket: "local", Prefix: "logs/w/t/", Delimiter: "/" }));
    expect(years.CommonPrefixes).toEqual([{ Prefix: "logs/w/t/2026/" }]);
    const days = await store.send(new ListObjectsV2Command({ Bucket: "local", Prefix: "logs/w/t/2026/10/", Delimiter: "/" }));
    expect(days.CommonPrefixes.map((p: { Prefix: string }) => p.Prefix)).toEqual(["logs/w/t/2026/10/19/", "logs/w/t/2026/10/20/"]);
    const all = await store.send(new ListObjectsV2Command({ Bucket: "local", Prefix: "logs/w/" }));
    expect(all.Contents).toHaveLength(3);
  });

  it("refuses a key that leaves its directory", async () => {
    await expect(store.send(new PutObjectCommand({ Bucket: "local", Key: "../escape.txt", Body: "x" }))).rejects.toThrow(/leaves the storage directory/);
  });
});
