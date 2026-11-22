import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { providerFetch } from "./support/effects/provider-fetch.ts";

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-http.ts")>();
  return { ...actual, safeFetch: providerFetch };
});

const { EffectScope, loadEffectModules, HTTP_SIM_HOST, HTTP_SIM_TOKEN } = await import("./support/effects/fixture.ts");

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("governed effects: declared actions (real Postgres)", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let m: Awaited<ReturnType<typeof loadEffectModules>>;
  let s: InstanceType<typeof EffectScope>;

  beforeAll(async () => {
    await pool.query("SELECT 1");
    m = await loadEffectModules();
  });
  beforeEach(async () => { s = await new EffectScope(pool, m).seed(); });
  afterEach(async () => { await s.cleanup(); });
  afterAll(async () => { await pool.end(); });

  const writes = () => s.http.requests.filter((r) => r.method !== "GET");
  const reads = () => s.http.requests.filter((r) => r.method === "GET");
  const emailLimit = (amount: number) => s.limit({ name: "daily emails", dimension: "emails", period: "day", amount });

  describe("shared limits in a declared unit", () => {
    it("a declared unit draws from one limit across keys and sessions", async () => {
      await s.declaredAction();
      const limit = await emailLimit(5);
      expect(limit).toMatchObject({ dimension: "emails", unit: "emails", currency: null, limit: 5, available: 5 });
      const first = await s.apiKey("agent-1");
      const second = await s.apiKey("agent-2");
      const a = await s.invoke("send-email", s.email("m-1", ["a@example.com", "b@example.com", "c@example.com"]), { requestedByKeyId: first.id });
      const b = await s.invoke("send-email", s.email("m-2", ["a@example.com", "b@example.com", "c@example.com"]), { requestedByKeyId: second.id });
      const c = await s.invoke("send-email", s.email("m-3", ["a@example.com", "b@example.com"]));
      expect([a.status, b.status, c.status]).toEqual(["succeeded", "failed", "succeeded"]);
      expect(b.error).toMatch(/impact_limit_exceeded/);
      expect(writes()).toHaveLength(2);
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 5, reserved: 0, available: 0 });
      const refused = await s.effect(b.effectId!);
      expect(refused).toMatchObject({ stage: "rejected", outcome: "not_dispatched", rejectionReason: "impact_limit_exceeded", grade: "refused" });
      expect(refused.attempts).toHaveLength(0);
      expect(b.grade).toBe("refused");
      const settled = await s.effect(a.effectId!);
      expect(settled.impact).toEqual([{ dimension: "emails", amount: 3, bound: "exact" }]);
      expect(settled.reservations).toMatchObject([{ dimension: "emails", amount: 3, state: "settled", settled: 3 }]);
    });

    it("impact_unbounded: an effect with no quantity is refused under an applicable limit and runs with none", async () => {
      await s.declaredAction();
      await s.limit({ name: "texts", dimension: "sms", period: "day", amount: 1 });
      const free = await s.invoke("send-email", s.email("m-1"));
      expect(free.status).toBe("succeeded");
      expect((await s.effect(free.effectId!)).impact).toEqual([]);
      expect(writes()).toHaveLength(1);

      const limit = await emailLimit(1000);
      const blocked = await s.invoke("send-email", s.email("m-2"));
      expect(blocked.status).toBe("failed");
      expect(blocked.error).toMatch(/impact_unbounded/);
      const effect = await s.effect(blocked.effectId!);
      expect(effect).toMatchObject({ stage: "rejected", outcome: "not_dispatched", rejectionReason: "impact_unbounded", grade: "refused" });
      expect(effect.attempts).toHaveLength(0);
      expect(writes()).toHaveLength(1);
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 0, reserved: 0 });
      expect((await s.invoke("send-email", s.email("m-3", ["a@example.com"]))).status).toBe("succeeded");
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 1, reserved: 0 });
    });
  });

  describe("receipt grades", () => {
    it("a matched read-back grades confirmed", async () => {
      await s.declaredAction();
      const result = await s.invoke("send-email", s.email("m-1", ["a@example.com"]));
      expect(result).toMatchObject({ status: "succeeded", grade: "confirmed" });
      const effect = await s.effect(result.effectId!);
      expect(effect).toMatchObject({
        stage: "settled", outcome: "succeeded", grade: "confirmed", verification: "provider",
        adapter: { type: "http.declared", version: "1" },
        target: { account: HTTP_SIM_HOST, resourceKey: `http:${HTTP_SIM_HOST}/v1/messages/m-1` },
        providerReference: `https://${HTTP_SIM_HOST}/v1/messages/m-1`,
      });
      expect(effect.evidence.map((e) => e.source)).toEqual(["preview", "system", "provider_response", "provider_lookup"]);
      expect(effect.evidence[3].summary).toMatch(/read-back matched/);
      expect(s.http.requests.map((r) => r.method)).toEqual(["PUT", "GET"]);
      expect(effect.attempts.map((a) => [a.kind, a.status])).toEqual([["dispatch", "completed"]]);
    });

    it("a 2xx without a verify rule grades acknowledged", async () => {
      await s.declaredAction("send-email", { verify: false });
      const result = await s.invoke("send-email", s.email("m-1", ["a@example.com"]));
      expect(result).toMatchObject({ status: "succeeded", grade: "acknowledged" });
      const effect = await s.effect(result.effectId!);
      expect(effect).toMatchObject({ outcome: "succeeded", grade: "acknowledged", providerReference: null });
      expect(effect.evidence.map((e) => e.source)).toEqual(["preview", "system", "provider_response"]);
      expect(reads()).toHaveLength(0);
      const limitations = effect.preview!.blocks.find((b) => b.type === "limitations") as { items: Array<{ kind: string; text: string }> };
      expect(limitations.items.some((i) => i.kind === "unsupported" && /Read-back verification/.test(i.text))).toBe(true);
    });

    it("a read-back that does not match leaves the success acknowledged, and its evidence says why", async () => {
      await s.declaredAction();
      s.http.fault("lookup", "hide_from_read");
      const result = await s.invoke("send-email", s.email("m-1", ["a@example.com"]));
      expect(result).toMatchObject({ status: "succeeded", grade: "acknowledged" });
      const effect = await s.effect(result.effectId!);
      expect(effect.outcome).toBe("succeeded");
      expect(effect.evidence.at(-1)).toMatchObject({ source: "provider_lookup", impliedOutcome: null });
      expect(effect.evidence.at(-1)!.summary).toMatch(/did not match/);
      expect(writes()).toHaveLength(1);
    });

    it("a provider refusal grades failed, and releases its allowance", async () => {
      await s.declaredAction();
      const limit = await emailLimit(10);
      s.http.locked.add("messages/m-1");
      const result = await s.invoke("send-email", s.email("m-1", ["a@example.com"]));
      expect(result).toMatchObject({ status: "failed", grade: "failed" });
      expect(await s.effect(result.effectId!)).toMatchObject({ outcome: "failed", partialEffect: "none", grade: "failed" });
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 0, reserved: 0, available: 10 });
    });

    it("an approval that is denied grades denied, and an approved one runs once", async () => {
      await s.declaredAction("send-email", { requiresApproval: true });
      const parked = await s.invoke("send-email", s.email("m-1", ["a@example.com"]));
      expect(parked).toMatchObject({ pendingApproval: true, grade: "pending" });
      expect(await s.effect(parked.effectId!)).toMatchObject({ stage: "awaiting_approval", grade: "pending" });
      await m.approvals.denyApproval(s.workspaceId, parked.approvalId!, { deciderKeyId: randomUUID() }, s.environmentId);
      expect(await s.effect(parked.effectId!)).toMatchObject({ stage: "rejected", rejectionReason: "approval_denied", grade: "denied" });
      expect(s.http.requests).toHaveLength(0);

      const second = await s.invoke("send-email", s.email("m-2", ["a@example.com"]));
      const decided = await m.approvals.approveApproval(s.workspaceId, second.approvalId!, { deciderKeyId: randomUUID() }, s.environmentId);
      expect(decided.invocation?.status).toBe("succeeded");
      const effect = await s.effect(second.effectId!);
      expect(effect.grade).toBe("confirmed");
      const [approval] = (await pool.query("SELECT binding_digest FROM approvals WHERE approval_id = $1", [second.approvalId])).rows;
      expect(approval.binding_digest).toBe(effect.bindingDigest);
      expect(writes()).toHaveLength(1);
    });
  });

  describe("a lost response", () => {
    it("is unknown, and reconciliation repeats the read-back without a second write", async () => {
      await s.declaredAction();
      const limit = await emailLimit(10);
      s.http.fault("write", "lose_response_after_commit");
      const result = await s.invoke("send-email", s.email("m-1", ["a@example.com", "b@example.com"]));
      expect(result).toMatchObject({ status: "unknown", grade: "unknown" });
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 0, reserved: 2, unknownExposure: 2 });
      expect(reads()).toHaveLength(0);

      await expect(m.effects.replayEffectOperation(s.workspaceId, s.environmentId, result.effectId!, { type: "user", id: s.userId }))
        .rejects.toMatchObject({ code: "REPLAY_REFUSED", details: { reason: "replay_unsupported" } });
      expect(writes()).toHaveLength(1);

      expect(await s.reconcileNow(result.effectId!)).toBe(true);
      const effect = await s.effect(result.effectId!);
      expect(effect).toMatchObject({ stage: "settled", outcome: "succeeded", grade: "confirmed", verification: "provider" });
      expect(effect.attempts.map((a) => a.kind)).toEqual(["dispatch", "reconcile"]);
      expect(writes()).toHaveLength(1);
      expect(reads()).toHaveLength(1);
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 2, reserved: 0, unknownExposure: 0 });
    });

    it("a read-back that finds nothing never becomes a failure: the effect stays unknown and keeps its allowance", async () => {
      await s.declaredAction();
      const limit = await emailLimit(10);
      s.http.fault("write", "timeout_before_commit");
      const result = await s.invoke("send-email", s.email("m-1", ["a@example.com"]));
      expect(result.status).toBe("unknown");
      for (let i = 0; i < 3; i++) await s.reconcileNow(result.effectId!);
      const effect = await s.effect(result.effectId!);
      expect(effect).toMatchObject({ outcome: "unknown", grade: "unknown", unresolvedExposure: true });
      expect(await s.limitView(limit.id)).toMatchObject({ consumed: 0, reserved: 1, unknownExposure: 1 });
      expect(s.http.writes).toBe(0);
      expect(writes()).toHaveLength(1);
      const resolved = await m.effects.resolveEffectManually(s.workspaceId, s.environmentId, result.effectId!,
        { outcome: "succeeded", reason: "Checked the mailer dashboard: the message was sent." }, { type: "user", id: s.userId });
      expect(resolved).toMatchObject({ outcome: "succeeded", grade: "acknowledged", verification: "manual" });
    });

    it("a verify URL that needs the response cannot be read back, and says so before the write", async () => {
      await s.declaredAction("send-email", { verify: "response" });
      const sent = await s.invoke("send-email", { subject: "Welcome", to: ["a@example.com"] });
      expect(sent).toMatchObject({ status: "succeeded", grade: "confirmed" });
      const confirmed = await s.effect(sent.effectId!);
      expect(confirmed.providerReference).toMatch(/\/v1\/messages\/msg_[0-9a-f]+$/);
      const limitations = confirmed.preview!.blocks.find((b) => b.type === "limitations") as { items: Array<{ kind: string; text: string }> };
      expect(limitations.items.some((i) => i.kind === "unsupported" && /lost response/.test(i.text))).toBe(true);

      s.http.fault("write", "lose_response_after_commit");
      const lost = await s.invoke("send-email", { subject: "Welcome again", to: ["a@example.com"] });
      expect(lost.status).toBe("unknown");
      const before = s.http.requests.length;
      await s.reconcileNow(lost.effectId!);
      expect(await s.effect(lost.effectId!)).toMatchObject({ outcome: "unknown", grade: "unknown" });
      expect(s.http.requests).toHaveLength(before);
      expect(s.http.writes).toBe(2);
    });
  });

  describe("the same admission as an adapter action", () => {
    it("previews, operation keys, preview binding and dependencies all apply", async () => {
      await s.declaredAction();
      const input = s.email("m-1", ["a@example.com"]);
      const preview = await m.effects.createPreviewForAction(s.workspaceId, s.environmentId, "send-email", input);
      expect(preview).toMatchObject({ adapter: { type: "http.declared" }, impact: [{ dimension: "emails", amount: 1, bound: "exact" }] });
      expect((preview.request as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer {{secret:MAILER_TOKEN}}");
      expect(preview.blocks.find((b) => b.type === "impact")).toMatchObject({ title: "Expected impact: 1 email" });
      expect(s.http.requests).toHaveLength(0);

      await expect(s.invoke("send-email", s.email("m-1", ["a@example.com", "b@example.com"]), { effect: { previewId: preview.id } }))
        .rejects.toMatchObject({ code: "PREVIEW_MISMATCH" });
      const first = await s.invoke("send-email", input, { effect: { previewId: preview.id, operationKey: "welcome-m-1" } });
      expect(first.status).toBe("succeeded");
      expect((await s.effect(first.effectId!)).previewId).toBe(preview.id);
      const again = await s.invoke("send-email", input, { effect: { operationKey: "welcome-m-1" } });
      expect(again).toMatchObject({ effectId: first.effectId, replayed: true, grade: "confirmed" });
      await expect(s.invoke("send-email", s.email("m-9", ["a@example.com"]), { effect: { operationKey: "welcome-m-1" } }))
        .rejects.toMatchObject({ code: "OPERATION_KEY_REUSE" });
      expect(writes()).toHaveLength(1);

      const dependent = await s.invoke("send-email", s.email("m-2", ["a@example.com"]), { effect: { dependsOn: [{ effect: first.effectId!, outcome: "succeeded" }] } });
      expect(dependent.status).toBe("succeeded");
      await expect(s.invoke("send-email", s.email("m-3", ["a@example.com"]), { effect: { dependsOn: [{ effect: first.effectId!, outcome: "failed" }] } }))
        .rejects.toMatchObject({ code: "DEPENDENCY_UNRESOLVED" });
    });

    it("no stored request, preview or evidence holds the credential, and the provider still receives it", async () => {
      await s.declaredAction();
      const result = await s.invoke("send-email", s.email("m-1", ["a@example.com"]));
      expect(JSON.stringify(await s.effect(result.effectId!))).not.toContain(HTTP_SIM_TOKEN);
      expect(JSON.stringify(result)).not.toContain(HTTP_SIM_TOKEN);
      const [row] = (await pool.query(
        `SELECT e.request::text AS request, p.request::text AS previewed, p.blocks::text AS blocks
           FROM action_effects e JOIN effect_previews p ON p.id = e.preview_id WHERE e.effect_id = $1`, [result.effectId],
      )).rows;
      expect(row.request).toContain("{{secret:MAILER_TOKEN}}");
      expect(`${row.request}${row.previewed}${row.blocks}`).not.toContain(HTTP_SIM_TOKEN);
      expect(s.http.requests.every((r) => r.authorization === `Bearer ${HTTP_SIM_TOKEN}`)).toBe(true);
    });

    it("an input cannot spell a secret reference into the request", async () => {
      await s.declaredAction();
      await expect(s.invoke("send-email", s.email("m-1", ["a@example.com"], "{{secret:MAILER_TOKEN}}"))).rejects.toThrow(/secret reference/);
      expect(s.http.requests).toHaveLength(0);
    });

    it("a secret binding tightened after review is enforced at dispatch: host and placement", async () => {
      await s.declaredAction("send-email", { requiresApproval: true });
      const approve = (approvalId: string) =>
        m.approvals.approveApproval(s.workspaceId, approvalId, { deciderKeyId: randomUUID() }, s.environmentId);
      const first = await s.invoke("send-email", s.email("m-1", ["a@example.com"]));
      const second = await s.invoke("send-email", s.email("m-2", ["a@example.com"]));

      await m.secrets.putSecret(s.workspaceId, "MAILER_TOKEN", { value: HTTP_SIM_TOKEN, allowedHosts: ["api.other.example"] }, s.environmentId);
      expect((await approve(first.approvalId!)).invocation?.status).toBe("failed");
      const hostRefused = await s.effect(first.effectId!);
      expect(hostRefused).toMatchObject({ stage: "rejected", rejectionReason: "credential_unavailable", grade: "refused" });
      expect(hostRefused.evidence.at(-1)!.summary).toMatch(/may only be sent to api\.other\.example/);

      await m.secrets.putSecret(s.workspaceId, "MAILER_TOKEN",
        { value: HTTP_SIM_TOKEN, allowedHosts: [HTTP_SIM_HOST], allowedPlacements: ["body"] }, s.environmentId);
      expect((await approve(second.approvalId!)).invocation?.status).toBe("failed");
      const placementRefused = await s.effect(second.effectId!);
      expect(placementRefused).toMatchObject({ stage: "rejected", rejectionReason: "credential_unavailable", grade: "refused" });
      expect(placementRefused.evidence.at(-1)!.summary).toMatch(/may only appear in the body/);
      await expect(s.invoke("send-email", s.email("m-3", ["a@example.com"]))).rejects.toThrow(/may only appear in the body/);
      expect(s.http.requests).toHaveLength(0);
    });
  });

  describe("definitions", () => {
    it("declarations are validated when saved, returned on the action, and pinned by version", async () => {
      const created = await s.declaredAction();
      expect(created).toMatchObject({
        governed: true,
        adapter: null,
        impact: { dimension: "emails", unit: "emails", amount: "count(input.to)", bound: "exact" },
        verify: { status: 200, match: [{ path: "subject", equals: "{{input.subject}}" }] },
      });
      const update = (input: Parameters<typeof m.actions.updateAction>[2]) =>
        m.actions.updateAction(s.workspaceId, "send-email", input, m.actions.UNSCOPED_AUTHORITY, s.environmentId);
      await expect(update({ urlTemplate: "https://{{input.host}}/v1/messages/{{input.messageId}}" })).rejects.toThrow(/fixed/);
      await expect(m.actions.createAction(s.workspaceId, { name: "anywhere", urlTemplate: "https://{{input.host}}/v1/messages", governed: true },
        m.actions.UNSCOPED_AUTHORITY, s.environmentId)).rejects.toThrow(/fixed host/);
      await expect(update({ impact: { dimension: "emails", amount: "len(input.to)", bound: "exact" } })).rejects.toThrow(/impact\.amount/);
      await expect(update({ verify: { url: "https://api.other.example/v1/messages/1", status: 200 } })).rejects.toThrow(/own host/);

      await update({ impact: { dimension: "emails", amount: "count(input.to) * 2", bound: "upper_bound" } });
      const edited = await m.actions.getAction(s.workspaceId, "send-email", s.environmentId);
      expect(edited.currentVersionId).not.toBe(created.currentVersionId);
      expect(edited.impact).toMatchObject({ amount: "count(input.to) * 2", bound: "upper_bound" });
      const versions = await m.actions.listActionVersions(s.workspaceId, "send-email", s.environmentId);
      expect(versions.map((v) => [v.governed, v.impact?.amount, v.impact?.bound])).toEqual([
        [true, "count(input.to)", "exact"],
        [true, "count(input.to) * 2", "upper_bound"],
      ]);
      expect(versions[1].verify).toEqual(versions[0].verify);
      const result = await s.invoke("send-email", s.email("m-1", ["a@example.com"]));
      expect((await s.effect(result.effectId!)).impact).toEqual([{ dimension: "emails", amount: 2, bound: "upper_bound" }]);
    });

    it("changing what a governed action declares needs actions:govern, and declaring on a template action does not", async () => {
      const writer = { scopes: ["actions:write", "secrets:read"] };
      await m.actions.createAction(s.workspaceId, {
        name: "plain", method: "PUT", urlTemplate: `https://${HTTP_SIM_HOST}/v1/messages/{{input.messageId}}`,
        headers: { Authorization: "Bearer {{secret:MAILER_TOKEN}}" },
      }, writer, s.environmentId);
      const declared = await m.actions.updateAction(s.workspaceId, "plain",
        { impact: { dimension: "emails", amount: "1", bound: "exact" } }, writer, s.environmentId);
      expect(declared.governed).toBe(true);
      await m.actions.updateAction(s.workspaceId, "plain", { description: "Sends one email" }, writer, s.environmentId);
      await expect(m.actions.updateAction(s.workspaceId, "plain", { governed: false }, writer, s.environmentId)).rejects.toThrow(/actions:govern/);
      await expect(m.actions.updateAction(s.workspaceId, "plain", { impact: { dimension: "emails", amount: "0", bound: "exact" } }, writer, s.environmentId))
        .rejects.toThrow(/actions:govern/);
      const undeclared = await m.actions.updateAction(s.workspaceId, "plain", { governed: false }, { scopes: ["actions:write", "actions:govern", "secrets:read"] }, s.environmentId);
      expect(undeclared).toMatchObject({ governed: false, impact: null, verify: null });
    });

    it("an action with no declaration and no adapter is unchanged: the template executor, and no effect", async () => {
      await m.actions.createAction(s.workspaceId, {
        name: "plain", method: "PUT", urlTemplate: `https://${HTTP_SIM_HOST}/v1/messages/{{input.messageId}}`,
        headers: { Authorization: "Bearer {{secret:MAILER_TOKEN}}" },
        bodyTemplate: { subject: "{{input.subject}}" },
      }, m.actions.UNSCOPED_AUTHORITY, s.environmentId);
      await emailLimit(0);
      const result = await s.invoke("plain", { messageId: "m-1", subject: "Welcome" });
      expect(result).toMatchObject({ status: "succeeded", effectId: null, responseStatus: 200 });
      expect(result.grade).toBeUndefined();
      expect(s.http.resource("messages", "m-1")).toMatchObject({ subject: "Welcome" });
      const [{ n }] = (await pool.query("SELECT count(*)::int AS n FROM action_effects WHERE workspace_id = $1", [s.workspaceId])).rows;
      expect(n).toBe(0);
      await expect(s.invoke("plain", { messageId: "m-2", subject: "x" }, { effect: { operationKey: "op-1" } })).rejects.toThrow(/governed actions/);
      await expect(m.effects.createPreviewForAction(s.workspaceId, s.environmentId, "plain", { messageId: "m-2", subject: "x" })).rejects.toThrow(/no declaration/);
    });

    it("an adapter action cannot also carry declarations, and http.declared cannot be named as an adapter", async () => {
      await s.refundAction();
      await expect(m.actions.updateAction(s.workspaceId, "refund", { impact: { dimension: "emails", amount: "1", bound: "exact" } },
        m.actions.UNSCOPED_AUTHORITY, s.environmentId)).rejects.toThrow(/already governed/);
      await expect(m.actions.createAction(s.workspaceId, {
        name: "sneaky", urlTemplate: "", adapter: { type: "http.declared", config: {}, credentialSecret: "MAILER_TOKEN" },
      }, m.actions.UNSCOPED_AUTHORITY, s.environmentId)).rejects.toThrow(/Unknown adapter/);
    });
  });
});
