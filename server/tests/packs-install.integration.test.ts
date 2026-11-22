import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
vi.mock("../src/api/governance-gate.ts", async (importOriginal) => ({ ...(await importOriginal<object>()), signOffIfLoosening: async () => null }));

const root = resolve(__dirname, "../..");
const manifest = (name: string) => JSON.parse(readFileSync(resolve(root, `packs/${name}/pack.json`), "utf8"));
const resolvePack = (id: string) => manifest(id.replace(/^anlyon\//, ""));

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("action packs install (real stack, SDK installer)", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let userId: string;
  let workspaceId: string;
  let environmentId: string;
  let client: any;
  let secrets: typeof import("../src/core/actions/secrets.ts");
  let PackError: any;

  beforeAll(async () => {
    const app = (await import("../src/api/index.ts")).default as { request: (url: string, init?: RequestInit) => Promise<Response> };
    const keys = await import("../src/core/auth/api-keys.ts");
    const envs = await import("../src/core/environments/service.ts");
    secrets = await import("../src/core/actions/secrets.ts");
    const sdk = await import("../../sdks/typescript/sdk/src/index.ts");
    PackError = sdk.PackError;
    userId = `user_${randomUUID()}`;
    await pool.query(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'T', $2, false, now(), now())`,
      [userId, `${userId}@test.dev`]);
    workspaceId = (await pool.query(`INSERT INTO workspaces (name, slug, plan) VALUES ('P', $1, 'enterprise') RETURNING id`,
      [`ws-${randomUUID().slice(0, 8)}`])).rows[0].id;
    environmentId = (await envs.ensureDefaultEnvironment(workspaceId)).id;
    const scopes = ["secrets:read", "secrets:write", "actions:read", "actions:write", "actions:govern", "policies:read", "policies:write", "impact-limits:read", "impact-limits:write"];
    const { key } = await keys.createApiKey(workspaceId, userId, "packs", undefined, scopes as never, environmentId);
    client = new sdk.Client({
      apiKey: key,
      baseUrl: "http://anlyon.test",
      retry: { maxAttempts: 1 },
      fetch: ((url: string, init: RequestInit) => app.request(new URL(url).pathname + new URL(url).search, init)) as typeof fetch,
    });
  }, 60_000);

  afterAll(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
    await pool.end();
  });

  const connect = (name: string, integrationId: string, host: string) =>
    secrets.putConnectionSecret(workspaceId, name, { integrationId, connectionId: `conn-${name.toLowerCase()}`, allowedHosts: [host] }, environmentId);
  const connectWithKey = (name: string, integrationId: string, host: string) =>
    secrets.putSecret(workspaceId, name, { value: "fixture-not-a-key", allowedHosts: [host], allowedPlacements: ["header"], integrationId }, environmentId);

  const refundParams = { stripe_account: "acct_1PackTest00000000", slack_channel: "C0123456789" };

  it("plan sends nothing and shows what install would do", async () => {
    const plan = await client.packs.plan(manifest("support-refunds"), { params: refundParams, resolvePack });
    expect(plan.applied).toBe(false);
    expect(plan.steps.filter((s: any) => s.kind === "secret" || s.kind === "connection").map((s: any) => [s.name, s.outcome])).toEqual([
      ["STRIPE_KEY", "create"], ["connection:hubspot", "skip"], ["connection:slack", "skip"],
    ]);
    const bound = await client.packs.plan(manifest("support-refunds"), { params: refundParams, resolvePack, credential: "secret" });
    expect(bound.steps.filter((s: any) => s.kind === "secret").map((s: any) => [s.name, s.outcome])).toEqual([
      ["STRIPE_KEY", "create"], ["HUBSPOT", "create"], ["SLACK", "create"],
    ]);
    expect(bound.steps.find((s: any) => s.name === "HUBSPOT").detail).toMatch(/anlyon connections add hubspot --secret HUBSPOT/);
    expect(plan.disabledPolicies).toEqual(["support-refunds: approve refunds over 100.00"]);
    expect(plan.suggestedLimits.map((l: any) => l.actionName)).toEqual([
      "support-refunds-refund-payment", "support-refunds-note-customer", "support-refunds-post-to-support",
    ]);
    expect((await pool.query("SELECT count(*)::int AS n FROM actions WHERE workspace_id = $1", [workspaceId])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_secrets WHERE workspace_id = $1", [workspaceId])).rows[0].n).toBe(0);
  });

  it("install bound to named secrets stops at a missing connected account with the command to connect it", async () => {
    const error = await client.packs.install(manifest("support-refunds"), { resolvePack, params: refundParams, secrets: { STRIPE_KEY: "stripe-fixture-not-a-key" }, credential: "secret" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PackError);
    expect(error).toMatchObject({ code: "PACK_CONNECTION_MISSING", command: "anlyon connections add hubspot --secret HUBSPOT" });
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_secrets WHERE workspace_id = $1", [workspaceId])).rows[0].n).toBe(0);
  });

  it("installs support-refunds with limits, policies disabled, and a second install changes nothing", async () => {
    await connect("HUBSPOT", "hubspot", "api.hubapi.com");
    await connect("SLACK", "slack", "slack.com");
    const result = await client.packs.install(manifest("support-refunds"), {
      resolvePack, params: refundParams, secrets: { STRIPE_KEY: "stripe-fixture-not-a-key" }, withLimits: true,
    });
    expect(result.steps.map((s: any) => `${s.kind}:${s.name}:${s.outcome}`)).toEqual([
      "secret:STRIPE_KEY:created", "connection:connection:hubspot:skip", "connection:connection:slack:skip",
      "action:support-refunds-refund-payment:created", "action:support-refunds-note-customer:created", "action:support-refunds-post-to-support:created",
      "policy:support-refunds: approve refunds over 100.00:created",
      "limit:support-refunds: refunds per day:created", "limit:support-refunds: customer notes per day:created", "limit:support-refunds: support posts per day:created",
    ]);

    const stripe = (await client.secrets.get("STRIPE_KEY")).data;
    expect(stripe).toMatchObject({ kind: "static", allowedHosts: ["api.stripe.com"], allowedPlacements: ["header"] });
    const note = (await client.actions.get("support-refunds-note-customer")).data;
    expect(note).toMatchObject({ governed: true, method: "POST" });
    expect(note.headers.Authorization).toBe("Bearer {{connection:hubspot}}");
    const post = (await client.actions.get("support-refunds-post-to-support")).data;
    expect(post.bodyTemplate).toEqual({ channel: "C0123456789", text: "{{input.text}}" });
    expect(post.verify.url).toContain("channel=C0123456789");
    const refund = (await client.actions.get("support-refunds-refund-payment")).data;
    expect(refund.adapter).toMatchObject({ type: "stripe.refund", config: { account: "acct_1PackTest00000000", mode: "test", currency: "usd" } });

    const policies = (await client.approvalPolicies.list({ actionName: "support-refunds-refund-payment" })).data;
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ enabled: false, effect: "require_approval", match: { actionName: "support-refunds-refund-payment", condition: "input.amount > 10000" } });

    const again = await client.packs.install(manifest("support-refunds"), { resolvePack, params: refundParams, withLimits: true });
    expect(again.steps.every((s: any) => s.outcome === "skip")).toBe(true);
  });

  it("installs outbound-sales and leaves its limits as suggestions without --with-limits", async () => {
    await connect("GOOGLE_CALENDAR", "google-calendar", "www.googleapis.com");
    const result = await client.packs.install(manifest("outbound-sales"), { resolvePack });
    expect(result.steps.filter((s: any) => s.kind === "action").map((s: any) => s.outcome)).toEqual(["created", "created", "created"]);
    expect(result.disabledPolicies).toHaveLength(2);
    expect(result.suggestedLimits).toHaveLength(3);
    const limits = (await client.impactLimits.list()).data.map((l: any) => l.name);
    expect(limits.some((n: string) => n.startsWith("outbound-sales"))).toBe(false);
    const policies = (await client.approvalPolicies.list({ actionName: "outbound-sales-book-meeting" })).data;
    expect(policies[0]).toMatchObject({ enabled: false });
  });

  it("installs every operation of both catalogue packs, then one operation at a time under another secret name", async () => {
    const hubspot = await client.packs.install(manifest("hubspot"), { withLimits: true });
    expect(hubspot.steps.filter((s: any) => s.kind === "action" && s.outcome === "created")).toHaveLength(manifest("hubspot").actions.length);
    expect(hubspot.disabledPolicies).toHaveLength(manifest("hubspot").policies.length);
    const slack = await client.packs.install(manifest("slack"), { withLimits: true });
    expect(slack.steps.filter((s: any) => s.kind === "action" && s.outcome === "created")).toHaveLength(manifest("slack").actions.length);
    const policies = (await client.approvalPolicies.list({ actionName: "hubspot-update-deal-stage" })).data;
    expect(policies[0]).toMatchObject({ enabled: false, match: { condition: "input.dealstage == 'closedwon' || input.dealstage == 'closedlost'" } });

    await connect("HUBSPOT_SALES", "hubspot", "api.hubapi.com");
    const one = await client.packs.install(manifest("hubspot"), { actions: ["create-company"], secretNames: { HUBSPOT: "HUBSPOT_SALES" }, noPrefix: true });
    expect(one.steps.map((s: any) => `${s.kind}:${s.name}:${s.outcome}`)).toEqual(["secret:HUBSPOT_SALES:skip", "action:create-company:created", "limit:hubspot: companies created per day:suggest"]);
    const action = (await client.actions.get("create-company")).data;
    expect(action.headers.Authorization).toBe("Bearer {{secret:HUBSPOT_SALES}}");
  });

  it("installs the Google catalogue packs as they are: Calendar's writes are read back, Gmail's send is not", async () => {
    for (const pack of ["google-calendar", "gmail"] as const) {
      const m = manifest(pack);
      const result = await client.packs.install(m, { withLimits: true });
      expect(result.steps.find((s: any) => s.kind === "connection"), pack).toMatchObject({ name: `connection:${pack}`, outcome: "skip" });
      expect(result.steps.filter((s: any) => s.kind === "action" && s.outcome === "created"), pack).toHaveLength(m.actions.length);
      expect(result.disabledPolicies, pack).toHaveLength(m.policies.length);
    }
    const create = (await client.actions.get("google-calendar-create-event")).data;
    expect(create).toMatchObject({ governed: true, method: "POST" });
    expect(create.headers.Authorization).toBe("Bearer {{connection:google-calendar}}");
    expect(create.verify.url).toBe("https://www.googleapis.com/calendar/v3/calendars/{{input.calendar_id}}/events/{{response.id}}");
    const send = (await client.actions.get("gmail-send-email")).data;
    expect(send).toMatchObject({ governed: true, method: "POST", urlTemplate: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send" });
    expect(send.headers.Authorization).toBe("Bearer {{connection:gmail}}");
    expect(send.verify ?? null).toBeNull();
  });

  it("installs the API-key integrations' catalogue packs against accounts connected with a key", async () => {
    const packs = [
      ["github", "GITHUB", "api.github.com"], ["notion", "NOTION", "api.notion.com"], ["pagerduty", "PAGERDUTY", "api.pagerduty.com"],
      ["asana", "ASANA", "app.asana.com"], ["attio", "ATTIO", "api.attio.com"], ["discord", "DISCORD", "discord.com"],
      ["intercom", "INTERCOM", "api.intercom.io"], ["sentry", "SENTRY", "sentry.io"],
      ["sendgrid", "SENDGRID", "api.sendgrid.com"],
      ["postmark", "POSTMARK", "api.postmarkapp.com"],
      ["pipedrive", "PIPEDRIVE", "api.pipedrive.com"],
      ["front", "FRONT", "api2.frontapp.com"],
      ["airtable", "AIRTABLE", "api.airtable.com"],
      ["clickup", "CLICKUP", "api.clickup.com"],
      ["todoist", "TODOIST", "api.todoist.com"],
      ["calcom", "CALCOM", "api.cal.com"],
      ["calendly", "CALENDLY", "api.calendly.com"],
      ["gitlab", "GITLAB", "gitlab.com"],
      ["vercel", "VERCEL", "api.vercel.com"],
    ] as const;
    for (const [pack, secret, host] of packs) {
      const missing = await client.packs.install(manifest(pack), { credential: "secret" }).catch((e: unknown) => e);
      expect(missing, pack).toMatchObject({ code: "PACK_CONNECTION_MISSING", command: `anlyon connections add ${pack} --secret ${secret}` });

      const result = await client.packs.install(manifest(pack), { withLimits: true });
      expect(result.steps.find((s: any) => s.kind === "connection"), pack).toMatchObject({ name: `connection:${pack}`, outcome: "skip" });
      expect(result.steps.some((s: any) => s.kind === "secret"), pack).toBe(false);
      await connectWithKey(secret, pack, host);
      const m = manifest(pack);
      expect(result.steps.filter((s: any) => s.kind === "action" && s.outcome === "created"), pack).toHaveLength(m.actions.length);
      expect(result.disabledPolicies, pack).toHaveLength(m.policies.length);
      expect(result.steps.filter((s: any) => s.kind === "limit" && s.outcome === "created"), pack).toHaveLength(m.limits.length);
    }

    const issue = (await client.actions.get("github-create-issue")).data;
    expect(issue).toMatchObject({ method: "POST", urlTemplate: "https://api.github.com/repos/{{input.owner}}/{{input.repo}}/issues" });
    expect(issue.headers.Authorization).toBe("Bearer {{connection:github}}");
    expect(issue.verify.url).toBe("https://api.github.com/repos/{{input.owner}}/{{input.repo}}/issues/{{response.number}}");
    const incident = (await client.actions.get("pagerduty-create-incident")).data;
    expect(incident.headers.Authorization).toBe("Token token={{connection:pagerduty}}");
    expect((await client.actions.get("discord-post-message")).data.headers.Authorization).toBe("Bot {{connection:discord}}");
    const page = (await client.actions.get("notion-archive-page")).data;
    expect(page.verify.match).toEqual([{ path: "archived", equals: true }]);

    expect((await client.secrets.get("GITHUB")).data).toMatchObject({ kind: "static", connection: null, integrationId: "github", allowedHosts: ["api.github.com"], allowedPlacements: ["header"] });
  });

  it("installs the packs on keys made of several values, per-account hosts and GraphQL", async () => {
    const packs = [
      ["jira", "jira", "JIRA", "acme.atlassian.net"],
      ["zendesk", "zendesk", "ZENDESK", "acme.zendesk.com"],
      ["mailchimp", "mailchimp", "MAILCHIMP", "us21.api.mailchimp.com"],
      ["linear-key", "linear-key", "LINEAR_KEY", "api.linear.app"],
      ["monday", "monday", "MONDAY", "api.monday.com"],
      ["trello", "trello", "TRELLO", "api.trello.com"],
      ["close", "close", "CLOSE", "api.close.com"],
      ["twilio", "twilio", "TWILIO", "api.twilio.com"],
    ] as const;
    for (const [pack, integration, secret, host] of packs) {
      const missing = await client.packs.install(manifest(pack), { credential: "secret" }).catch((e: unknown) => e);
      expect(missing, pack).toMatchObject({ code: "PACK_CONNECTION_MISSING", command: `anlyon connections add ${integration} --secret ${secret}` });
      const result = await client.packs.install(manifest(pack), { withLimits: true });
      expect(result.steps.find((s: any) => s.kind === "connection"), pack).toMatchObject({ name: `connection:${integration}`, outcome: "skip" });
      await connectWithKey(secret, integration, host);
      const m = manifest(pack);
      expect(result.steps.filter((s: any) => s.kind === "action" && s.outcome === "created"), pack).toHaveLength(m.actions.length);
      expect(result.disabledPolicies, pack).toHaveLength(m.policies.length);
      expect(result.steps.filter((s: any) => s.kind === "limit" && s.outcome === "created"), pack).toHaveLength(m.limits.length);
    }

    const comment = (await client.actions.get("jira-add-comment")).data;
    expect(comment.urlTemplate.startsWith("https://{{connection.host}}/rest/api/3/")).toBe(true);
    expect(comment.verify.url.startsWith("https://{{connection.host}}/")).toBe(true);
    expect(comment.headers.Authorization).toBe("Basic {{connection:jira}}");
    const issue = (await client.actions.get("linear-key-create-issue")).data;
    expect(issue.headers.Authorization).toBe("{{connection:linear-key}}");
    expect(issue.verify.graphql.query.startsWith("query")).toBe(true);
    expect((await client.actions.get("trello-create-card")).data.headers.Authorization).toBe("OAuth {{connection:trello}}");
  });

  it("a changed definition is refused without --update and becomes a new version with it", async () => {
    const changed = manifest("outbound-sales");
    changed.actions[1].inputSchema.properties.summary.pattern = "^[\\s\\S]{1,100}$";
    await expect(client.packs.install(changed, { resolvePack })).rejects.toMatchObject({ code: "PACK_ACTION_CONFLICT" });
    const before = (await client.actions.versions("outbound-sales-book-meeting")).data.length;
    const result = await client.packs.install(changed, { update: true, resolvePack });
    expect(result.steps.find((s: any) => s.name === "outbound-sales-book-meeting").outcome).toBe("updated");
    expect((await client.actions.versions("outbound-sales-book-meeting")).data.length).toBe(before + 1);
  });
});
