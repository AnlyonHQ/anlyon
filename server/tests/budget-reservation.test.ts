import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ApiError } from "../src/utils/errors.ts";

const mocks = vi.hoisted(() => ({ reserve: vi.fn(), settle: vi.fn(), refund: vi.fn() }));
vi.mock("../src/core/billing/budgets.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../src/core/billing/budgets.ts")>(),
  reserveBudget: mocks.reserve, settleBudget: mocks.settle, refundBudget: mocks.refund,
  claimAlertSlot: vi.fn().mockResolvedValue(false),
}));
vi.mock("../src/core/billing/budget-tracing.ts", () => ({ recordBudgetDecision: vi.fn() }));
const { budgetGuard } = await import("../src/api/middleware/budget.ts");
const usageBefore = { messages: 0, eventPublishes: 0, actionInvokes: 0 };
const config = { enabled: true, workspaceId: "ws", dimensionCaps: { actionInvokes: 50 }, monthlyCostCentsCap: null, alertThreshold: .8 };
const admitted = { allowed: true, replayed: false, usageBefore, config, month: "2026-09", reservationId: "reservation" };
function app(
  handler: () => void = () => {},
  options: { units: number; session: boolean; dimension?: "actionInvokes" | "messages" } = { units: 1, session: false },
) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("authType", options.session ? "session" : "apiKey");
    c.set("apiKeyId", "key"); c.set("workspaceId", "ws"); c.set("environmentId", "env");
    c.set("requestId", "untrusted-request-id");
    await next();
  });
  a.post("/", budgetGuard(options.dimension ?? "actionInvokes", () => options.units), c => { handler(); return c.json({ ok: true }); });
  a.onError((err, c) => c.json({ error: err.message }, err instanceof ApiError ? err.statusCode as 429 : 500));
  return a;
}
beforeEach(() => { vi.clearAllMocks(); mocks.reserve.mockResolvedValue(admitted); });
describe("durable admission guard", () => {
  it("passes trusted scope and quantity; request IDs do not select reservations", async () => {
    const a = app(() => {}, { units: 7, session: false });
    expect((await a.request("/", { method: "POST" })).status).toBe(200);
    await a.request("/", { method: "POST" });
    const first = mocks.reserve.mock.calls[0][0];
    expect(first).toMatchObject({ workspaceId: "ws", environmentId: "env", apiKeyId: "key", dimension: "actionInvokes", amount: 7 });
    expect(first.effectId).not.toBe("untrusted-request-id");
    expect(first.effectId).not.toBe(mocks.reserve.mock.calls[1][0].effectId);
    expect(mocks.settle).not.toHaveBeenCalled();
  });
  it("still settles other dimensions on success, because for them the handler is the whole effect", async () => {
    const a = app(() => {}, { units: 1, session: false, dimension: "messages" });
    expect((await a.request("/", { method: "POST" })).status).toBe(200);
    expect(mocks.settle).toHaveBeenCalledWith("reservation");
  });
  it("refuses the whole quantity before invoking the handler", async () => {
    mocks.reserve.mockResolvedValue({ ...admitted, allowed: false, usageBefore: { ...usageBefore, actionInvokes: 45 } });
    const handler = vi.fn();
    const res = await app(handler, { units: 10, session: false }).request("/", { method: "POST" });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain("10 actionInvokes");
    expect(handler).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });
  it("holds uncertain work when a handler fails after a side effect", async () => {
    const effect = vi.fn();
    const res = await app(() => { effect(); throw new Error("failure after acceptance"); }).request("/", { method: "POST" });
    expect(res.status).toBe(500);
    expect(effect).toHaveBeenCalledOnce();
    expect(mocks.refund).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });
  it("does not execute a durable replay even when the budget is now disabled", async () => {
    mocks.reserve.mockResolvedValue({ ...admitted, replayed: true, config: null });
    const handler = vi.fn();
    expect((await app(handler).request("/", { method: "POST" })).status).toBe(409);
    expect(handler).not.toHaveBeenCalled();
  });
  it("serves an unbudgeted key without settling a nonexistent reservation", async () => {
    mocks.reserve.mockResolvedValue({ ...admitted, reservationId: undefined, config: null });
    expect((await app().request("/", { method: "POST" })).status).toBe(200);
    expect(mocks.settle).not.toHaveBeenCalled();
  });
  it("does not budget session requests", async () => {
    expect((await app(() => {}, { units: 1, session: true }).request("/", { method: "POST" })).status).toBe(200);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
});
