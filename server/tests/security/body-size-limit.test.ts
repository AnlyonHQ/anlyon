import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { bodySizeLimit, isBodyLimitError } from "../../src/api/middleware/security.ts";
import { buildErrorResponse } from "../../src/api/middleware/error.ts";

const LIMIT = 64 * 1024;
let server: ServerType;
let port: number;
let bytesSeenByHandler = 0;

beforeAll(async () => {
  const app = new Hono();
  app.onError((err, c) => buildErrorResponse(err, c));
  app.use("*", bodySizeLimit(LIMIT));
  app.post("/catching", async (c) => {
    try {
      const text = await c.req.text();
      bytesSeenByHandler = Buffer.byteLength(text);
      return c.json({ received: bytesSeenByHandler });
    } catch (error) {
      if (isBodyLimitError(error)) throw error;
      return c.json({ error: "Invalid signature" }, 400);
    }
  });
  app.post("/echo", async (c) => {
    const text = await c.req.text();
    bytesSeenByHandler = Buffer.byteLength(text);
    return c.json({ received: bytesSeenByHandler });
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve());
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server?.close();
});

function send(body: Buffer, chunked: boolean, path = "/echo"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        agent: false,
        headers: chunked
          ? { "Content-Type": "application/octet-stream", "Transfer-Encoding": "chunked" }
          : { "Content-Type": "application/octet-stream", "Content-Length": body.length },
      },
      (res) => {
        status = res.statusCode ?? 0;
        res.resume();
        resolve(status);
      },
    );
    let status: number | undefined;
    req.on("error", (error) => (bytesSeenByHandler === 0 && status === undefined ? resolve(-1) : reject(error)));
    if (chunked) {
      for (let offset = 0; offset < body.length; offset += 16 * 1024) req.write(body.subarray(offset, offset + 16 * 1024));
    } else {
      req.write(body);
    }
    req.end();
  });
}

describe("the request body size cap", () => {
  const oversized = Buffer.alloc(LIMIT * 8, 0x61);

  it("rejects an oversized body that declares its length", async () => {
    expect(await send(oversized, false)).toBe(413);
  });

  it("rejects an oversized chunked body that declares no length", async () => {
    bytesSeenByHandler = 0;
    const status = await send(oversized, true);
    expect([413, -1]).toContain(status);
    expect(bytesSeenByHandler).toBe(0);
  });

  it("answers 413, not the handler's own 400, when the handler catches read errors", async () => {
    bytesSeenByHandler = 0;
    expect([413, -1]).toContain(await send(oversized, true, "/catching"));
    expect(bytesSeenByHandler).toBe(0);
  });

  it("still accepts a body under the cap, chunked or not", async () => {
    const small = Buffer.alloc(LIMIT / 2, 0x61);
    expect(await send(small, false)).toBe(200);
    expect(await send(small, true)).toBe(200);
  });
});
