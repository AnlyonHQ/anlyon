import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APIError } from "better-auth/api";
import { ALL_OAUTH_SCOPES } from "./oauth-scopes.ts";
import {
  refuseUnknownOAuthScopes,
  resetRetiredOAuthScopes,
  retireOAuthScopes,
  SCOPE_BEARING_PATHS,
  screenOAuthScopes,
  unknownScopesIn,
  withoutRetiredScopes,
} from "./oauth-unknown-scopes.ts";

const refusal = (ctx: Parameters<typeof refuseUnknownOAuthScopes>[0]) => {
  try {
    refuseUnknownOAuthScopes(ctx);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(APIError);
    const apiError = error as APIError;
    return { status: apiError.statusCode, body: apiError.body as { error: string; error_description: string } };
  }
};

const screenRefusal = (ctx: Parameters<typeof screenOAuthScopes>[0]): string | null => {
  try {
    screenOAuthScopes(ctx);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(APIError);
    return String((error as APIError).body?.error_description);
  }
};

describe("OAuth scopes the server does not issue", () => {
  it("finds them in a scope parameter, once each, in order", () => {
    expect(unknownScopesIn("openid anlyon:nonsense  anlyon:actions nonsense:write anlyon:nonsense")).toEqual(["anlyon:nonsense", "nonsense:write"]);
    expect(unknownScopesIn(ALL_OAUTH_SCOPES.join(" "))).toEqual([]);
    expect(unknownScopesIn("  ")).toEqual([]);
    expect(unknownScopesIn(undefined)).toEqual([]);
    expect(unknownScopesIn(["anlyon:nonsense"])).toEqual([]);
  });

  it("treats an API-key scope as unknown: OAuth grants consent groups, not fine scopes", () => {
    expect(unknownScopesIn("openid runs:read")).toEqual(["runs:read"]);
  });

  it.each(SCOPE_BEARING_PATHS.filter((path) => path !== "/oauth2/register"))("refuses one on %s with 400 invalid_scope, naming it", (path) => {
    const fromQuery = refusal({ path, query: { scope: "openid anlyon:nonsense" } });
    expect(fromQuery).toEqual({ status: 400, body: expect.objectContaining({ error: "invalid_scope" }) });
    expect(fromQuery!.body.error_description).toContain('"anlyon:nonsense"');
    const fromBody = refusal({ path, body: { scope: "nonsense:write anlyon:nonsense" } });
    expect(fromBody!.body.error_description).toContain('"nonsense:write", "anlyon:nonsense"');
  });

  it("refuses one at registration as invalid client metadata (RFC 7591)", () => {
    expect(refusal({ path: "/oauth2/register", body: { scope: "openid anlyon:nonsense" } })).toEqual({
      status: 400,
      body: expect.objectContaining({ error: "invalid_client_metadata", error_description: expect.stringContaining('"anlyon:nonsense"') }),
    });
  });

  it("keeps dropping a third-party client's own scopes at registration, so it still connects", () => {
    expect(refusal({ path: "/oauth2/register", body: { scope: "openid offline_access someclient:tools nonsense:write" } })).toBeNull();
    expect(refusal({ path: "/oauth2/register", body: { scope: "openid someclient:tools anlyon:nonsense" } })!.body.error_description).not.toContain("someclient");
  });

  describe("a consent group an extension retired", () => {
    beforeEach(() => retireOAuthScopes(["anlyon:retired"]));
    afterEach(() => resetRetiredOAuthScopes());

    it.each(["/oauth2/authorize", "/oauth2/consent", "/oauth2/token"] as const)("is dropped on %s when live scopes remain, and the rest goes on", (path) => {
      expect(screenOAuthScopes({ path, query: { client_id: "c", scope: "openid anlyon:retired anlyon:actions" } })).toEqual({
        query: { client_id: "c", scope: "openid anlyon:actions" },
      });
      expect(screenOAuthScopes({ path, body: { grant_type: "refresh_token", scope: "anlyon:retired offline_access" } })).toEqual({
        body: { grant_type: "refresh_token", scope: "offline_access" },
      });
    });

    it("is refused by name when nothing else is asked for: there is nothing left to grant", () => {
      expect(screenRefusal({ path: "/oauth2/token", body: { scope: "anlyon:retired" } })).toMatch(/"anlyon:retired" is not a scope Anlyon issues/);
    });

    it("does not excuse another unknown scope beside it", () => {
      expect(screenRefusal({ path: "/oauth2/authorize", query: { scope: "openid anlyon:retired anlyon:nonsense" } })).toMatch(/"anlyon:nonsense"/);
    });

    it("is still refused at registration: a new client should be told", () => {
      expect(screenRefusal({ path: "/oauth2/register", body: { scope: "openid anlyon:retired" } })).toMatch(/"anlyon:retired"/);
    });

    it("never retires a scope we issue", () => {
      retireOAuthScopes(["anlyon:actions"]);
      expect(withoutRetiredScopes("openid anlyon:actions")).toBeUndefined();
    });

    it("leaves a request with no retired group untouched", () => {
      expect(screenOAuthScopes({ path: "/oauth2/authorize", query: { scope: "openid anlyon:actions" } })).toBeUndefined();
      expect(screenOAuthScopes({ path: "/sign-in/email", body: { scope: "anlyon:retired" } })).toBeUndefined();
    });
  });

  it("without a retired group, refuses one by name everywhere (the self-hosted default)", () => {
    expect(screenRefusal({ path: "/oauth2/token", body: { scope: "openid anlyon:retired" } })).toMatch(/"anlyon:retired"/);
  });

  it("lets every issued scope, and other endpoints, through", () => {
    expect(refusal({ path: "/oauth2/authorize", query: { scope: ALL_OAUTH_SCOPES.join(" ") } })).toBeNull();
    expect(refusal({ path: "/oauth2/token", body: { grant_type: "refresh_token" } })).toBeNull();
    expect(refusal({ path: "/sign-in/email", body: { scope: "anlyon:nonsense" } })).toBeNull();
  });
});
