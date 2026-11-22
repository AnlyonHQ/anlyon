import { describe, expect, it } from "vitest";
import { DEFAULT_API_KEY_SCOPES } from "./api-key-scopes.ts";
import {
  ADVERTISED_OAUTH_SCOPES,
  ALL_OAUTH_SCOPES,
  DEFAULT_OAUTH_SCOPES,
  LEGACY_OAUTH_SCOPE_GROUPS,
  OAUTH_SCOPE_GROUPS,
  OFFLINE_ACCESS_SCOPE,
  OIDC_SCOPES,
  expandOAuthScopes,
  findUnknownGroupScopes,
  parseScopeClaim,
  WORKSPACE_SWITCH_SCOPE,
} from "./oauth-scopes.ts";

describe("oauth consent groups", () => {
  it("never grants a scope the API does not enforce", () => {
    expect(findUnknownGroupScopes()).toEqual([]);
  });

  it("leaves no fine-grained scope unreachable", () => {
    const covered = new Set(Object.values(OAUTH_SCOPE_GROUPS).flatMap((group) => group.scopes as readonly string[]));
    expect(DEFAULT_API_KEY_SCOPES.filter((scope) => !covered.has(scope))).toEqual([]);
  });

  it("keeps offline_access advertised", () => {
    expect(ALL_OAUTH_SCOPES).toContain(OFFLINE_ACCESS_SCOPE);
    expect(ADVERTISED_OAUTH_SCOPES).toContain(OFFLINE_ACCESS_SCOPE);
    expect(DEFAULT_OAUTH_SCOPES).toContain(OFFLINE_ACCESS_SCOPE);
  });

  it("accepts every group plus the identity scopes", () => {
    for (const group of Object.keys(OAUTH_SCOPE_GROUPS)) expect(ALL_OAUTH_SCOPES).toContain(group);
    for (const scope of OIDC_SCOPES) expect(ALL_OAUTH_SCOPES).toContain(scope);
  });

  it("advertises every group except the legacy ones", () => {
    const offered = Object.keys(OAUTH_SCOPE_GROUPS).filter((group) => !(LEGACY_OAUTH_SCOPE_GROUPS as readonly string[]).includes(group));
    expect(ADVERTISED_OAUTH_SCOPES).toEqual([...OIDC_SCOPES, ...offered]);
  });

  it("never grants a resource its label does not mention", () => {
    const declared: Record<string, string[]> = {
      "anlyon:messaging": ["dlq", "events"],
      "anlyon:actions": ["actions", "approvals", "impact-limits"],
      "anlyon:events": ["events"],
      "anlyon:approvals.decide": ["approvals"],
      "anlyon:observability": ["runs", "logs", "analytics", "billing", "notifications", "feedback"],
      "anlyon:integrations": ["integrations", "notifications"],
      "anlyon:workspace.switch": [],
      "anlyon:secrets": ["secrets"],
      "anlyon:budgets": ["budgets"],
      "anlyon:keys": [],
      "anlyon:guardrails": ["policies", "impact-limits"],
    };

    for (const [group, definition] of Object.entries(OAUTH_SCOPE_GROUPS)) {
      const allowed = declared[group];
      expect(allowed, `${group} has no declared resource list`).toBeDefined();
      const touched = [...new Set((definition.scopes as readonly string[]).map((scope) => scope.split(":")[0]))];
      expect(touched.sort(), `${group} grants a resource its description does not mention`).toEqual(
        touched.filter((resource) => allowed.includes(resource)).sort(),
      );
    }
  });
});

describe("blast radius", () => {
  const HIGH_ACCESS = ["anlyon:approvals.decide", "anlyon:secrets", "anlyon:budgets", "anlyon:keys", "anlyon:guardrails"] as const;

  it.each(HIGH_ACCESS)("keeps %s out of the default grant", (scope) => {
    expect(DEFAULT_OAUTH_SCOPES).not.toContain(scope);
  });

  it.each(HIGH_ACCESS)("marks %s sensitive so consent leaves it unticked", (scope) => {
    expect(OAUTH_SCOPE_GROUPS[scope].sensitive).toBe(true);
  });

  it("expands the default grant without approvals:decide, secrets, or budgets", () => {
    const granted = expandOAuthScopes(DEFAULT_OAUTH_SCOPES);
    expect(granted).not.toContain("approvals:decide");
    expect(granted).not.toContain("secrets:read");
    expect(granted).not.toContain("secrets:write");
    expect(granted).not.toContain("budgets:write");
  });

  it("still lets the default grant do ordinary work", () => {
    const granted = expandOAuthScopes(DEFAULT_OAUTH_SCOPES);
    expect(granted).toContain("actions:invoke");
    expect(granted).toContain("approvals:write");
    expect(granted).toContain("runs:read");
  });

  it("separates requesting an approval from deciding one", () => {
    const actions = expandOAuthScopes(["anlyon:actions"]);
    expect(actions).toContain("approvals:write");
    expect(actions).not.toContain("approvals:decide");
  });
});

describe("legacy consent groups", () => {
  it("keeps anlyon:messaging accepted but out of the default grant and discovery", () => {
    expect(LEGACY_OAUTH_SCOPE_GROUPS).toEqual(["anlyon:messaging"]);
    expect(ALL_OAUTH_SCOPES).toContain("anlyon:messaging");
    expect(DEFAULT_OAUTH_SCOPES).not.toContain("anlyon:messaging");
    expect(ADVERTISED_OAUTH_SCOPES).not.toContain("anlyon:messaging");
  });

  it("expands a group left in an unexpired token that is no longer a scope to nothing", () => {
    expect(expandOAuthScopes(["anlyon:nonsense"])).toEqual([]);
    expect(expandOAuthScopes(["anlyon:nonsense", "anlyon:events"]).sort()).toEqual(expandOAuthScopes(["anlyon:events"]).sort());
  });

  it("still offers Events, a kept product, outside the legacy messaging group", () => {
    expect(ADVERTISED_OAUTH_SCOPES).toContain("anlyon:events");
    expect(DEFAULT_OAUTH_SCOPES).toContain("anlyon:events");
    expect(expandOAuthScopes(DEFAULT_OAUTH_SCOPES)).toEqual(expect.arrayContaining(["events:read", "events:write"]));
    expect(expandOAuthScopes(["anlyon:messaging"])).toEqual(expect.arrayContaining(["events:read", "events:write"]));
  });

  it("expands the default grant to no memory, session, cache, queue or file scope", () => {
    const resources = new Set(expandOAuthScopes(DEFAULT_OAUTH_SCOPES).map((scope) => scope.split(":")[0]));
    for (const legacy of ["memory", "context", "sessions", "cache", "messages", "queues", "schedules", "workflows", "files"]) {
      expect(resources.has(legacy), legacy).toBe(false);
    }
  });
});

describe("expandOAuthScopes", () => {
  it("grants only the requested group", () => {
    const events = expandOAuthScopes(["anlyon:events"]);
    expect(events).toContain("events:read");
    expect(events).not.toContain("actions:invoke");
    expect(events).not.toContain("dlq:read");
  });

  it("unions overlapping groups without duplicating", () => {
    const granted = expandOAuthScopes(["anlyon:events", "anlyon:events", "anlyon:messaging"]);
    expect(new Set(granted).size).toBe(granted.length);
    expect(granted).toContain("events:read");
    expect(granted).toContain("dlq:read");
  });

  it("drops identity scopes, which are not permissions", () => {
    expect(expandOAuthScopes([...OIDC_SCOPES])).toEqual([]);
  });

  it("ignores scopes it does not implement rather than throwing", () => {
    expect(expandOAuthScopes(["anlyon:not-a-real-group", "root:everything"])).toEqual([]);
  });

  it("grants nothing for an empty grant", () => {
    expect(expandOAuthScopes([])).toEqual([]);
  });
});

describe("parseScopeClaim", () => {
  it("splits the space-delimited claim OAuth actually sends", () => {
    expect(parseScopeClaim("openid anlyon:actions anlyon:messaging")).toEqual([
      "openid",
      "anlyon:actions",
      "anlyon:messaging",
    ]);
  });

  it("tolerates irregular whitespace", () => {
    expect(parseScopeClaim("  openid   anlyon:actions  ")).toEqual(["openid", "anlyon:actions"]);
  });

  it("accepts an array claim", () => {
    expect(parseScopeClaim(["openid", "anlyon:events"])).toEqual(["openid", "anlyon:events"]);
  });

  it("yields nothing for a missing or malformed claim", () => {
    expect(parseScopeClaim(undefined)).toEqual([]);
    expect(parseScopeClaim(null)).toEqual([]);
    expect(parseScopeClaim("")).toEqual([]);
    expect(parseScopeClaim(42)).toEqual([]);
  });
});

describe("capability groups", () => {
  it("gates workspace switching behind an explicit, off-by-default grant", () => {
    expect(OAUTH_SCOPE_GROUPS[WORKSPACE_SWITCH_SCOPE].sensitive).toBe(true);
    expect(DEFAULT_OAUTH_SCOPES).not.toContain(WORKSPACE_SWITCH_SCOPE);
  });

  it("expands to no API scope, because no API key can switch workspace", () => {
    expect(expandOAuthScopes([WORKSPACE_SWITCH_SCOPE])).toEqual([]);
  });

  it("is still advertised, so a client can ask and a user can allow it", () => {
    expect(ALL_OAUTH_SCOPES).toContain(WORKSPACE_SWITCH_SCOPE);
  });
});
