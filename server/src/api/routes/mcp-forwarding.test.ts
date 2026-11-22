import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../config/env.ts";

const mocks = vi.hoisted(() => ({
  run: vi.fn((_: unknown, callback: () => Response | Promise<Response>) => callback()),
}));

vi.mock("@anlyonhq/mcp-server", () => ({
  createServer: () => ({ connect: vi.fn(async () => undefined) }),
  requestContext: { run: mocks.run },
  hiddenOutsideGrant: () => () => false,
  ALL_TOOLS: [],
}));

vi.mock("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", () => ({
  WebStandardStreamableHTTPServerTransport: class {
    handleRequest = vi.fn(async () => new Response(null, { status: 204 }));
  },
}));

vi.mock("../mcp-bearer.ts", () => ({
  mcpHandler:
    (_: unknown, serve: (request: Request, jwt: Record<string, unknown>) => Promise<Response>) =>
    (request: Request) =>
      serve(request, { sub: "user_1", scope: "anlyon:memory" }),
}));

vi.mock("../../core/auth/oauth-tokens.ts", () => ({
  clientIdOf: () => "client_1",
  hasActiveConsent: vi.fn(async () => true),
}));

vi.mock("../../db/index.ts", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
  },
}));

import mcpRouter from "./mcp.ts";

describe("hosted MCP forwarding", () => {
  beforeEach(() => {
    mocks.run.mockClear();
  });

  it("forwards tool calls to the API origin that authenticated the request", async () => {
    const response = await mcpRouter.request("/", {
      method: "POST",
      headers: {
        Authorization: "Bearer local.oauth.token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(204);
    expect(mocks.run).toHaveBeenCalledWith(
      {
        apiKey: "local.oauth.token",
        cacheScope: "user_1:client_1",
        apiBaseUrl: env.BETTER_AUTH_URL,
      },
      expect.any(Function),
    );
  });
});
