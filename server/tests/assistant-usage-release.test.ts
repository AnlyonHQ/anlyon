import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const dialect = new PgDialect();
const inserted: Array<{ period: string; kind: string }> = [];
const released: Array<{ sql: string; params: unknown[] }> = [];

vi.mock("../src/db/index.ts", () => ({
  db: {
    insert: () => ({
      values: (v: { period: string; kind: string }) => {
        inserted.push({ period: v.period, kind: v.kind });
        return { onConflictDoUpdate: () => ({ returning: async () => [{ count: 1 }] }) };
      },
    }),
    update: () => ({
      set: (values: { count: SQL }) => ({
        where: async (condition: SQL) => {
          const set = dialect.sqlToQuery(values.count);
          const where = dialect.sqlToQuery(condition);
          released.push({ sql: `${set.sql} WHERE ${where.sql}`, params: where.params });
        },
      }),
    }),
    select: () => ({ from: () => ({ where: async () => [{ total: 0 }] }) }),
  },
}));

const evals = vi.hoisted(() => [] as Array<{ script: string; key: string }>);
vi.mock("../src/lib/redis.ts", () => ({
  redis: {
    eval: vi.fn(async (script: string, _n: number, key: string) => {
      evals.push({ script, key });
      return 1;
    }),
  },
}));
vi.mock("../src/config/env.ts", () => ({ env: { ASSISTANT_PLATFORM_MONTHLY_REVIEW_CEILING: 1000 } }));

import {
  admitAssistantUsage,
  admitPlatformReview,
  releaseAssistantUsage,
  releasePlatformReview,
} from "../src/core/assistant/usage.ts";

beforeEach(() => {
  inserted.length = 0;
  released.length = 0;
  evals.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("assistant usage release across UTC boundaries", () => {
  it("gives back a monthly review on the month it was admitted in, after midnight on the 1st", async () => {
    vi.setSystemTime(new Date("2026-09-30T23:59:59.900Z"));
    const reservation = await admitAssistantUsage("ws-1", "reviews", 100);
    expect(reservation).toEqual({ workspaceId: "ws-1", kind: "reviews", period: "2026-09" });
    expect(inserted).toEqual([{ period: "2026-09", kind: "reviews" }]);

    vi.setSystemTime(new Date("2026-10-01T00:00:00.100Z"));
    await releaseAssistantUsage(reservation!);
    expect(released).toHaveLength(1);
    expect(released[0].params).toEqual(["ws-1", "2026-09", "reviews"]);
    expect(released[0].params).not.toContain("2026-10");
  });

  it("gives back a daily auto-approval on the day it was admitted in, after UTC midnight", async () => {
    vi.setSystemTime(new Date("2026-09-28T23:59:59.900Z"));
    const reservation = await admitAssistantUsage("ws-1", "auto_approvals", 5);
    expect(reservation?.period).toBe("2026-09-28");

    vi.setSystemTime(new Date("2026-09-29T00:00:00.100Z"));
    await releaseAssistantUsage(reservation!);
    expect(released[0].params).toEqual(["ws-1", "2026-09-28", "auto_approvals"]);
  });

  it("never takes a counter below zero", async () => {
    const reservation = await admitAssistantUsage("ws-1", "reviews", "unlimited");
    await releaseAssistantUsage(reservation!);
    expect(released[0].sql).toMatch(/greatest\("assistant_usage"\."count" - 1, 0\)/);
  });

  it("returns no reservation (and takes nothing) at a zero cap", async () => {
    expect(await admitAssistantUsage("ws-1", "reviews", 0)).toBeNull();
    expect(inserted).toEqual([]);
  });

  it("gives back a platform review on the month it was admitted in, and only if above zero", async () => {
    vi.setSystemTime(new Date("2026-12-31T23:59:59.900Z"));
    const reservation = await admitPlatformReview();
    expect(reservation).toEqual({ period: "2026-12" });

    vi.setSystemTime(new Date("2027-01-01T00:00:00.100Z"));
    await releasePlatformReview(reservation!);
    const release = evals.at(-1)!;
    expect(release.key).toBe("assistant:platform-reviews:2026-12");
    expect(release.script).toContain("tonumber(v) > 0");
  });
});
