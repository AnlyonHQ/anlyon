import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

const requestSignOffIfLoosening = vi.hoisted(() => vi.fn());
vi.mock("../src/core/governance/sign-offs.ts", () => ({ requestSignOffIfLoosening }));
vi.mock("../src/api/audit-caller.ts", () => ({ auditCaller: () => ({ actor: { type: "system", id: null }, context: {} }) }));

const { signOffIfLoosening } = await import("../src/api/governance-gate.ts");

type Expected = { gate: string } | { notGated: string };

const TIGHTENS = "Only ever tightens: classified as such in core/governance/classify.ts.";
const RUN = "Acts on one call or effect, which is itself governed; changes no guardrail.";
const READ = "Reads or checks; changes no guardrail.";

const ROUTES: Record<string, Record<string, Expected>> = {
  "approval-policies.ts": {
    "POST /evaluate": { notGated: READ },
    "POST /files/plan": { notGated: READ },
    "POST /files/test": { notGated: READ },
    "POST /files/apply": { gate: "policy_file.apply" },
    "POST /": { gate: "policy.create" },
    "PATCH /:policyId": { gate: "policy.update" },
    "DELETE /:policyId": { gate: "policy.delete" },
  },
  "impact-limits.ts": {
    "POST /": { notGated: TIGHTENS },
    "PATCH /:id": { gate: "impact_limit.update" },
    "DELETE /:id": { gate: "impact_limit.archive" },
  },
  "budgets.ts": {
    "PUT /:apiKeyId": { gate: "budget.put" },
    "DELETE /:apiKeyId": { gate: "budget.delete" },
  },
  "environment.ts": {
    "POST /halt": { notGated: TIGHTENS },
    "POST /resume": { gate: "environment.resume" },
  },
  "actions.ts": {
    "POST /invocations/:id/resolve": { notGated: RUN },
    "POST /effects/:id/reconcile": { notGated: RUN },
    "POST /effects/:id/notes": { notGated: RUN },
    "POST /effects/:id/resolve": { notGated: RUN },
    "POST /effects/:id/replay": { notGated: RUN },
    "POST /previews/:id/refresh": { notGated: READ },
    "POST /import": { gate: "action.import" },
    "POST /": { gate: "action.create" },
    "POST /:ref/invoke": { notGated: RUN },
    "POST /:ref/previews": { notGated: READ },
    "PATCH /:ref": { gate: "action.update" },
    "DELETE /:ref": { notGated: TIGHTENS },
  },
  "secrets.ts": {
    "PUT /:name": { gate: "secret.put" },
    "POST /:name/check": { notGated: READ },
    "DELETE /:name": { notGated: TIGHTENS },
  },
  "secret-stores.ts": {
    "POST /": { gate: "secret_store.create" },
    "PATCH /:name": { gate: "secret_store.update" },
    "POST /:name/check": { notGated: READ },
    "DELETE /:name": { notGated: TIGHTENS },
    "PUT / (settings)": { gate: "secret_store_settings.update" },
  },
  "mcp-upstreams.ts": {
    "POST /": { gate: "mcp_upstream.register" },
    "POST /inspect": { notGated: READ },
    "POST /:id/connect": { gate: "mcp_upstream.connect" },
    "POST /:id/connect-links": { notGated: "Mints a link an end user consents through; their grant is used only for calls made for them." },
    "POST /:id/refresh": { gate: "mcp_upstream.refresh" },
    "POST /:id/adopt": { gate: "mcp_upstream.adopt" },
    "POST /:id/archive": { notGated: TIGHTENS },
  },
  "environment-oauth-apps.ts": {
    "PUT /:environmentId/oauth-apps/:integration": { gate: "oauth_app.put" },
    "DELETE /:environmentId/oauth-apps/:integration": { notGated: TIGHTENS },
  },
};

function writeRoutes(file: string): Record<string, string[]> {
  const source = readFileSync(new URL(`../src/api/routes/${file}`, import.meta.url), "utf8");
  const starts = [...source.matchAll(/\w+Router\.(get|post|put|patch|delete|use)\(/g)].map((m) => m.index!);
  const out: Record<string, string[]> = {};
  for (const m of source.matchAll(/(\w+Router)\.(post|put|patch|delete)\(\s*["`]([^"`]+)["`]/g)) {
    const end = starts.find((i) => i > m.index!) ?? source.length;
    const body = source.slice(m.index!, end);
    const key = `${m[2].toUpperCase()} ${m[3]}${m[1] === "secretStoreSettingsRouter" ? " (settings)" : ""}`;
    out[key] = [...body.matchAll(/signOffIfLoosening\(\s*c,\s*"([^"]+)"/g)].map((x) => x[1]);
  }
  return out;
}

describe("every governance write route is gated or says why not", () => {
  for (const [file, expected] of Object.entries(ROUTES)) {
    it(file, () => {
      const found = writeRoutes(file);
      expect(Object.keys(found).sort(), "a write route was added or removed: classify it here").toEqual(Object.keys(expected).sort());
      for (const [route, want] of Object.entries(expected)) {
        if ("gate" in want) expect(found[route], route).toEqual([want.gate]);
        else expect(found[route], route).toEqual([]);
      }
    });
  }
});

describe("the gate", () => {
  const pending = { signOff: { id: "sor_test", pollUrl: "/api/v2/sign-offs/sor_test", status: "pending" }, created: true };

  function appFor(authType: string | undefined) {
    const app = new Hono();
    app.post("/", async (c) => {
      if (authType) c.set("authType", authType);
      c.set("workspaceId", "ws_1");
      c.set("environmentId", "env_1");
      c.set("apiKeyId", "key_1");
      c.set("apiKeyScopes", ["impact-limits:write"]);
      const held = await signOffIfLoosening(c, "impact_limit.update", { id: "lim_1", unused: undefined }, { amount: 10 });
      return held ?? c.json({ success: true, applied: true });
    });
    return app;
  }

  it("lets a person in the console through without classifying", async () => {
    requestSignOffIfLoosening.mockClear();
    const res = await appFor("session").request("/", { method: "POST" });
    expect(await res.json()).toEqual({ success: true, applied: true });
    expect(requestSignOffIfLoosening).not.toHaveBeenCalled();
  });

  it.each(["apiKey", "oauth", "endUserSession", "somethingNew", undefined])("holds a loosening change from %s with a 202", async (authType) => {
    requestSignOffIfLoosening.mockResolvedValueOnce(pending);
    const res = await appFor(authType).request("/", { method: "POST" });
    expect(res.status).toBe(202);
    expect(res.headers.get("Location")).toBe("/api/v2/sign-offs/sor_test");
    expect(await res.json()).toEqual({ success: true, signOffRequired: true, data: pending.signOff });
  });

  it("passes the change, its target and the credential to the request", async () => {
    requestSignOffIfLoosening.mockClear().mockResolvedValueOnce(pending);
    await appFor("apiKey").request("/", { method: "POST" });
    expect(requestSignOffIfLoosening).toHaveBeenCalledWith(
      { workspaceId: "ws_1", environmentId: "env_1" },
      { operation: "impact_limit.update", target: { id: "lim_1" }, input: { amount: 10 } },
      expect.objectContaining({ type: "api_key", keyId: "key_1", scopes: ["impact-limits:write"] }),
    );
  });

  it("lets a change that does not loosen through", async () => {
    requestSignOffIfLoosening.mockResolvedValueOnce(null);
    const res = await appFor("apiKey").request("/", { method: "POST" });
    expect(await res.json()).toEqual({ success: true, applied: true });
  });
});
