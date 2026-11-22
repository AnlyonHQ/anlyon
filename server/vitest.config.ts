import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import { resolveTestTargets, UNREACHABLE, REDIS_SCOPED_ACK, SHARED_REDIS_TEST_FILES } from "./tests/support/test-target.ts";

let appEnv: Record<string, string> = {};
try {
  appEnv = parse(readFileSync(new URL("./.env", import.meta.url)));
} catch {
}
const testVar = (name: string) => process.env[name] ?? appEnv[name];
const scopedSharedRedis = process.env.TEST_REDIS_SCOPED_ACK === REDIS_SCOPED_ACK;
const targets = resolveTestTargets({
  TEST_DATABASE_URL: testVar("TEST_DATABASE_URL"),
  TEST_REDIS_URL: testVar("TEST_REDIS_URL"),
  TEST_TARGETS_DISPOSABLE: testVar("TEST_TARGETS_DISPOSABLE"),
  TEST_DATABASE_NAME_ACK: testVar("TEST_DATABASE_NAME_ACK"),
  TEST_REDIS_SHARED_ACK: testVar("TEST_REDIS_SHARED_ACK"),
  TEST_REDIS_SCOPED_ACK: process.env.TEST_REDIS_SCOPED_ACK,
  DATABASE_URL: appEnv.DATABASE_URL,
  REDIS_URL: appEnv.REDIS_URL,
});

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    globalSetup: ["./tests/support/global-setup.ts"],
    setupFiles: ["./tests/support/edition.ts"],
    env: {
      NODE_ENV: "test",
      VITEST: "true",
      DATABASE_URL: targets.ok ? targets.databaseUrl : UNREACHABLE.databaseUrl,
      REDIS_URL: targets.ok ? targets.redisUrl : UNREACHABLE.redisUrl,
      ANLYON_TEST_TARGETS: targets.ok ? "ok" : "missing",
      ANLYON_TEST_TARGETS_REASON: targets.ok ? "" : targets.reason,
    },
    exclude: ["node_modules", "dist"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: scopedSharedRedis ? [] : ["src/**/*.test.ts", "tests/**/*.test.ts"],
          exclude: ["node_modules", "dist", "tests/**/*.integration.test.ts", "src/**/*.integration.test.ts", "tests/api/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: scopedSharedRedis ? SHARED_REDIS_TEST_FILES : ["tests/**/*.integration.test.ts", "src/**/*.integration.test.ts", "tests/api/**/*.test.ts"],
          exclude: ["node_modules", "dist"],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/index.ts",
        "src/db/**",
        "src/types/**",
      ],
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 70,
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
    pool: "forks",
    isolate: true,
  },
});
