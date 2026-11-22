import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

class NoSuchKey extends Error {
  override name = "NoSuchKey";
  $metadata = { httpStatusCode: 404 };
}

type Body = Uint8Array | Buffer | string;

export class LocalObjectStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const full = resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error(`Object key leaves the storage directory: ${key}`);
    return full;
  }

  // biome-ignore lint/suspicious/noExplicitAny: mirrors S3Client.send, whose result type depends on the command.
  async send(command: unknown): Promise<any> {
    if (command instanceof PutObjectCommand) {
      const { Key, Body: body } = command.input;
      const file = this.path(Key!);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, typeof body === "string" ? body : Buffer.from(body as Uint8Array), { mode: 0o600 });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const data = await this.read(command.input.Key!);
      return {
        Body: {
          transformToString: async (encoding: BufferEncoding = "utf8") => data.toString(encoding),
          transformToByteArray: async () => new Uint8Array(data),
        },
        ContentLength: data.length,
      };
    }
    if (command instanceof HeadObjectCommand) {
      const info = await stat(this.path(command.input.Key!)).catch(() => null);
      if (!info?.isFile()) throw new NoSuchKey(command.input.Key);
      return { ContentLength: info.size, LastModified: info.mtime };
    }
    if (command instanceof DeleteObjectCommand) {
      await rm(this.path(command.input.Key!), { force: true });
      return {};
    }
    if (command instanceof ListObjectsV2Command) {
      return this.list(command.input.Prefix ?? "", command.input.Delimiter);
    }
    throw new Error(`Local storage does not support ${(command as { constructor?: { name?: string } })?.constructor?.name ?? "this command"}`);
  }

  private async read(key: string): Promise<Buffer> {
    try {
      return await readFile(this.path(key));
    } catch {
      throw new NoSuchKey(key);
    }
  }

  private async list(prefix: string, delimiter?: string) {
    const keys: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) keys.push(relative(this.root, full).split(sep).join("/"));
      }
    };
    await walk(this.root);
    const matching = keys.filter((key) => key.startsWith(prefix)).sort();
    if (!delimiter) return { Contents: matching.map((Key) => ({ Key })), KeyCount: matching.length, IsTruncated: false };
    const contents: { Key: string }[] = [];
    const prefixes = new Set<string>();
    for (const key of matching) {
      const rest = key.slice(prefix.length);
      const cut = rest.indexOf(delimiter);
      if (cut === -1) contents.push({ Key: key });
      else prefixes.add(prefix + rest.slice(0, cut + delimiter.length));
    }
    return {
      Contents: contents,
      CommonPrefixes: [...prefixes].sort().map((Prefix) => ({ Prefix })),
      KeyCount: contents.length + prefixes.size,
      IsTruncated: false,
    };
  }
}
