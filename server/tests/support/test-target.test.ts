import { describe, expect, it } from "vitest";
import { DB_NAME_ACK, DISPOSABLE_ACK, REDIS_SHARED_ACK, REDIS_SCOPED_ACK, looksLikeTestDatabase, resolveTestTargets } from "./test-target.ts";

const good = {
  TEST_DATABASE_URL: "postgresql://u:p@db.example.com:5432/anlyon_test",
  TEST_REDIS_URL: "rediss://default:p@redis.example.com:6379",
  TEST_TARGETS_DISPOSABLE: DISPOSABLE_ACK,
};

describe("test target validation", () => {
  it("uses only REDIS_URL in explicitly authorized scoped mode", () => {
    const result = resolveTestTargets({ ...good, REDIS_URL: "redis://shared:6379", TEST_REDIS_SCOPED_ACK: REDIS_SCOPED_ACK });
    expect(result).toMatchObject({ ok: true, redisUrl: "redis://shared:6379" });
    expect(resolveTestTargets({ ...good, TEST_REDIS_SCOPED_ACK: REDIS_SCOPED_ACK })).toMatchObject({ ok: false });
  });
  it("accepts an explicitly designated disposable test database and Redis", () => {
    expect(resolveTestTargets(good)).toMatchObject({ ok: true });
  });

  it("does not fall back to the application credentials", () => {
    const r = resolveTestTargets({ DATABASE_URL: "postgresql://u:p@db/app", REDIS_URL: "redis://r" });
    expect(r).toMatchObject({ ok: false });
  });

  it("requires the exact acknowledgement, not a truthy value", () => {
    expect(resolveTestTargets({ ...good, TEST_TARGETS_DISPOSABLE: "true" })).toMatchObject({ ok: false });
    expect(resolveTestTargets({ ...good, TEST_TARGETS_DISPOSABLE: "1" })).toMatchObject({ ok: false });
  });

  it("refuses a database whose name does not say it is for tests", () => {
    expect(resolveTestTargets({ ...good, TEST_DATABASE_URL: "postgresql://u:p@db.example.com/anlyon" })).toMatchObject({ ok: false });
    expect(looksLikeTestDatabase(new URL("postgresql://u:p@h/contest"))).toBe(false);
    expect(looksLikeTestDatabase(new URL("postgresql://u:p@h/test"))).toBe(true);
    expect(looksLikeTestDatabase(new URL("postgresql://u:p@h/app-test-1"))).toBe(true);
  });

  it("refuses a test target that is the application resource", () => {
    expect(resolveTestTargets({ ...good, DATABASE_URL: "postgresql://x:y@db.example.com:5432/anlyon_test" })).toMatchObject({ ok: false });
    expect(resolveTestTargets({ ...good, REDIS_URL: "rediss://x:y@redis.example.com:6379" })).toMatchObject({ ok: false });
  });

  it("never puts a connection string in its message", () => {
    const r = resolveTestTargets({ ...good, TEST_DATABASE_URL: "postgresql://secretuser:secretpass@db.example.com/prod" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toMatch(/secret|db\.example/);
  });

  it("rejects non-postgres and non-redis schemes", () => {
    expect(resolveTestTargets({ ...good, TEST_DATABASE_URL: "mysql://u:p@h/anlyon_test" })).toMatchObject({ ok: false });
    expect(resolveTestTargets({ ...good, TEST_REDIS_URL: "http://h" })).toMatchObject({ ok: false });
  });

  it("accepts a provider-default database name only with its own exact acknowledgement", () => {
    const named = { ...good, TEST_DATABASE_URL: "postgresql://u:p@other.example.com/neondb" };
    expect(resolveTestTargets(named)).toMatchObject({ ok: false });
    expect(resolveTestTargets({ ...named, TEST_DATABASE_NAME_ACK: "yes" })).toMatchObject({ ok: false });
    expect(resolveTestTargets({ ...named, TEST_DATABASE_NAME_ACK: DB_NAME_ACK })).toMatchObject({ ok: true });
  });

  it("never allows the application database, even with every acknowledgement", () => {
    const same = {
      ...good,
      TEST_DATABASE_URL: "postgresql://u:p@db.example.com/neondb",
      DATABASE_URL: "postgresql://x:y@db.example.com/neondb",
      TEST_DATABASE_NAME_ACK: DB_NAME_ACK,
    };
    expect(resolveTestTargets(same)).toMatchObject({ ok: false });
  });

  it("refuses shared Redis even with the legacy no-flush acknowledgement", () => {
    const shared = { ...good, REDIS_URL: "rediss://x:y@redis.example.com:6379" };
    expect(resolveTestTargets(shared)).toMatchObject({ ok: false });
    expect(resolveTestTargets({ ...shared, TEST_REDIS_SHARED_ACK: REDIS_SHARED_ACK })).toMatchObject({ ok: false });
    expect(resolveTestTargets({ ...shared, REDIS_URL: "rediss://x:y@redis.example.com" })).toMatchObject({ ok: false });
  });
});
