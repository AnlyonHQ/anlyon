import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { buildErrorResponse } from "../src/api/middleware/error.ts";
import publicSandboxRouter, { SANDBOX_MAX_BODY_BYTES } from "../src/api/routes/public-sandbox.ts";

function app(): Hono {
  const root = new Hono();
  root.onError((caught, c) => buildErrorResponse(caught, c));
  root.route("/sandbox", publicSandboxRouter);
  return root;
}

describe("public sandbox echo (first-run tour destination)", () => {
  it("answers with what it received, Authorization included", async () => {
    const response = await app().request("/sandbox/echo", {
      method: "POST",
      headers: { Authorization: "Bearer demo_sk_123456", "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: "ord_1042", amount: 4900 }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { data } = await response.json();
    expect(data).toMatchObject({
      method: "POST",
      authorization: "Bearer demo_sk_123456",
      contentType: "application/json",
      body: { orderId: "ord_1042", amount: 4900 },
    });
    expect(Date.parse(data.receivedAt)).not.toBeNaN();
  });

  it("keeps a body that is not JSON as text, and an empty one as null", async () => {
    const text = await app().request("/sandbox/echo", { method: "POST", body: "orderId=ord_1042" });
    expect((await text.json()).data.body).toBe("orderId=ord_1042");
    const empty = await app().request("/sandbox/echo", { method: "POST" });
    expect((await empty.json()).data).toMatchObject({ body: null, authorization: null });
  });

  it("refuses bodies over 16 KB", async () => {
    const response = await app().request("/sandbox/echo", {
      method: "POST",
      body: "x".repeat(SANDBOX_MAX_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});
