import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { GitHubSimulator } from "./github-simulator.ts";
import { StripeSimulator } from "./stripe-simulator.ts";
import { HttpSimulator, HTTP_SIM_HOST, HTTP_SIM_TOKEN } from "./http-simulator.ts";
import { ResendSimulator, RESEND_SIM_DOMAIN, RESEND_SIM_KEY } from "./resend-simulator.ts";
import { clearProviderFetch, setProviderFetchForHost } from "./provider-fetch.ts";

export const STRIPE_KEY = "sk_test_simulator_key_0000000000";
export const GITHUB_TOKEN = "ghp_simulatorToken000000000000000000";
export const REPO = "anlyon-sim/fixtures";
export const BRANCH = "anlyon-test";
export { HTTP_SIM_HOST, HTTP_SIM_TOKEN, RESEND_SIM_DOMAIN, RESEND_SIM_KEY };

export async function loadEffectModules() {
  return {
    actions: await import("../../../src/core/actions/service.ts"),
    execute: await import("../../../src/core/actions/execute.ts"),
    approvals: await import("../../../src/core/approvals/service.ts"),
    lifecycle: await import("../../../src/core/effects/lifecycle.ts"),
    reconcile: await import("../../../src/core/effects/reconcile.ts"),
    effects: await import("../../../src/core/effects/service.ts"),
    impact: await import("../../../src/core/effects/impact.ts"),
    binding: await import("../../../src/core/effects/binding.ts"),
    environments: await import("../../../src/core/environments/service.ts"),
    halt: await import("../../../src/core/environments/halt.ts"),
    secrets: await import("../../../src/core/actions/secrets.ts"),
    keys: await import("../../../src/core/auth/api-keys.ts"),
    policies: await import("../../../src/core/approvals/policy.ts"),
  };
}

export type EffectModules = Awaited<ReturnType<typeof loadEffectModules>>;

export class EffectScope {
  stripe = new StripeSimulator();
  github = new GitHubSimulator();
  http = new HttpSimulator();
  resend = new ResendSimulator();
  workspaceId = "";
  environmentId = "";
  userId = "";

  constructor(readonly pool: Pool, readonly m: EffectModules) {}

  async seed(): Promise<this> {
    clearProviderFetch();
    setProviderFetchForHost("api.stripe.com", this.stripe.fetch);
    setProviderFetchForHost("api.github.com", this.github.fetch);
    setProviderFetchForHost(HTTP_SIM_HOST, this.http.fetch);
    setProviderFetchForHost("api.resend.com", this.resend.fetch);
    this.userId = `user_${randomUUID()}`;
    await this.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'T', $2, false, now(), now())`,
      [this.userId, `${this.userId}@test.dev`],
    );
    this.workspaceId = (await this.pool.query(
      "INSERT INTO workspaces (name, slug) VALUES ('Effects', $1) RETURNING id", [`fx-${randomUUID().slice(0, 12)}`],
    )).rows[0].id;
    this.environmentId = (await this.m.environments.ensureDefaultEnvironment(this.workspaceId)).id;
    await this.m.secrets.putSecret(this.workspaceId, "STRIPE_TEST_KEY", { value: STRIPE_KEY, allowedHosts: ["api.stripe.com"] }, this.environmentId);
    await this.m.secrets.putSecret(this.workspaceId, "GITHUB_TOKEN", { value: GITHUB_TOKEN, allowedHosts: ["api.github.com"] }, this.environmentId);
    await this.m.secrets.putSecret(this.workspaceId, "RESEND_API_KEY", { value: RESEND_SIM_KEY, allowedHosts: ["api.resend.com"] }, this.environmentId);
    await this.m.secrets.putSecret(this.workspaceId, "MAILER_TOKEN",
      { value: HTTP_SIM_TOKEN, allowedHosts: [HTTP_SIM_HOST], allowedPlacements: ["header"] }, this.environmentId);
    this.stripe.addPaymentIntent("pi_order1", 50_000).addPaymentIntent("pi_order2", 50_000).addPaymentIntent("pi_order3", 50_000);
    this.github.addRepo(REPO, "main");
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "status.txt"]) {
      this.github.setFile(REPO, BRANCH, `fixtures/${name}`, `${name} v1\n`);
    }
    return this;
  }

  async cleanup() {
    clearProviderFetch();
    if (this.workspaceId) await this.pool.query("DELETE FROM workspaces WHERE id = $1", [this.workspaceId]);
    if (this.userId) await this.pool.query('DELETE FROM "user" WHERE id = $1', [this.userId]);
  }

  refundAction(name = "refund", opts: { requiresApproval?: boolean; account?: string } = {}) {
    return this.m.actions.createAction(this.workspaceId, {
      name,
      urlTemplate: "",
      requiresApproval: opts.requiresApproval ?? false,
      adapter: { type: "stripe.refund", config: { account: opts.account ?? this.stripe.accountId, mode: "test", currency: "usd" }, credentialSecret: "STRIPE_TEST_KEY" },
    }, this.m.actions.UNSCOPED_AUTHORITY, this.environmentId);
  }

  fileAction(name = "update-file", opts: { requiresApproval?: boolean } = {}) {
    const [owner, repo] = REPO.split("/");
    return this.m.actions.createAction(this.workspaceId, {
      name,
      urlTemplate: "",
      requiresApproval: opts.requiresApproval ?? false,
      adapter: { type: "github.file_update", config: { owner, repo, branch: BRANCH, pathPrefix: "fixtures/" }, credentialSecret: "GITHUB_TOKEN" },
    }, this.m.actions.UNSCOPED_AUTHORITY, this.environmentId);
  }

  emailAction(name = "send-receipt", opts: { requiresApproval?: boolean; fromAddresses?: string[] } = {}) {
    return this.m.actions.createAction(this.workspaceId, {
      name,
      urlTemplate: "",
      requiresApproval: opts.requiresApproval ?? false,
      adapter: {
        type: "resend.email_send",
        config: { domain: RESEND_SIM_DOMAIN, ...(opts.fromAddresses ? { fromAddresses: opts.fromAddresses } : {}) },
        credentialSecret: "RESEND_API_KEY",
      },
    }, this.m.actions.UNSCOPED_AUTHORITY, this.environmentId);
  }

  declaredAction(name = "send-email", opts: { requiresApproval?: boolean; verify?: boolean | "response"; impact?: boolean } = {}) {
    const serverChoosesId = opts.verify === "response";
    const messages = `https://${HTTP_SIM_HOST}/v1/messages`;
    return this.m.actions.createAction(this.workspaceId, {
      name,
      method: serverChoosesId ? "POST" : "PUT",
      urlTemplate: serverChoosesId ? messages : `${messages}/{{input.messageId}}`,
      headers: { Authorization: "Bearer {{secret:MAILER_TOKEN}}" },
      bodyTemplate: { to: "{{input.to}}", subject: "{{input.subject}}" },
      inputSchema: {
        type: "object",
        required: serverChoosesId ? ["subject"] : ["messageId", "subject"],
        properties: {
          messageId: { type: "string", pattern: "^[a-z0-9-]{1,40}$" },
          to: { type: "array", items: { type: "string" } },
          subject: { type: "string" },
        },
      },
      requiresApproval: opts.requiresApproval ?? false,
      ...(opts.impact === false ? {} : { impact: { dimension: "emails", amount: "count(input.to)", bound: "exact" as const } }),
      ...(opts.verify === false ? { governed: true } : {
        verify: serverChoosesId
          ? { url: `${messages}/{{response.id}}`, status: 200, match: [{ path: "status", equals: "sent" }] }
          : { url: `${messages}/{{input.messageId}}`, status: 200, match: [{ path: "subject", equals: "{{input.subject}}" }] },
      }),
    }, this.m.actions.UNSCOPED_AUTHORITY, this.environmentId);
  }

  email(messageId: string, to?: string[], subject = "Welcome") {
    return { messageId, subject, ...(to ? { to } : {}) };
  }

  mail(to: string[], subject = "Your receipt") {
    return { from: `Billing <billing@${RESEND_SIM_DOMAIN}>`, to, subject, text: "Thanks for your order." };
  }

  invoke(action: string, input: Record<string, unknown>, opts: Parameters<EffectModules["actions"]["invokeAction"]>[3] = {}) {
    return this.m.actions.invokeAction(this.workspaceId, action, input, { environmentId: this.environmentId, ...opts });
  }

  refund(amount: number, paymentIntent = "pi_order1") {
    return { paymentIntent, amount, currency: "usd" };
  }

  file(name: string, content: string) {
    return { path: `fixtures/${name}`, content, message: `Update ${name}` };
  }

  effect(effectId: string) {
    return this.m.effects.getEffect(this.workspaceId, this.environmentId, effectId);
  }

  async row(effectId: string) {
    return this.m.reconcile.effectRowByPublicId(this.workspaceId, this.environmentId, effectId);
  }

  limit(input: Parameters<EffectModules["impact"]["createLimit"]>[2]) {
    return this.m.impact.createLimit(this.workspaceId, this.environmentId, input);
  }

  limitView(limitId: string) {
    return this.m.impact.getLimit(this.workspaceId, this.environmentId, limitId);
  }

  async due(effectId: string) {
    await this.pool.query("UPDATE action_effects SET next_reconcile_at = now() - interval '1 second' WHERE effect_id = $1", [effectId]);
  }

  async backdateDispatch(effectId: string, ms: number) {
    await this.pool.query(
      "UPDATE action_effects SET first_dispatched_at = now() - ($2::int * interval '1 millisecond') WHERE effect_id = $1", [effectId, ms],
    );
  }

  async reconcileNow(effectId: string) {
    const row = await this.row(effectId);
    return this.m.reconcile.reconcileEffectNow(row.id);
  }

  async apiKey(name: string, scopes = ["actions:read", "actions:invoke"]) {
    const created = await this.m.keys.createApiKey(this.workspaceId, this.userId, name, undefined, scopes as never, this.environmentId);
    const id = (await this.pool.query("SELECT id FROM api_keys WHERE workspace_id = $1 AND name = $2", [this.workspaceId, name])).rows[0].id as string;
    return { key: created.key, id };
  }
}
