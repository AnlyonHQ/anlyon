import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../config/env.ts";

const mocks = vi.hoisted(() => ({
  run: vi.fn((_: unknown, callback: () => Response | Promise<Response>) => callback()),
  createServer: vi.fn((_options: unknown) => ({ connect: vi.fn(async () => undefined) })),
  verifyApiKey: vi.fn(),
}));

vi.mock("@anlyonhq/mcp-server", () => ({
  createServer: mocks.createServer,
  requestContext: { run: mocks.run },
  hiddenOutsideGrant: () => () => false,
  ALL_TOOLS: [
    "list_actions",
    "invoke_action",
    "request_approval",
    "check_approval",
    "wait_for_approval",
    "list_pending_approvals",
    "decide_approval",
    "list_workspaces",
    "select_workspace",
  ].map((name) => ({ name })),
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
      serve(request, { sub: "user_1", scope: "anlyon:actions" }),
}));

vi.mock("../../core/auth/oauth-tokens.ts", () => ({
  clientIdOf: () => "client_1",
  hasActiveConsent: vi.fn(async () => true),
}));

vi.mock("../../core/auth/api-keys.ts", () => ({
  verifyApiKeyAndGetWorkspace: mocks.verifyApiKey,
}));

vi.mock("../../db/index.ts", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) },
}));

import { AuthenticationError } from "../../utils/errors.ts";
import mcpRouter from "./mcp.ts";
import { PACK_SERVERS } from "./mcp-packs.ts";

const KEY = "anlyon_live_serverside";

const key = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: "ws_1",
  keyId: "key_1",
  environmentId: "env_1",
  scopes: ["actions:read", "actions:invoke"],
  expiresAt: null,
  endUserRequired: false,
  ...overrides,
});

const post = (path: string, headers: Record<string, string>) =>
  mcpRouter.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

const errorCode = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code;

type Options = { hiddenTools: (name: string) => boolean; actions?: (actionName: string) => boolean };
const lastOptions = () => mocks.createServer.mock.calls.at(-1)![0] as Options;

beforeEach(() => {
  mocks.run.mockClear();
  mocks.createServer.mockClear();
  mocks.verifyApiKey.mockReset();
  mocks.verifyApiKey.mockResolvedValue(key());
});

describe("an API key on /mcp", () => {
  it("serves the tools with the key as their credential", async () => {
    const response = await post("/", { Authorization: `Bearer ${KEY}` });

    expect(response.status).toBe(204);
    expect(mocks.verifyApiKey).toHaveBeenCalledWith(KEY);
    expect(mocks.run).toHaveBeenCalledWith(
      { apiKey: KEY, cacheScope: "apikey:key_1", apiBaseUrl: env.BETTER_AUTH_URL },
      expect.any(Function),
    );
  });

  it("fixes the end user named by Anlyon-End-User for the whole connection", async () => {
    const response = await post("/", { Authorization: `Bearer ${KEY}`, "Anlyon-End-User": "user_a" });

    expect(response.status).toBe(204);
    expect(mocks.run).toHaveBeenCalledWith(
      { apiKey: KEY, cacheScope: "apikey:key_1", apiBaseUrl: env.BETTER_AUTH_URL, endUserId: "user_a" },
      expect.any(Function),
    );
  });

  it("keeps two end users' connections apart", async () => {
    await Promise.all([
      post("/", { Authorization: `Bearer ${KEY}`, "Anlyon-End-User": "user_a" }),
      post("/", { Authorization: `Bearer ${KEY}`, "Anlyon-End-User": "user_b" }),
    ]);

    const contexts = mocks.run.mock.calls.map(([context]) => (context as { endUserId?: string }).endUserId).sort();
    expect(contexts).toEqual(["user_a", "user_b"]);
  });

  it("refuses a malformed end-user id with 400 INVALID_END_USER", async () => {
    const response = await post("/", { Authorization: `Bearer ${KEY}`, "Anlyon-End-User": "not a valid id" });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("INVALID_END_USER");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("refuses a key that requires an end user and named none with 400 END_USER_REQUIRED", async () => {
    mocks.verifyApiKey.mockResolvedValue(key({ endUserRequired: true }));
    const response = await post("/", { Authorization: `Bearer ${KEY}` });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("END_USER_REQUIRED");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("serves a key that requires an end user when it names one", async () => {
    mocks.verifyApiKey.mockResolvedValue(key({ endUserRequired: true }));
    const response = await post("/", { Authorization: `Bearer ${KEY}`, "Anlyon-End-User": "user_a" });

    expect(response.status).toBe(204);
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ endUserId: "user_a" }), expect.any(Function));
  });

  it("refuses an unknown key with the 401 that names the resource metadata", async () => {
    mocks.verifyApiKey.mockRejectedValue(new AuthenticationError("Authentication failed"));
    const response = await post("/", { Authorization: `Bearer ${KEY}` });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer resource_metadata="/);
  });

  it("answers 503, not 401, when the key cannot be checked", async () => {
    mocks.verifyApiKey.mockRejectedValue(new Error("redis down"));
    const response = await post("/", { Authorization: `Bearer ${KEY}` });

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("SERVICE_UNAVAILABLE");
  });
});

describe("an OAuth token on /mcp", () => {
  it("refuses Anlyon-End-User with 400 END_USER_HEADER_NOT_ALLOWED", async () => {
    const response = await post("/", { Authorization: "Bearer local.oauth.token", "Anlyon-End-User": "user_a" });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("END_USER_HEADER_NOT_ALLOWED");
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.verifyApiKey).not.toHaveBeenCalled();
  });

  it("serves without an end user otherwise", async () => {
    const response = await post("/", { Authorization: "Bearer local.oauth.token" });

    expect(response.status).toBe(204);
    expect(mocks.run).toHaveBeenCalledWith(
      { apiKey: "local.oauth.token", cacheScope: "user_1:client_1", apiBaseUrl: env.BETTER_AUTH_URL },
      expect.any(Function),
    );
  });
});

describe("one MCP server per integration", () => {
  it("has a server for GitHub", () => {
    expect(PACK_SERVERS.get("github")).toEqual({ pack: "anlyon/github", name: "github", displayName: "GitHub" });
  });

  it("serves only that pack's actions, plus the approval follow-up tools", async () => {
    const response = await post("/github", { Authorization: `Bearer ${KEY}`, "Anlyon-End-User": "user_a" });

    expect(response.status).toBe(204);
    const options = lastOptions();
    expect(options.actions?.("github-create-issue")).toBe(true);
    expect(options.actions?.("hubspot-create-contact")).toBe(false);
    expect(options.actions?.("githubby-thing")).toBe(false);
    for (const tool of ["check_approval", "wait_for_approval"]) expect(options.hiddenTools(tool), tool).toBe(false);
    for (const tool of ["list_actions", "invoke_action", "request_approval", "decide_approval", "select_workspace"]) {
      expect(options.hiddenTools(tool), tool).toBe(true);
    }
    expect(options.hiddenTools("action_github-create-issue")).toBe(false);
  });

  it("applies the same end-user rules as /mcp", async () => {
    expect((await post("/github", { Authorization: "Bearer local.oauth.token", "Anlyon-End-User": "user_a" })).status).toBe(400);

    mocks.verifyApiKey.mockResolvedValue(key({ endUserRequired: true }));
    const response = await post("/github", { Authorization: `Bearer ${KEY}` });
    expect(await errorCode(response)).toBe("END_USER_REQUIRED");

    await post("/github", { Authorization: `Bearer ${KEY}`, "Anlyon-End-User": "user_b" });
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ endUserId: "user_b" }), expect.any(Function));
  });

  it("serves OAuth callers too, narrowed the same way", async () => {
    const response = await post("/github", { Authorization: "Bearer local.oauth.token" });

    expect(response.status).toBe(204);
    expect(lastOptions().actions?.("github-merge-pull-request")).toBe(true);
    expect(lastOptions().hiddenTools("invoke_action")).toBe(true);
  });

  it("answers 404 for a name that is not an integration's server, before any credential check", async () => {
    const response = await post("/nope", { Authorization: `Bearer ${KEY}` });

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("NOT_FOUND");
    expect(mocks.verifyApiKey).not.toHaveBeenCalled();
  });

  it("describes itself on GET", async () => {
    const response = await mcpRouter.request("/github");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "anlyon-github", integration: "GitHub", pack: "anlyon/github" });
  });
});
