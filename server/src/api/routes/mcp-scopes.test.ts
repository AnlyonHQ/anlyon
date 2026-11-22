import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "@anlyonhq/mcp-server";
import { expandOAuthScopes, OAUTH_SCOPE_GROUPS } from "../../core/auth/oauth-scopes.ts";

describe("MCP tool security schemes", () => {
  it("name only consent groups the consent screen offers", () => {
    const offered = new Set(Object.keys(OAUTH_SCOPE_GROUPS));
    const declared = new Set(ALL_TOOLS.flatMap((tool) => [...tool.scopes]));
    expect(declared.size).toBeGreaterThan(0);
    for (const scope of declared) expect(offered, scope).toContain(scope);
  });

  it("gate deciding on the group whose expansion is approvals:decide", () => {
    const decide = ALL_TOOLS.find((tool) => tool.name === "decide_approval");
    expect(expandOAuthScopes(decide?.scopes ?? [])).toContain("approvals:decide");
  });
});
