import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const dialect = new PgDialect();
type AdviceState = { id: string; approvalId: string; workspaceId: string; auditRequested: boolean; auditVerdict: string | null; auditedByUserId: string | null; auditedAt: Date | null };
const state = vi.hoisted(() => ({
  approval: null as { id: string; workspaceId: string; approvalId: string } | null,
  advice: null as AdviceState | null,
  updateWhere: [] as string[],
}));

vi.mock("../src/db/index.ts", async () => {
  const { approvals } = await import("../src/db/schema/approvals.ts");
  const adviceRow = () => ({
    status: "ready", statusReason: null, model: "jev-1", recommendation: "approve", risk: 0.2, confidence: 0.95,
    reasons: [], flags: null, history: null, createdAt: new Date(), completedAt: new Date(), ...state.advice,
  });
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              if (table === approvals) return state.approval ? [state.approval] : [];
              return state.advice ? [adviceRow()] : [];
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: Partial<AdviceState>) => ({
          where: (condition: SQL) => ({
            returning: async () => {
              const where = dialect.sqlToQuery(condition).sql;
              state.updateWhere.push(where);
              const guarded = where.includes('"audit_requested" = $') && where.includes('"audit_verdict" is null');
              const a = state.advice;
              if (!a || (guarded && (!a.auditRequested || a.auditVerdict !== null))) return [];
              Object.assign(a, values);
              return [adviceRow()];
            },
          }),
        }),
      }),
    },
  };
});
vi.mock("../src/lib/redis.ts", () => ({ redis: {} }));
vi.mock("../src/lib/logger.ts", () => {
  const l = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { logger: l, apiLogger: l, createLogger: () => l };
});

import { recordAuditVerdict } from "../src/core/assistant/service.ts";
import { ConflictError } from "../src/utils/errors.ts";

beforeEach(() => {
  state.approval = { id: "a-internal", workspaceId: "ws-1", approvalId: "apr_1" };
  state.advice = {
    id: "adv-1", approvalId: "a-internal", workspaceId: "ws-1",
    auditRequested: true, auditVerdict: null, auditedByUserId: null, auditedAt: null,
  };
  state.updateWhere = [];
});

describe("recordAuditVerdict", () => {
  it("records a verdict once on a sampled decision, with who and when", async () => {
    const view = await recordAuditVerdict("ws-1", "apr_1", "disagree", "admin-1");
    expect(view).toMatchObject({ auditRequested: true, auditVerdict: "disagree" });
    expect(state.advice).toMatchObject({ auditVerdict: "disagree", auditedByUserId: "admin-1" });
    expect(state.advice?.auditedAt).toBeInstanceOf(Date);
    expect(state.updateWhere[0]).toContain('"audit_requested" = $');
    expect(state.updateWhere[0]).toContain('"audit_verdict" is null');
    expect(state.updateWhere[0]).toContain('"workspace_id" = $');
  });

  it("refuses a second verdict with 409 and keeps the first", async () => {
    await recordAuditVerdict("ws-1", "apr_1", "disagree", "admin-1");
    const second = recordAuditVerdict("ws-1", "apr_1", "agree", "admin-2");
    await expect(second).rejects.toBeInstanceOf(ConflictError);
    await expect(recordAuditVerdict("ws-1", "apr_1", "agree", "admin-2")).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/already been audited/) });
    expect(state.advice).toMatchObject({ auditVerdict: "disagree", auditedByUserId: "admin-1" });
  });

  it("refuses a decision that was not sampled for audit with 409", async () => {
    state.advice!.auditRequested = false;
    await expect(recordAuditVerdict("ws-1", "apr_1", "agree", "admin-1"))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/not sampled for audit/) });
    expect(state.advice?.auditVerdict).toBeNull();
  });

  it("returns null (404 at the route) when the approval or its advice does not exist", async () => {
    state.advice = null;
    expect(await recordAuditVerdict("ws-1", "apr_1", "agree", "admin-1")).toBeNull();
    state.approval = null;
    expect(await recordAuditVerdict("ws-1", "apr_1", "agree", "admin-1")).toBeNull();
  });
});
