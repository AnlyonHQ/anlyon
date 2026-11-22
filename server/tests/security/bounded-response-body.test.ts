import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetch as undiciFetch } from "undici";
import { readBodyLimited } from "../../src/lib/read-body.ts";

let server: http.Server;
let base: string;
let bytesServed = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/small") {
      res.end("héllo");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const pump = () => {
      while (res.write(chunk)) bytesServed += chunk.length;
      bytesServed += chunk.length;
    };
    res.on("drain", pump);
    req.on("close", () => res.destroy());
    pump();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.closeAllConnections();
  server?.close();
});

describe("reading a hostile, endless response body", () => {
  it("text() does not return while the server keeps sending (the old behaviour)", async () => {
    bytesServed = 0;
    const controller = new AbortController();
    const response = await undiciFetch(`${base}/endless`, { signal: controller.signal });
    const outcome = await Promise.race([
      response.text().then(() => "returned", () => "aborted"),
      new Promise<string>((resolve) => setTimeout(() => resolve("still buffering"), 1500)),
    ]);
    controller.abort();
    expect(outcome).toBe("still buffering");
    expect(bytesServed).toBeGreaterThan(4 * 1024 * 1024);
  });

  it("readBodyLimited stops at the cap and reports the truncation", async () => {
    const response = await undiciFetch(`${base}/endless`);
    const started = Date.now();
    const read = await readBodyLimited(response as unknown as Response, 100_000);
    expect(read.truncated).toBe(true);
    expect(read.bytes).toBe(100_000);
    expect(Buffer.byteLength(read.text)).toBe(100_000);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("returns a small body whole", async () => {
    const response = await undiciFetch(`${base}/small`);
    const read = await readBodyLimited(response as unknown as Response, 1024);
    expect(read).toEqual({ text: "héllo", bytes: Buffer.byteLength("héllo"), truncated: false });
  });

  it("treats a body exactly at the cap as complete", async () => {
    const response = await undiciFetch(`${base}/small`);
    const exact = Buffer.byteLength("héllo");
    expect((await readBodyLimited(response as unknown as Response, exact)).truncated).toBe(false);
  });
});
