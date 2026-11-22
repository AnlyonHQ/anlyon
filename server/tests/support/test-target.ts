export const DISPOSABLE_ACK = "yes-these-are-disposable-test-resources";

export const DB_NAME_ACK = "database-name-has-no-test-token-but-is-disposable";
export const REDIS_SHARED_ACK = "redis-is-shared-with-the-app-tests-never-flush-it";
export const REDIS_SCOPED_ACK = "use-app-redis-for-scoped-governance-tests-only";
export const SHARED_REDIS_TEST_FILES = [
  "tests/plan-quota-atomicity.integration.test.ts",
  "tests/event-fanout-partial-delivery.integration.test.ts",
  "tests/action-invoke-controls.integration.test.ts",
  "tests/worker-time-accounting.integration.test.ts",
  "tests/policy-governance.integration.test.ts",
  "tests/timestamps-clock.integration.test.ts",
  "tests/approval-concurrency.integration.test.ts",
  "tests/sdk-e2e.integration.test.ts",
];

export interface TargetEnv {
  TEST_DATABASE_URL?: string;
  TEST_REDIS_URL?: string;
  TEST_TARGETS_DISPOSABLE?: string;
  TEST_DATABASE_NAME_ACK?: string;
  TEST_REDIS_SHARED_ACK?: string;
  TEST_REDIS_SCOPED_ACK?: string;
  DATABASE_URL?: string;
  REDIS_URL?: string;
}

export type TargetResult =
  | { ok: true; databaseUrl: string; redisUrl: string }
  | { ok: false; reason: string };

function parse(url: string | undefined): URL | null {
  if (!url) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function identity(url: URL): string {
  return `${url.hostname.toLowerCase()}:${url.port || "default"}${url.pathname}`;
}

export function looksLikeTestDatabase(url: URL): boolean {
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return /(^|[_\-.])test($|[_\-.])/i.test(name);
}

export function resolveTestTargets(env: TargetEnv): TargetResult {
  const scopedShared = env.TEST_REDIS_SCOPED_ACK === REDIS_SCOPED_ACK;
  if (scopedShared) env = { ...env, TEST_REDIS_URL: env.REDIS_URL };
  if (!env.TEST_DATABASE_URL || !env.TEST_REDIS_URL) {
    return { ok: false, reason: "TEST_DATABASE_URL and TEST_REDIS_URL are required. The application .env is never used for tests." };
  }
  if (env.TEST_TARGETS_DISPOSABLE !== DISPOSABLE_ACK) {
    return { ok: false, reason: `TEST_TARGETS_DISPOSABLE must be set to "${DISPOSABLE_ACK}" to confirm both resources are disposable.` };
  }
  const db = parse(env.TEST_DATABASE_URL);
  const redis = parse(env.TEST_REDIS_URL);
  if (!db || !/^postgres(ql)?:$/.test(db.protocol)) return { ok: false, reason: "TEST_DATABASE_URL is not a PostgreSQL URL." };
  if (!redis || !/^rediss?:$/.test(redis.protocol)) return { ok: false, reason: "TEST_REDIS_URL is not a Redis URL." };
  if (!looksLikeTestDatabase(db) && env.TEST_DATABASE_NAME_ACK !== DB_NAME_ACK) {
    return {
      ok: false,
      reason: `The test database name must contain a "test" token (for example anlyon_test), or TEST_DATABASE_NAME_ACK must be "${DB_NAME_ACK}". Refusing.`,
    };
  }
  const appDb = parse(env.DATABASE_URL);
  if (appDb && appDb.hostname.toLowerCase() === db.hostname.toLowerCase() && identity(appDb) === identity(db)) {
    return { ok: false, reason: "TEST_DATABASE_URL is the same database as DATABASE_URL. Refusing." };
  }
  const appRedis = parse(env.REDIS_URL);
  if (
    appRedis &&
    appRedis.hostname.toLowerCase() === redis.hostname.toLowerCase() &&
    (appRedis.port || "6379") === (redis.port || "6379") && !scopedShared
  ) {
    return {
      ok: false,
      reason: "TEST_REDIS_URL is the same Redis as REDIS_URL. Refusing: tests delete global worker keys even without flushing. Use a dedicated disposable Redis instance.",
    };
  }
  return { ok: true, databaseUrl: env.TEST_DATABASE_URL, redisUrl: env.TEST_REDIS_URL };
}

export const UNREACHABLE = {
  databaseUrl: "postgresql://unset:unset@127.0.0.1:1/unset",
  redisUrl: "redis://127.0.0.1:1",
};
