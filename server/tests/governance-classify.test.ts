import { describe, expect, it } from "vitest";
import {
  ACTION_UPDATE_RULES,
  classifyMcpToolAdopt,
  classifyMcpUpstreamArchive,
  classifyMcpUpstreamRefresh,
  classifyMcpUpstreamRegister,
  BUDGET_PUT_RULES,
  ENVIRONMENT_UPDATE_RULES,
  GOVERNANCE_OPERATIONS,
  IMPACT_LIMIT_UPDATE_RULES,
  POLICY_CREATE_FIELDS,
  POLICY_UPDATE_FIELDS,
  REDACTED,
  SECRET_PUT_RULES,
  WORKSPACE_DEFAULTS_RULES,
  atLeastAsStrict,
  classifyActionCreate,
  classifyActionDelete,
  classifyActionImport,
  classifyActionUpdate,
  classifyApiKeyCreate,
  classifyBudgetDelete,
  classifyBudgetPut,
  classifyEnvironmentUpdate,
  classifyFields,
  classifyHalt,
  classifyImpactLimitArchive,
  classifyImpactLimitCreate,
  classifyImpactLimitUpdate,
  classifyOAuthAppDelete,
  classifyOAuthAppPut,
  classifyPolicyCreate,
  classifyPolicyDelete,
  classifyPolicyFile,
  classifyPolicyUpdate,
  classifyResume,
  classifySecretDelete,
  classifySecretPut,
  classifySecretStoreCreate,
  classifySecretStoreDelete,
  classifySecretStoreSettings,
  classifySecretStoreUpdate,
  classifyWorkspaceDefaults,
  hostCovers,
  renderDiff,
  type PolicyState,
} from "../src/core/governance/classify.ts";
import { OPERATIONS } from "../src/core/governance/operations.ts";
import {
  createActionSchema,
  createEnvironmentApprovalPolicySchema,
  putBudgetSchema,
  putSecretSchema,
  updateActionSchema,
  updateEnvironmentApprovalPolicySchema,
  updateEnvironmentSchema,
  updateImpactLimitSchema,
  updateWorkspaceDefaultsSchema,
} from "../src/utils/validation.ts";

const keys = (schema: unknown) => Object.keys((schema as { shape: Record<string, unknown> }).shape).sort();
const fields = (table: object) => Object.keys(table).sort();

describe("every request field is classified", () => {
  it.each([
    ["PATCH /impact-limits/:id", updateImpactLimitSchema, IMPACT_LIMIT_UPDATE_RULES],
    ["PUT /budgets/:apiKeyId", putBudgetSchema, BUDGET_PUT_RULES],
    ["POST /actions", createActionSchema, ACTION_UPDATE_RULES],
    ["PATCH /actions/:ref", updateActionSchema, ACTION_UPDATE_RULES],
    ["PUT /secrets/:name", putSecretSchema, SECRET_PUT_RULES],
    ["POST /approval-policies", createEnvironmentApprovalPolicySchema, POLICY_CREATE_FIELDS],
    ["PATCH /approval-policies/:id", updateEnvironmentApprovalPolicySchema, POLICY_UPDATE_FIELDS],
    ["PATCH /workspaces/:id/environments/:id", updateEnvironmentSchema, ENVIRONMENT_UPDATE_RULES],
    ["PATCH /workspaces/:id/defaults", updateWorkspaceDefaultsSchema, WORKSPACE_DEFAULTS_RULES],
  ] as const)("%s: the rule table names exactly the body's fields", (_route, schema, table) => {
    expect(fields(table)).toEqual(keys(schema));
  });

  it("treats a field with no rule as loosening, whatever its value", () => {
    const changes = classifyFields({ name: () => ({ direction: "neutral", reason: "" }) } as never, { name: "a" }, { name: "b", surprise: false } as never);
    expect(changes.find((c) => c.field === "surprise")).toMatchObject({ direction: "loosening" });
  });

  it("treats an unknown policy field as loosening", () => {
    const c = classifyPolicyCreate({ name: "p", matchKind: "any", effect: "auto_deny", surprise: 1 } as never, []);
    expect(c.direction).toBe("loosening");
  });

  it("treats an unknown action field as loosening, even on a disabled action", () => {
    expect(classifyActionCreate({ name: "a", enabled: false, surprise: 1 } as never).direction).toBe("loosening");
  });

  it("has a sign-off definition for every operation a credential route can loosen", () => {
    const consoleOnly = [
      "api_key.create", "environment.update", "workspace_defaults.update",
      "mcp_upstream.connect",
    ];
    const neverLoosens = ["impact_limit.create", "environment.halt", "action.delete", "secret.delete", "secret_store.delete", "oauth_app.delete", "mcp_upstream.archive"];
    for (const op of GOVERNANCE_OPERATIONS) {
      if (consoleOnly.includes(op) || neverLoosens.includes(op)) {
        expect(OPERATIONS[op], op).toBeUndefined();
      } else {
        expect(OPERATIONS[op], op).toBeDefined();
      }
    }
  });
});

describe("impact limits", () => {
  const limit = { name: "Daily refunds", amount: 500, archived: false };

  it("creating one tightens", () => {
    expect(classifyImpactLimitCreate(limit).direction).toBe("tightening");
  });

  it.each([
    [{ amount: 1000 }, "loosening"],
    [{ amount: 100 }, "tightening"],
    [{ amount: 500 }, "tightening"],
    [{ name: "Renamed" }, "tightening"],
    [{ name: "Renamed", amount: 501 }, "loosening"],
  ] as const)("update %j is %s", (patch, direction) => {
    expect(classifyImpactLimitUpdate(limit, patch).direction).toBe(direction);
  });

  it("archiving a live limit loosens; archiving an archived one changes nothing", () => {
    expect(classifyImpactLimitArchive(limit).direction).toBe("loosening");
    expect(classifyImpactLimitArchive({ ...limit, archived: true })).toEqual({ direction: "tightening", changes: [] });
  });
});

describe("budgets", () => {
  const budget = { monthlyCostCentsCap: 1000, dimensionCaps: { refunds: 10 }, alertThreshold: 0.8, enabled: true };

  it.each([
    [{ monthlyCostCentsCap: 2000 }, "loosening"],
    [{ monthlyCostCentsCap: null }, "loosening"],
    [{ monthlyCostCentsCap: 500 }, "tightening"],
    [{ dimensionCaps: { refunds: 20 } }, "loosening"],
    [{ dimensionCaps: {} }, "loosening"],
    [{ dimensionCaps: { refunds: 5, emails: 3 } }, "tightening"],
    [{ alertThreshold: 0.9 }, "loosening"],
    [{ alertThreshold: 0.5 }, "tightening"],
    [{ enabled: false }, "loosening"],
  ] as const)("put %j over an existing budget is %s", (patch, direction) => {
    expect(classifyBudgetPut(budget, patch as never).direction).toBe(direction);
  });

  it("a new budget with a cap tightens; a new budget switched off changes nothing that loosens", () => {
    expect(classifyBudgetPut(null, { monthlyCostCentsCap: 100 }).direction).toBe("tightening");
    expect(classifyBudgetPut(null, { monthlyCostCentsCap: 100, enabled: false }).direction).toBe("tightening");
  });

  it("removing a budget that is on loosens; removing none or an off one does not", () => {
    expect(classifyBudgetDelete(budget).direction).toBe("loosening");
    expect(classifyBudgetDelete({ ...budget, enabled: false }).direction).toBe("tightening");
    expect(classifyBudgetDelete(null).direction).toBe("tightening");
  });
});

describe("halt and resume", () => {
  it("halting tightens, resuming a halted environment loosens", () => {
    expect(classifyHalt({ halted: false }).direction).toBe("tightening");
    expect(classifyResume({ halted: true }).direction).toBe("loosening");
    expect(classifyResume({ halted: false }).changes).toEqual([]);
  });
});

describe("approval policies", () => {
  let n = 0;
  const policy = (over: Partial<PolicyState> = {}): PolicyState => ({
    policyId: `pol_${++n}`, name: `p${n}`, effect: "require_approval", requiredApprovals: 1, decidedBy: "team",
    priority: 100, enabled: true, createdAt: n, matchKind: "action", matchActionName: "refund", matchAgentId: null,
    matchUserId: null, matchTags: null, minAmount: null, conditions: null, condition: null, ...over,
  });

  it("orders outcomes: deny, then more approvals, then auto-approve; a different decider is never stricter", () => {
    const req = (requiredApprovals: number, decidedBy: "team" | "end_user" = "team") => ({ effect: "require_approval" as const, requiredApprovals, decidedBy });
    expect(atLeastAsStrict({ effect: "auto_deny", requiredApprovals: 1, decidedBy: "team" }, req(3))).toBe(true);
    expect(atLeastAsStrict(req(2), req(1))).toBe(true);
    expect(atLeastAsStrict(req(1), req(2))).toBe(false);
    expect(atLeastAsStrict(req(1), { effect: "auto_approve", requiredApprovals: 1, decidedBy: "team" })).toBe(true);
    expect(atLeastAsStrict(req(1, "end_user"), req(1, "team"))).toBe(false);
  });

  it.each([
    [{ effect: "auto_deny" }, "tightening"],
    [{ effect: "require_approval" }, "tightening"],
    [{ effect: "require_approval", requiredApprovals: 2 }, "tightening"],
    [{ effect: "auto_approve" }, "loosening"],
    [{ effect: "require_approval", decidedBy: "end_user" }, "loosening"],
    [{ effect: "auto_approve", enabled: false }, "tightening"],
  ] as const)("creating %j with no other policy is %s", (over, direction) => {
    expect(classifyPolicyCreate({ name: "new", matchKind: "action", matchActionName: "refund", ...over }, []).direction).toBe(direction);
  });

  it("creating a policy that runs before a stricter one loosens", () => {
    const strict = policy({ effect: "require_approval", requiredApprovals: 2, priority: 100 });
    expect(classifyPolicyCreate({ name: "early", matchKind: "action", matchActionName: "refund", priority: 10 }, [strict]).direction).toBe("loosening");
    expect(classifyPolicyCreate({ name: "late", matchKind: "action", matchActionName: "refund", priority: 100 }, [strict]).direction).toBe("tightening");
  });

  it.each([
    [{ effect: "auto_approve" }, "loosening"],
    [{ effect: "auto_deny" }, "tightening"],
    [{ requiredApprovals: 2 }, "tightening"],
    [{ requiredApprovals: 0 }, "loosening"],
    [{ decidedBy: "end_user" }, "loosening"],
    [{ enabled: false }, "loosening"],
    [{ name: "renamed" }, "tightening"],
    [{ changeNote: "why" }, "tightening"],
    [{ matchActionName: "other" }, "loosening"],
    [{ minAmount: 100 }, "loosening"],
    [{ priority: 1 }, "loosening"],
  ] as const)("updating a require-approval policy with %j is %s", (patch, direction) => {
    expect(classifyPolicyUpdate(policy(), patch as never, []).direction).toBe(direction);
  });

  it("widening what a require-approval policy matches tightens, unless it then takes over a stricter policy", () => {
    expect(classifyPolicyUpdate(policy(), { matchActionName: null }, []).direction).toBe("tightening");
    const stricter = policy({ requiredApprovals: 2, matchActionName: "payout" });
    expect(classifyPolicyUpdate(policy({ priority: 1 }), { matchActionName: null }, [stricter]).direction).toBe("loosening");
  });

  it("narrowing what an auto-approve policy matches tightens, widening it loosens", () => {
    const auto = policy({ effect: "auto_approve", minAmount: null, matchActionName: null, matchKind: "any" });
    expect(classifyPolicyUpdate(auto, { matchKind: "action", matchActionName: "refund" }, []).direction).toBe("tightening");
    const narrow = policy({ effect: "auto_approve" });
    expect(classifyPolicyUpdate(narrow, { matchActionName: null }, []).direction).toBe("loosening");
  });

  it("widening what an auto-deny policy matches tightens", () => {
    expect(classifyPolicyUpdate(policy({ effect: "auto_deny" }), { matchActionName: null }, []).direction).toBe("tightening");
  });

  it("editing a disabled policy changes nothing until it is enabled, and enabling it is classified then", () => {
    const off = policy({ enabled: false });
    expect(classifyPolicyUpdate(off, { effect: "auto_approve" }, []).direction).toBe("tightening");
    expect(classifyPolicyUpdate({ ...off, effect: "auto_approve" }, { enabled: true }, []).direction).toBe("loosening");
    expect(classifyPolicyUpdate(off, { enabled: true }, []).direction).toBe("tightening");
  });

  it("deleting a gating policy loosens; deleting an auto-approve or a disabled one does not", () => {
    expect(classifyPolicyDelete(policy()).direction).toBe("loosening");
    expect(classifyPolicyDelete(policy({ effect: "auto_approve" })).direction).toBe("tightening");
    expect(classifyPolicyDelete(policy({ enabled: false })).direction).toBe("tightening");
  });

  it("a policy file loosens when any one of its changes loosens", () => {
    const current = [policy({ policyId: "pol_a", name: "a" })];
    expect(classifyPolicyFile([{ op: "unchanged", name: "a" }], current).direction).toBe("tightening");
    expect(classifyPolicyFile([{ op: "update", name: "a", policyId: "pol_a", after: { requiredApprovals: 2 } }], current).direction).toBe("tightening");
    expect(classifyPolicyFile([
      { op: "update", name: "a", policyId: "pol_a", after: { requiredApprovals: 2 } },
      { op: "create", name: "b", after: { name: "b", matchKind: "any", effect: "auto_approve" } },
    ], current).direction).toBe("loosening");
    expect(classifyPolicyFile([{ op: "delete", name: "a", policyId: "pol_a" }], current).direction).toBe("loosening");
    expect(classifyPolicyFile([{ op: "delete", name: "gone", policyId: "pol_missing" }], current).direction).toBe("loosening");
  });
});

describe("actions", () => {
  const action = { name: "refund", method: "POST", urlTemplate: "https://api.stripe.com/v1/refunds", requiresApproval: true, enabled: true, governed: true, impact: { kind: "money" }, verify: null };

  it("creating an enabled action loosens, a disabled one is neutral", () => {
    expect(classifyActionCreate({ name: "a", method: "GET", urlTemplate: "https://x.test" }).direction).toBe("loosening");
    expect(classifyActionCreate({ name: "a", method: "POST", urlTemplate: "https://x.test" }).direction).toBe("loosening");
    expect(classifyActionCreate({ name: "a", enabled: false }).direction).toBe("tightening");
  });

  it.each([
    [{ description: "new words" }, "tightening"],
    [{ requiresApproval: false }, "loosening"],
    [{ enabled: false }, "tightening"],
    [{ governed: false }, "loosening"],
    [{ urlTemplate: "https://evil.test" }, "loosening"],
    [{ method: "DELETE" }, "loosening"],
    [{ headers: { a: "b" } }, "loosening"],
    [{ bodyTemplate: { a: 1 } }, "loosening"],
    [{ inputSchema: {} }, "loosening"],
    [{ adapter: { kind: "x" } }, "loosening"],
    [{ name: "refund2" }, "loosening"],
    [{ impact: null }, "loosening"],
    [{ impact: { kind: "count" } }, "loosening"],
    [{ verify: { path: "/x" } }, "tightening"],
  ] as const)("updating with %j is %s", (patch, direction) => {
    expect(classifyActionUpdate(action, patch as never).direction).toBe(direction);
  });

  it("re-enabling a disabled action loosens", () => {
    expect(classifyActionUpdate({ ...action, enabled: false }, { enabled: true }).direction).toBe("loosening");
  });

  it("deleting tightens; importing anything loosens, importing nothing does not", () => {
    expect(classifyActionDelete({ name: "x" }).direction).toBe("tightening");
    expect(classifyActionImport([{ name: "getPet", method: "GET" }]).direction).toBe("loosening");
    expect(classifyActionImport([]).direction).toBe("tightening");
  });
});

describe("secrets, stores and OAuth apps", () => {
  const secret = { allowedHosts: ["api.stripe.com"], allowedPlacements: ["header"], external: false, description: null };

  it("covers subdomains only with a leading dot", () => {
    expect(hostCovers(".stripe.com", "api.stripe.com")).toBe(true);
    expect(hostCovers(".stripe.com", "stripe.com")).toBe(true);
    expect(hostCovers("stripe.com", "api.stripe.com")).toBe(false);
    expect(hostCovers(".stripe.com", "evilstripe.com")).toBe(false);
  });

  it.each([
    [{ value: "new-value" }, "tightening"],
    [{ allowedHosts: ["api.stripe.com"] }, "tightening"],
    [{ allowedHosts: [] }, "tightening"],
    [{ allowedHosts: ["api.stripe.com", "evil.test"] }, "loosening"],
    [{ allowedHosts: [".stripe.com"] }, "loosening"],
    [{ allowedHosts: null }, "loosening"],
    [{ allowedPlacements: ["header", "query"] }, "loosening"],
    [{ allowedPlacements: [] }, "tightening"],
    [{ external: { store: "vault", path: "x" } }, "loosening"],
    [{ description: "d" }, "tightening"],
  ] as const)("putting %j over an existing secret is %s", (input, direction) => {
    expect(classifySecretPut(secret, input as never).direction).toBe(direction);
  });

  it("never shows a value in the diff", () => {
    const c = classifySecretPut(secret, { value: "sk_live_should_not_show" });
    expect(JSON.stringify(c)).not.toContain("sk_live_should_not_show");
    expect(c.direction).toBe("tightening");
    for (const change of c.changes) expect(change).toMatchObject({ from: REDACTED, to: REDACTED });
    const fresh = classifySecretPut(null, { value: "sk_live_should_not_show", allowedHosts: ["a.test"] });
    expect(JSON.stringify(fresh)).not.toContain("sk_live_should_not_show");
  });

  it("a new secret with the caller's own value is neutral; a new store reference loosens", () => {
    expect(classifySecretPut(null, { value: "v" }).direction).toBe("tightening");
    expect(classifySecretPut(null, { external: { store: "vault", path: "x" } }).direction).toBe("loosening");
  });

  it("deleting a secret or a store tightens", () => {
    expect(classifySecretDelete({ name: "S" }).direction).toBe("tightening");
    expect(classifySecretStoreDelete({ name: "v" }).direction).toBe("tightening");
  });

  it("connecting or changing a store loosens, and the diff never carries its credential", () => {
    expect(classifySecretStoreCreate({ name: "vault" }).direction).toBe("loosening");
    const update = classifySecretStoreUpdate(["credential"]);
    expect(update.direction).toBe("loosening");
    expect(update.changes[0]).toMatchObject({ from: REDACTED, to: REDACTED });
  });

  it("reaching private addresses loosens; stopping it tightens", () => {
    expect(classifySecretStoreSettings({ allowPrivateNetwork: false }, { allowPrivateNetwork: true }).direction).toBe("loosening");
    expect(classifySecretStoreSettings({ allowPrivateNetwork: true }, { allowPrivateNetwork: false }).direction).toBe("tightening");
  });

  it("setting or replacing the OAuth app loosens; removing it tightens", () => {
    expect(classifyOAuthAppPut(null, { clientId: "c" }).direction).toBe("loosening");
    expect(classifyOAuthAppPut({ clientId: "a" }, { clientId: "b" }).direction).toBe("loosening");
    expect(classifyOAuthAppDelete({ clientId: "a" }).direction).toBe("tightening");
    expect(JSON.stringify(classifyOAuthAppPut(null, { clientId: "c" }))).toContain(REDACTED);
  });
});

describe("console-only changes", () => {
  it("a new key loosens and names its privileged scopes", () => {
    const c = classifyApiKeyCreate({ name: "k", scopes: ["actions:invoke", "policies:write"] }, ["policies:write"]);
    expect(c.direction).toBe("loosening");
    expect(c.changes[0].reason).toContain("policies:write");
  });

  it.each([
    [{ isProtected: false }, "loosening"],
    [{ isProtected: true }, "tightening"],
    [{ kind: "development" }, "loosening"],
    [{ kind: "production" }, "tightening"],
    [{ allowedRedirectUrls: ["https://a.test", "https://b.test"] }, "loosening"],
    [{ allowedRedirectUrls: [] }, "tightening"],
    [{ connectConfirmation: "off" }, "loosening"],
    [{ name: "renamed", confirmProtected: true }, "tightening"],
  ] as const)("an environment change %j is %s", (patch, direction) => {
    const before = { name: "prod", kind: "production", isProtected: true, allowedRedirectUrls: ["https://a.test"], connectConfirmation: "required" as const };
    expect(classifyEnvironmentUpdate(before, patch as never).direction).toBe(direction);
  });

  it.each([
    [{ approvalWindowHours: 48 }, "loosening"],
    [{ approvalWindowHours: 1 }, "tightening"],
    [{ endUserDecider: "end_user" }, "loosening"],
    [{ actingFor: "end_users" }, "loosening"],
    [{ setupStatus: "done", source: "defaults" }, "tightening"],
  ] as const)("a workspace defaults change %j is %s", (patch, direction) => {
    expect(classifyWorkspaceDefaults({ approvalWindowHours: 24, endUserDecider: "team", actingFor: "workspace" }, patch as never).direction).toBe(direction);
  });
});

describe("the diff a person reads", () => {
  it("names each field, which way it goes, and before and after", () => {
    const text = renderDiff(classifyImpactLimitUpdate({ name: "Daily refunds", amount: 500, archived: false }, { amount: 1000 }).changes);
    expect(text).toBe("amount (loosens): Raises the limit.\n- 500\n+ 1000");
    expect(renderDiff([])).toBe("(no change)");
  });
});

describe("upstream MCP servers", () => {
  const facts = { host: "mcp.example", secrets: [] };

  it("registering sends nothing stored and adds nothing an agent can call, so it does not wait for a person", () => {
    expect(classifyMcpUpstreamRegister({ name: "mailer", url: "https://mcp.example/mcp" }, facts).direction).toBe("tightening");
    expect(classifyMcpUpstreamRegister({ name: "mailer", url: "https://mcp.example/mcp", headers: { "X-Tenant": "acme" }, registryName: "x" }, facts).direction).toBe("tightening");
    expect(classifyMcpUpstreamRegister({ name: "mailer", url: "https://mcp.example/mcp" }, facts).changes[0]!.reason).toContain("until a person signs off");
  });

  it("registering with a stored secret waits, even one that already allows this host", () => {
    const input = { name: "mailer", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer {{secret:T}}" } };
    for (const allowedHosts of [["mcp.example"], null, []]) {
      const c = classifyMcpUpstreamRegister(input, { host: "mcp.example", secrets: [{ name: "T", allowedHosts }] });
      expect(c.direction).toBe("loosening");
      expect(renderDiff(c.changes)).toContain("secret:T (loosens)");
    }
    expect(classifyMcpUpstreamRegister(input, { host: "mcp.example", secrets: [{ name: "A", allowedHosts: ["mcp.example"] }, { name: "B", allowedHosts: null }] }).direction).toBe("loosening");
  });

  it("registering fails closed on a field with no rule", () => {
    expect(classifyMcpUpstreamRegister({ name: "m", url: "https://mcp.example/mcp", surprise: 1 } as never, facts).direction).toBe("loosening");
  });

  it("adopting always loosens, and says so when a risky tool would run with no approval", () => {
    const risky = classifyMcpToolAdopt([{ tool: "drop", action: "m-drop", readopted: false, suggestedClass: "destructive", requiresApproval: false }]);
    expect(risky.changes[0]!.reason).toContain("suggests destructive");
    const gated = classifyMcpToolAdopt([{ tool: "drop", action: "m-drop", readopted: false, suggestedClass: "destructive", requiresApproval: true }]);
    expect(gated.direction).toBe("loosening");
    expect(gated.changes[0]!.reason).not.toContain("suggests");
  });

  it("a loosely checked tool has approval suggested whatever its class, and the reviewer is told why", () => {
    const loose = classifyMcpToolAdopt([{ tool: "find", action: "m-find", readopted: false, suggestedClass: "read", schemaCheck: "loose", schemaCheckReason: "remote_ref", requiresApproval: false }]);
    expect(loose.changes[0]!.reason).toContain("cannot check its input schema in full");
    expect(loose.changes[0]!.reason).toContain("Approval is suggested for a loosely checked tool");
    expect(loose.changes[0]!.to).toMatchObject({ schemaCheck: "loose", schemaCheckReason: "remote_ref" });
    const gated = classifyMcpToolAdopt([{ tool: "find", action: "m-find", readopted: false, suggestedClass: "read", schemaCheck: "loose", schemaCheckReason: "remote_ref", requiresApproval: true }]);
    expect(gated.changes[0]!.reason).not.toContain("suggested");
    const checked = classifyMcpToolAdopt([{ tool: "find", action: "m-find", readopted: false, suggestedClass: "read", schemaCheck: "full", requiresApproval: false }]);
    expect(checked.changes[0]!.reason).not.toContain("loosely");
    expect(checked.changes[0]!.to).not.toHaveProperty("schemaCheck");
  });

  it("adopting and re-adopting loosen; refreshing changes nothing an agent can call; archiving tightens", () => {
    expect(classifyMcpToolAdopt([{ tool: "send_email", action: "mailer-send_email", readopted: false }]).direction).toBe("loosening");
    expect(classifyMcpToolAdopt([{ tool: "send_email", action: "mailer-send_email", readopted: true }]).direction).toBe("loosening");
    expect(classifyMcpUpstreamRefresh({ name: "mailer" }).direction).toBe("tightening");
    expect(classifyMcpUpstreamArchive({ name: "mailer", archived: false }).direction).toBe("tightening");
    expect(classifyMcpUpstreamArchive({ name: "mailer", archived: true })).toEqual({ direction: "tightening", changes: [] });
  });

  it("registering an OAuth upstream loosens", () => {
    expect(classifyMcpUpstreamRegister({ name: "tracker", url: "https://mcp.example/mcp", oauth: { clientId: "abc" } }, facts).direction).toBe("loosening");
    expect(classifyMcpUpstreamRegister({ name: "tracker", url: "https://mcp.example/mcp", oauth: {} }, facts).direction).toBe("loosening");
  });
});
