import { beforeEach, describe, expect, it } from "vitest";
import { cacheSession, clearSessionCache, getCachedSession, sessionKey } from "../src/core/mcp-upstreams/session-cache.ts";

const base = { workspaceId: "ws", environmentId: "env", upstreamId: "up" };

describe("the MCP session cache key", () => {
  beforeEach(() => clearSessionCache());

  it("keeps the upstream's own session apart from an end user whose id is a dash", () => {
    const operator = sessionKey({ ...base, endUserId: null });
    expect(sessionKey({ ...base })).toBe(operator);
    for (const endUserId of ["-", "null", "", "undefined"]) {
      expect(sessionKey({ ...base, endUserId }), JSON.stringify(endUserId)).not.toBe(operator);
    }
    cacheSession(operator, { sessionId: "operator-session", protocolVersion: "2025-06-18" });
    expect(getCachedSession(sessionKey({ ...base, endUserId: "-" }))).toBeNull();
    expect(getCachedSession(operator)?.sessionId).toBe("operator-session");
  });

  it("cannot be made to collide by an id that contains a separator", () => {
    const keys = new Set([
      sessionKey({ ...base, endUserId: "a" }),
      sessionKey({ ...base, upstreamId: 'up","a', endUserId: null }),
      sessionKey({ ...base, upstreamId: "up\u0000a" }),
      sessionKey({ workspaceId: null, environmentId: "env", upstreamId: "up", endUserId: "a" }),
      sessionKey({ workspaceId: "-", environmentId: "env", upstreamId: "up", endUserId: "a" }),
    ]);
    expect(keys.size).toBe(5);
  });
});
