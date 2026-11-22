import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  haltBlocks,
  haltBlocksIntakeFrom,
  type EffectClass,
} from "../src/core/environments/effects.ts";

const isEnvironmentHalted = vi.fn();

vi.mock("../src/core/environments/halt.ts", () => ({
  isEnvironmentHalted: (...a: unknown[]) => isEnvironmentHalted(...a),
}));

const { haltGuard } = await import("../src/api/middleware/halt.ts");

describe("the effect model", () => {
  it("stops the agent acting and stops anything leaving", () => {
    expect(haltBlocks("external")).toBe(true);
    expect(haltBlocks("agent_write")).toBe(true);
  });

  it("keeps accepting data, operator controls, and reads", () => {
    expect(haltBlocks("intake")).toBe(false);
    expect(haltBlocks("operator")).toBe(false);
    expect(haltBlocks("read")).toBe(false);
  });

  it("classifies every effect class", () => {
    const all: EffectClass[] = ["read", "agent_write", "intake", "operator", "external"];
    for (const effect of all) expect(typeof haltBlocks(effect)).toBe("boolean");
  });
});

function app(
  effect: EffectClass,
  authType = "apiKey",
  environmentId: string | null = "env_1",
  scopes: string[] = [],
) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("authType", authType);
    c.set("apiKeyScopes", scopes);
    if (environmentId) c.set("environmentId", environmentId);
    await next();
  });
  a.use("*", haltGuard(effect));
  a.get("/", (c) => c.json({ ok: true }));
  a.post("/", (c) => c.json({ ok: true }));
  a.onError((err, c) => c.json({ error: err.message }, 409));
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  isEnvironmentHalted.mockResolvedValue(true);
});

describe("the guard, on a halted environment", () => {
  it("refuses an agent write", async () => {
    const response = await app("agent_write").request("/", { method: "POST" });
    expect(response.status).toBe(409);
  });

  it("allows a read of the same router", async () => {
    const response = await app("agent_write").request("/", { method: "GET" });
    expect(response.status).toBe(200);
  });

  it("refuses intake from the halted agent  the resume bomb", async () => {
    const response = await app("intake", "apiKey", "env_1", ["messages:write"]).request("/", {
      method: "POST",
    });
    expect(response.status).toBe(409);
  });

  it("allows intake from a dedicated ingress credential, so nothing in flight is lost", async () => {
    const response = await app("intake", "apiKey", "env_1", ["messages:ingest"]).request("/", {
      method: "POST",
    });
    expect(response.status).toBe(200);
  });

  it("allows operator actions, so the halt does not disable its own undo", async () => {
    const response = await app("operator").request("/", { method: "POST" });
    expect(response.status).toBe(200);
  });

  it("lets a dashboard session through  a halt is a leash on the agent", async () => {
    const response = await app("agent_write", "session").request("/", { method: "POST" });
    expect(response.status).toBe(200);
  });

  it("does not consult halt state at all for an unblocked class", async () => {
    await app("operator").request("/", { method: "POST" });
    expect(isEnvironmentHalted).not.toHaveBeenCalled();
  });
});

describe("the guard, on a running environment", () => {
  it("allows the agent write", async () => {
    isEnvironmentHalted.mockResolvedValue(false);
    const response = await app("agent_write").request("/", { method: "POST" });
    expect(response.status).toBe(200);
  });
});

describe("a caller with no resolved environment", () => {
  it("passes rather than guessing which environment to check", async () => {
    isEnvironmentHalted.mockResolvedValue(true);
    const response = await app("agent_write", "apiKey", null).request("/", { method: "POST" });
    expect(response.status).toBe(200);
    expect(isEnvironmentHalted).not.toHaveBeenCalled();
  });
});


describe("intake depends on who is publishing", () => {
  const agent = { authType: "apiKey", scopes: ["messages:write"] };

  it("refuses the halted agent's own publishes  the resume bomb", () => {
    expect(haltBlocksIntakeFrom(agent)).toBe(true);
  });

  it("keeps a customer's own ingress flowing", () => {
    expect(haltBlocksIntakeFrom({ authType: "apiKey", scopes: ["messages:ingest"] })).toBe(false);
  });

  it("lets a dashboard session through", () => {
    expect(haltBlocksIntakeFrom({ authType: "session", scopes: null })).toBe(false);
  });

  it("does not treat messages:write as ingress authority", () => {
    expect(haltBlocksIntakeFrom({ authType: "apiKey", scopes: ["messages:write", "events:write"] })).toBe(
      true,
    );
  });

  it("refuses a caller with no scopes at all", () => {
    expect(haltBlocksIntakeFrom({ authType: "apiKey", scopes: null })).toBe(true);
  });
});
