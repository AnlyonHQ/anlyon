import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requestId, resolveRequestId } from "./request-id.ts";

function testApp(): Hono {
  const app = new Hono();
  app.use("*", requestId);
  app.get("/", (c) => c.json({ requestId: c.get("requestId") }));
  return app;
}

describe("requestId middleware", () => {
  it("generates and returns a request ID", async () => {
    const response = await testApp().request("/");
    const body = await response.json();

    expect(response.headers.get("x-request-id")).toMatch(/^req_[a-f0-9]{32}$/);
    expect(body.requestId).toBe(response.headers.get("x-request-id"));
  });

  it("preserves a safe caller-provided request ID", async () => {
    const response = await testApp().request("/", {
      headers: { "X-Request-Id": "customer-trace_123" },
    });

    expect(response.headers.get("x-request-id")).toBe("customer-trace_123");
    expect(await response.json()).toEqual({ requestId: "customer-trace_123" });
  });

  it("replaces unsafe or oversized IDs", () => {
    expect(resolveRequestId("contains spaces")).toMatch(/^req_[a-f0-9]{32}$/);
    expect(resolveRequestId("x".repeat(129))).toMatch(/^req_[a-f0-9]{32}$/);
  });
});
