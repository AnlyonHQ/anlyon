import { describe, it, expect } from "vitest";
import { RedisKeys } from "../src/lib/redis.ts";

describe("the idempotency namespace", () => {
  it("separates the same key in two environments", () => {
    const staging = RedisKeys.idempotency("ws_1", "env_staging", "order-42");
    const production = RedisKeys.idempotency("ws_1", "env_production", "order-42");

    expect(staging).not.toBe(production);
  });

  it("still separates workspaces", () => {
    expect(RedisKeys.idempotency("ws_1", "env_1", "k")).not.toBe(
      RedisKeys.idempotency("ws_2", "env_1", "k"),
    );
  });

  it("is stable for the same workspace, environment and key", () => {
    expect(RedisKeys.idempotency("ws_1", "env_1", "k")).toBe(
      RedisKeys.idempotency("ws_1", "env_1", "k"),
    );
  });

  it("keeps the environment in its own segment, so keys cannot be confused", () => {
    expect(RedisKeys.idempotency("a", "bc", "k")).not.toBe(RedisKeys.idempotency("ab", "c", "k"));
  });
});
