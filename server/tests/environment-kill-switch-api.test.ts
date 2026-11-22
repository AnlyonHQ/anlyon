import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const haltEnvironment = vi.fn();
const resumeEnvironment = vi.fn();
const getEnvironment = vi.fn();

vi.mock("../src/core/environments/halt.ts", () => ({
  haltEnvironment: (...a: unknown[]) => haltEnvironment(...a),
  resumeEnvironment: (...a: unknown[]) => resumeEnvironment(...a),
  isEnvironmentHalted: vi.fn().mockResolvedValue(false),
}));

vi.mock("../src/core/environments/service.ts", () => ({
  getEnvironment: (...a: unknown[]) => getEnvironment(...a),
  toPublicEnvironment: (env: unknown) => env,
}));

vi.mock("../src/api/middleware/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/middleware/auth.ts")>();
  return { ...actual, requireApiKey: async (_c: unknown, next: () => Promise<void>) => next() };
});

vi.mock("../src/api/middleware/rateLimit.ts", () => ({
  rateLimitByWorkspace: async (_c: unknown, next: () => Promise<void>) => next(),
}));

const environmentRouter = (await import("../src/api/routes/environment.ts")).default;

const ENV = { id: "env_staging", slug: "staging", halted: true };

function app(scopes: string[]) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("authType", "apiKey");
    c.set("apiKeyId", "key_1");
    c.set("workspaceId", "ws_1");
    c.set("environmentId", "env_staging");
    c.set("apiKeyScopes", scopes);
    await next();
  });
  a.route("/", environmentRouter);
  a.onError((err, c) => c.json({ error: err.message }, 403));
  return a;
}

const OPERATOR = ["environments:halt"];
const AGENT = ["actions:invoke", "events:write"];

beforeEach(() => {
  vi.clearAllMocks();
  haltEnvironment.mockResolvedValue(ENV);
  resumeEnvironment.mockResolvedValue({ ...ENV, halted: false });
  getEnvironment.mockResolvedValue(ENV);
});

describe("halting", () => {
  it("halts the environment the key is bound to, never one it names", async () => {
    const response = await app(OPERATOR).request("/halt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "runaway refunds" }),
    });

    expect(response.status).toBe(200);
    expect(haltEnvironment).toHaveBeenCalledWith(
      "ws_1",
      "env_staging",
      expect.objectContaining({ reason: "runaway refunds" }),
    );
  });

  it("attributes the halt to the key that pulled it", async () => {
    await app(OPERATOR).request("/halt", { method: "POST" });

    expect(haltEnvironment).toHaveBeenCalledWith(
      "ws_1",
      "env_staging",
      expect.objectContaining({ actor: "key:key_1" }),
    );
  });

  it("refuses a key without environments:halt", async () => {
    const response = await app(AGENT).request("/halt", { method: "POST" });

    expect(response.status).toBe(403);
    expect(haltEnvironment).not.toHaveBeenCalled();
  });
});

describe("resuming", () => {
  it("works while the environment is halted  the switch must not disable its own undo", async () => {
    const response = await app(OPERATOR).request("/resume", { method: "POST" });

    expect(response.status).toBe(200);
    expect(resumeEnvironment).toHaveBeenCalledWith("ws_1", "env_staging", expect.objectContaining({
      actor: "key:key_1",
    }));
  });

  it("refuses a key without environments:halt", async () => {
    const response = await app(AGENT).request("/resume", { method: "POST" });

    expect(response.status).toBe(403);
    expect(resumeEnvironment).not.toHaveBeenCalled();
  });
});

describe("reading state", () => {
  it("lets any valid key see whether its own environment is halted", async () => {
    const response = await app(AGENT).request("/");

    expect(response.status).toBe(200);
    expect(getEnvironment).toHaveBeenCalledWith("ws_1", "env_staging");
  });
});
