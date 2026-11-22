import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hasUnstorableText, storableValue, stripUnstorable } from "../src/utils/storable-text.ts";

vi.mock("../src/db/index.ts", () => ({ db: {}, pool: { end: async () => {} } }));
vi.mock("../src/lib/redis.ts", () => ({ redis: {}, redisBlocking: {}, RedisKeys: {}, createBlockingConnection: () => ({}) }));

const { boundDetails } = await import("../src/core/effects/lifecycle.ts");

describe("text Postgres refuses", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = new PGlite();
    await pg.waitReady;
  }, 60_000);
  afterAll(async () => {
    await pg.close();
  });
  const stored = (value: unknown) => pg.query("SELECT $1::jsonb AS v", [JSON.stringify(value)]);

  it("is what the column refuses, and boundDetails leaves none of it", async () => {
    await expect(stored({ text: "a\u0000b" })).rejects.toThrow();
    await expect(stored({ text: "a\ud83d" })).rejects.toThrow();
    const details = boundDetails({ text: "a\u0000b\ud83d", "k\u0000ey": ["\udc00c"], n: 1, nothing: null });
    expect(details).toEqual({ text: "ab", key: ["c"], n: 1, nothing: null });
    await expect(stored(details)).resolves.toBeTruthy();
  });

  it("the excerpt of details too long to keep is cut without leaving half a character", async () => {
    const details = boundDetails({ text: "\ud83d\ude00".repeat(100_000) });
    expect(details.truncated).toBe(true);
    await expect(stored(details)).resolves.toBeTruthy();
  });

  it("keeps a surrogate pair whole, and finds what it strips", () => {
    expect(stripUnstorable("ok \ud83d\ude00")).toBe("ok \ud83d\ude00");
    expect(storableValue({ when: new Date(0) })).toEqual({ when: new Date(0) });
    expect(hasUnstorableText({ a: [{ b: "ok \ud83d\ude00" }] })).toBe(false);
    expect(hasUnstorableText({ a: [{ b: "x\u0000" }] })).toBe(true);
    expect(hasUnstorableText({ "x\ud83d": 1 })).toBe(true);
  });
});
