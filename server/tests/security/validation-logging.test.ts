import { beforeEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => [] as unknown[]);

vi.mock("../../src/lib/logger.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/logger.ts")>();
  const capture = (...args: unknown[]) => { logged.push(args); };
  const fake = { warn: capture, debug: capture, info: capture, error: capture, child: () => fake };
  return { ...actual, createLogger: () => fake };
});

const { Hono } = await import("hono");
const { z } = await import("zod");
const { validateBody } = await import("../../src/api/middleware/validation.ts");
const { buildErrorResponse } = await import("../../src/api/middleware/error.ts");

const SECRET = "sk_live_THIS_MUST_NOT_BE_LOGGED";

const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.put(
  "/secrets/:name",
  validateBody(z.object({ value: z.string(), allowedHosts: z.array(z.string()).optional() })),
  (c) => c.json({ ok: true }),
);

const put = (body: string) =>
  app.request("/secrets/STRIPE_KEY", { method: "PUT", headers: { "Content-Type": "application/json" }, body });

beforeEach(() => {
  logged.length = 0;
});

describe("validation failure logging", () => {
  it("does not log a secret value when another field is invalid", async () => {
    const response = await put(JSON.stringify({ value: SECRET, allowedHosts: "api.stripe.com" }));
    expect(response.status).toBe(400);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });

  it("does not log a secret value quoted by a JSON syntax error", async () => {
    const response = await put(`{"value": "${SECRET}" "allowedHosts": []}`);
    expect(response.status).toBe(400);
    expect(JSON.stringify(logged, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v))).not.toContain(SECRET);
  });

  it("still logs which fields were sent, to keep the failure debuggable", async () => {
    await put(JSON.stringify({ value: SECRET, allowedHosts: "api.stripe.com" }));
    expect(JSON.stringify(logged)).toContain("allowedHosts");
  });
});
