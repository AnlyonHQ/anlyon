import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError, AuthorizationError, ValidationError } from "../../utils/errors.ts";
import { EndUserConnectionError } from "../../core/end-users/errors.ts";
import { env } from "../../config/env.ts";
import { buildErrorResponse } from "./error.ts";
import { requestId } from "./request-id.ts";

function errorApp(error: unknown): Hono {
  const app = new Hono();
  app.use("*", requestId);
  app.onError((caught, c) => buildErrorResponse(caught, c));
  app.get("/", () => {
    throw error;
  });
  return app;
}

describe("API error correlation", () => {
  it("returns the same request ID in the header and a typed API error", async () => {
    const response = await errorApp(new ValidationError("Invalid input")).request("/", {
      headers: { "X-Request-Id": "test-request-123" },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("test-request-123");
    expect(body).toMatchObject({
      success: false,
      requestId: "test-request-123",
      error: { code: "VALIDATION_ERROR", message: "Invalid input" },
    });
  });

  it("does not expose unexpected error details", async () => {
    const response = await errorApp(new Error("database password leaked")).request("/");
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred",
    });
    expect(body.requestId).toBe(response.headers.get("x-request-id"));
    expect(JSON.stringify(body)).not.toContain("database password leaked");
  });
});

function errorAppAs(error: unknown, authType: string): Hono {
  const app = new Hono();
  app.use("*", requestId);
  app.use("*", async (c, next) => {
    c.set("authType" as never, authType as never);
    await next();
  });
  app.onError((caught, c) => buildErrorResponse(caught, c));
  app.get("/", () => {
    throw error;
  });
  return app;
}

function missingScope(scope: string): AuthorizationError {
  const error = new AuthorizationError(`This authorization is missing required scope: ${scope}`);
  error.details = { requiredScope: scope };
  return error;
}

describe("error.fix", () => {
  it("adds only the fix to an ApiError response: same keys, same values", async () => {
    const response = await errorAppAs(missingScope("secrets:write"), "oauth").request("/", {
      headers: { "X-Request-Id": "req-fix" },
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(Object.keys(body)).toEqual(["success", "error", "requestId"]);
    expect(body).toEqual({
      success: false,
      requestId: "req-fix",
      error: {
        code: "AUTHORIZATION_ERROR",
        message: "This authorization is missing required scope: secrets:write",
        details: { requiredScope: "secrets:write" },
        fix: expect.objectContaining({ command: "anlyon auth login --scope anlyon:secrets" }),
      },
    });
  });

  it("keeps the fix when production drops details", async () => {
    const previous = env.NODE_ENV;
    (env as { NODE_ENV: string }).NODE_ENV = "production";
    try {
      const response = await errorAppAs(missingScope("actions:govern"), "oauth").request("/");
      const body = await response.json();
      expect(body.error.details).toBeUndefined();
      expect(body.error.fix).toMatchObject({ url: `${env.CONSOLE_URL.replace(/\/$/, "")}/settings/api-keys` });
      expect(body.error.fix.summary).toContain("actions:govern");
    } finally {
      (env as { NODE_ENV: string }).NODE_ENV = previous;
    }
  });

  it("uses a fix set where the error was thrown", async () => {
    const error = new ApiError(409, "ENVIRONMENT_HALTED", "halted");
    error.fix = { summary: "Wait for the incident to end." };
    const body = await (await errorApp(error).request("/")).json();
    expect(body.error.fix).toEqual({ summary: "Wait for the incident to end." });
  });

  it("adds nothing for a code without a fix", async () => {
    const body = await (await errorApp(new ApiError(409, "CONFLICT", "taken")).request("/")).json();
    expect(body.error).toEqual({ code: "CONFLICT", message: "taken" });
  });

  it("adds a fix to a zod validation error", async () => {
    const parsed = z.object({ name: z.string() }).safeParse({});
    const body = await (await errorApp(parsed.error).request("/")).json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("Validation failed");
    expect(body.error.fix).toMatchObject({ docs: "https://docs.anlyon.com/api-reference" });
  });

  it("keeps the end-user connection fields beside the fix", async () => {
    const error = new EndUserConnectionError("END_USER_NOT_CONNECTED", "gmail", "u1", { url: "https://connect.test/x", expiresAt: new Date(0) }, "Connect Gmail.");
    const body = await (await errorApp(error).request("/")).json();
    expect(body.error).toMatchObject({ code: "END_USER_NOT_CONNECTED", integration: "gmail", endUserId: "u1", connectUrl: "https://connect.test/x" });
    expect(body.error.fix.summary).toContain("connectUrl");
  });
});
