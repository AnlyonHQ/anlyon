import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { refuseUnknownApiKeyScopes } from "./scope-input.ts";
import { validateBody } from "./middleware/validation.ts";
import { createApiKeySchema } from "../utils/validation.ts";
import { ApiError } from "../utils/errors.ts";

const app = new Hono();
app.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json({ success: false, error: { code: error.code, message: error.message, details: error.details } }, error.statusCode as 400);
  }
  return c.json({ success: false }, 500);
});
app.post("/keys", refuseUnknownApiKeyScopes, validateBody(createApiKeySchema), (c) => c.json({ success: true, data: c.get("validatedBody") }));

const post = (body: unknown) => app.request("/keys", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("scopes a key is created with", () => {
  it("refuses one Anlyon does not grant: 400 INVALID_SCOPE naming each, in details.invalidScopes", async () => {
    const response = await post({ name: "k", scopes: ["runs:read", "nonsense:write", "nonsense:read", "nonsense:write"] });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { success: boolean; error: { code: string; message: string; details: { invalidScopes: string[] } } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("INVALID_SCOPE");
    expect(body.error.message).toBe('"nonsense:write", "nonsense:read" are not scopes Anlyon grants. Remove them from "scopes".');
    expect(body.error.details.invalidScopes).toEqual(["nonsense:write", "nonsense:read"]);
  });

  it("names a single one in the singular", async () => {
    const body = (await (await post({ name: "k", scopes: ["nonsense:write"] })).json()) as { error: { message: string } };
    expect(body.error.message).toBe('"nonsense:write" is not a scope Anlyon grants. Remove it from "scopes".');
  });

  it("lets live scopes through, and leaves other malformed bodies to the ordinary validation error", async () => {
    expect((await post({ name: "k", scopes: ["runs:read", "actions:invoke"] })).status).toBe(200);
    for (const body of [{ name: "k", scopes: [42] }, { name: "k", scopes: "runs:read" }, "not json", { name: "" }]) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
    }
  });
});
