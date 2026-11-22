import { describe, it, expect } from "vitest";
import {
  ALL_API_KEY_SCOPES,
  DEFAULT_API_KEY_SCOPES,
  PRIVILEGED_API_KEY_SCOPES,
  isApiKeyScope,
  liveApiKeyScopes,
} from "./api-key-scopes.ts";
import { OAUTH_SCOPE_GROUPS } from "./oauth-scopes.ts";

describe("the default set", () => {
  it("grants no privileged scope", () => {
    const granted = new Set<string>(DEFAULT_API_KEY_SCOPES);
    expect(PRIVILEGED_API_KEY_SCOPES.filter((scope) => granted.has(scope))).toEqual([]);
  });

  it("still covers ordinary agent work", () => {
    for (const scope of [
      "actions:read",
      "actions:invoke",
      "approvals:read",
      "approvals:write",
      "runs:write",
      "events:write",
    ] as const) {
      expect(DEFAULT_API_KEY_SCOPES).toContain(scope);
    }
  });

  it("partitions the enforced set  every scope is default or privileged, never both", () => {
    expect([...DEFAULT_API_KEY_SCOPES, ...PRIVILEGED_API_KEY_SCOPES].sort()).toEqual(
      [...ALL_API_KEY_SCOPES].sort()
    );
  });

  it("recognises exactly the scopes it enforces", () => {
    for (const scope of ALL_API_KEY_SCOPES) expect(isApiKeyScope(scope)).toBe(true);
    for (const scope of ["nonsense:write", "runs", "RUNS:READ", ""]) expect(isApiKeyScope(scope)).toBe(false);
  });

  it("reports only live scopes from a stored list, in order, keeping an empty list empty", () => {
    expect(liveApiKeyScopes(["nonsense:write", "runs:read", "nonsense:read", "actions:invoke"])).toEqual(["runs:read", "actions:invoke"]);
    expect(liveApiKeyScopes(["nonsense:write"])).toEqual([]);
    expect(liveApiKeyScopes([])).toEqual([]);
  });
});

describe("privileged matches the consent screen's own judgement", () => {
  it("is exactly the sensitive OAuth groups, plus the scopes no group offers", () => {
    const sensitive = new Set<string>(
      Object.values(OAUTH_SCOPE_GROUPS)
        .filter((group) => group.sensitive)
        .flatMap((group) => group.scopes as readonly string[])
    );

    const ungrouped = new Set<string>(
      Object.values(OAUTH_SCOPE_GROUPS).flatMap((group) => group.scopes as readonly string[])
    );

    for (const scope of PRIVILEGED_API_KEY_SCOPES) {
      expect(sensitive.has(scope) || !ungrouped.has(scope)).toBe(true);
    }

    expect(DEFAULT_API_KEY_SCOPES.filter((scope) => sensitive.has(scope))).toEqual([]);
  });
});
