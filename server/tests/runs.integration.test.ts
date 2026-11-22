import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://anlyon:anlyon@localhost:5433/anlyon_test";

let available = false;

beforeAll(async () => {
  const probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  try {
    await probe.query("SELECT 1");
    available = true;
  } catch {
    available = false;
  } finally {
    await probe.end().catch(() => {});
  }
});

async function seedScope(pool: Pool, envSvc: typeof import("../src/core/environments/service.ts")) {
  const ws = await pool.query(`INSERT INTO workspaces (name, slug, plan) VALUES ('WS', $1, 'enterprise') RETURNING id`, [
    `ws-${randomUUID().slice(0, 8)}`,
  ]);
  const workspaceId = ws.rows[0].id;
  const env = await envSvc.ensureDefaultEnvironment(workspaceId);
  return { workspaceId, environmentId: env.id };
}

const T0 = "2026-07-15T00:00:00.000Z";
const T1 = "2026-07-15T00:00:01.000Z";

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("runs + spans (real Postgres)", () => {
  let pool: Pool;
  let runsSvc: typeof import("../src/core/runs/service.ts");
  let envSvc: typeof import("../src/core/environments/service.ts");

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    runsSvc = await import("../src/core/runs/service.ts");
    envSvc = await import("../src/core/environments/service.ts");
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  it("starts a run scoped to the environment and ends it with a duration", async () => {
    const scope = await seedScope(pool, envSvc);
    const run = await runsSvc.startRun(scope, { name: "job", input: { q: 1 } });
    expect(run.id).toMatch(/^run_/);
    expect(run.environmentId).toBe(scope.environmentId);
    expect(run.status).toBe("running");

    const ended = await runsSvc.endRun(scope, run.id, { status: "succeeded", tokens: 42 });
    expect(ended.status).toBe("succeeded");
    expect(ended.tokens).toBe(42);
    expect(ended.durationMs).not.toBeNull();
  });

  it("ingests spans idempotently  a resent batch updates, never duplicates", async () => {
    const scope = await seedScope(pool, envSvc);
    const run = await runsSvc.startRun(scope, { name: "idem" });

    const batch = [
      { id: "span_root", name: "root", type: "custom" as const, startedAt: T0, endedAt: T1 },
      { id: "span_child", parentId: "span_root", name: "child", type: "model_call" as const, startedAt: T0 },
    ];
    const first = await runsSvc.ingestSpans(scope, run.id, batch);
    expect(first.ingested).toBe(2);

    const second = await runsSvc.ingestSpans(scope, run.id, [
      { id: "span_child", parentId: "span_root", name: "child-renamed", type: "model_call" as const, startedAt: T0 },
    ]);
    expect(second.ingested).toBe(1);

    const { spans } = await runsSvc.getRunWithTree(scope, run.id);
    expect(spans).toHaveLength(1);
    expect(spans[0].id).toBe("span_root");
    expect(spans[0].children).toHaveLength(1);
    expect(spans[0].children[0].name).toBe("child-renamed");
  });

  it("rolls span tokens and cost up to run totals, idempotently under re-ingest", async () => {
    const scope = await seedScope(pool, envSvc);
    const run = await runsSvc.startRun(scope, { name: "usage" });

    await runsSvc.ingestSpans(scope, run.id, [
      { id: "s1", name: "call-1", type: "model_call" as const, startedAt: T0, endedAt: T1,
        model: "claude-sonnet-5", provider: "anthropic", tokens: { input: 100, output: 50, total: 150 }, cost: 0.012 },
      { id: "s2", name: "call-2", type: "model_call" as const, startedAt: T0, endedAt: T1,
        tokens: { input: 200, output: 80 }, cost: 0.03 },
      { id: "s3", name: "tool", type: "tool_call" as const, startedAt: T0, endedAt: T1 },
    ]);

    let { run: fetched } = await runsSvc.getRunWithTree(scope, run.id);
    expect(fetched.tokens).toBe(430);
    expect(fetched.cost).toBeCloseTo(0.042, 6);

    await runsSvc.ingestSpans(scope, run.id, [
      { id: "s1", name: "call-1", type: "model_call" as const, startedAt: T0, endedAt: T1,
        model: "claude-sonnet-5", provider: "anthropic", tokens: { input: 100, output: 50, total: 150 }, cost: 0.012 },
    ]);
    ({ run: fetched } = await runsSvc.getRunWithTree(scope, run.id));
    expect(fetched.tokens).toBe(430);
    expect(fetched.cost).toBeCloseTo(0.042, 6);

    await runsSvc.ingestSpans(scope, run.id, [
      { id: "s4", name: "tool-2", type: "tool_call" as const, startedAt: T0, endedAt: T1 },
    ]);
    ({ run: fetched } = await runsSvc.getRunWithTree(scope, run.id));
    expect(fetched.tokens).toBe(430);

    const ended = await runsSvc.endRun(scope, run.id, { status: "succeeded", tokens: 999, cost: 1.5 });
    expect(ended.tokens).toBe(999);
    expect(ended.cost).toBeCloseTo(1.5, 6);
  });

  it("assembles a multi-level span tree from parent pointers", async () => {
    const scope = await seedScope(pool, envSvc);
    const run = await runsSvc.startRun(scope, { name: "tree" });
    await runsSvc.ingestSpans(scope, run.id, [
      { id: "a", name: "a", startedAt: T0 },
      { id: "b", parentId: "a", name: "b", startedAt: T0 },
      { id: "c", parentId: "b", name: "c", startedAt: T0 },
    ]);
    const { spans } = await runsSvc.getRunWithTree(scope, run.id);
    expect(spans[0].id).toBe("a");
    expect(spans[0].children[0].id).toBe("b");
    expect(spans[0].children[0].children[0].id).toBe("c");
  });

	 it("exports a trace as OTLP/JSON with stable trace and parent IDs", async () => {
		const scope = await seedScope(pool, envSvc);
		const run = await runsSvc.startRun(scope, { name: "otel", application: "agent" });
		await runsSvc.ingestSpans(scope, run.id, [
			{ id: "root", name: "root", startedAt: T0, endedAt: T1 },
			{ id: "child", parentId: "root", name: "child", startedAt: T0, endedAt: T1 },
		]);
		const trace = await runsSvc.getRunWithTree(scope, run.id);
		const exported = runsSvc.exportRunAsOtlp(trace.run, trace.spans);
		const spans = exported.resourceSpans[0].scopeSpans[0].spans;
		expect(spans).toHaveLength(2);
		expect(spans[0].traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(spans[1].parentSpanId).toBe(spans[0].spanId);
	});

  it("round-trips a bounded OTLP trace into a new run in the destination environment", async () => {
    const sourceScope = await seedScope(pool, envSvc);
    const destinationScope = await seedScope(pool, envSvc);
    const source = await runsSvc.startRun(sourceScope, { name: "source", application: "source-agent" });
    await runsSvc.ingestSpans(sourceScope, source.id, [
      { id: "root", name: "root", startedAt: T0, endedAt: T1, attributes: { apiKey: "redact-me" } },
      { id: "child", parentId: "root", name: "child", startedAt: T0, endedAt: T1 },
    ]);
    const sourceTrace = await runsSvc.getRunWithTree(sourceScope, source.id);
    const imported = await runsSvc.importOtlpTrace(
      destinationScope,
      runsSvc.exportRunAsOtlp(sourceTrace.run, sourceTrace.spans),
    );

    expect(imported.id).not.toBe(source.id);
    expect(imported.environmentId).toBe(destinationScope.environmentId);
    expect(imported.application).toBe("source-agent");
    expect(imported.status).toBe("succeeded");
    expect(imported.startedAt).toBe(T0);
    const trace = await runsSvc.getRunWithTree(destinationScope, imported.id);
    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0].id).toBe("root");
    expect(trace.spans[0].children[0].id).toBe("child");
    expect((trace.spans[0].attributes as Record<string, unknown>).apiKey).toBe("[REDACTED]");
  });

  it("rejects OTLP traces with dangling or cyclic parent links", async () => {
    const scope = await seedScope(pool, envSvc);
    const base = {
      resourceSpans: [{ scopeSpans: [{ spans: [
        { spanId: "a", parentSpanId: "missing", name: "a", startTimeUnixNano: "1760000000000000000" },
      ] }] }],
    };
    await expect(runsSvc.importOtlpTrace(scope, base)).rejects.toThrow(/parent span/);
    await expect(runsSvc.importOtlpTrace(scope, {
      resourceSpans: [{ scopeSpans: [{ spans: [
        { spanId: "a", parentSpanId: "b", name: "a", startTimeUnixNano: "1760000000000000000" },
        { spanId: "b", parentSpanId: "a", name: "b", startTimeUnixNano: "1760000000000000000" },
      ] }] }],
    })).rejects.toThrow(/cyclic/);
  });

  it("redacts sensitive keys in run and span payloads", async () => {
    const scope = await seedScope(pool, envSvc);
    const run = await runsSvc.startRun(scope, { name: "redact", input: { apiKey: "sk-secret", q: "keep" } });
    await runsSvc.ingestSpans(scope, run.id, [
      { id: "s", name: "s", startedAt: T0, input: { password: "hunter2", visible: "ok" } },
    ]);

    const fetched = await runsSvc.getRunWithTree(scope, run.id);
    expect((fetched.run.input as Record<string, unknown>).apiKey).toBe("[REDACTED]");
    expect((fetched.run.input as Record<string, unknown>).q).toBe("keep");
    expect((fetched.spans[0].input as Record<string, unknown>).password).toBe("[REDACTED]");
    expect((fetched.spans[0].input as Record<string, unknown>).visible).toBe("ok");
  });

  it("rejects a span batch over the bound", async () => {
    const scope = await seedScope(pool, envSvc);
    const run = await runsSvc.startRun(scope, { name: "bound" });
    const tooMany = Array.from({ length: 501 }, (_, i) => ({ id: `s${i}`, name: "s", startedAt: T0 }));
    await expect(runsSvc.ingestSpans(scope, run.id, tooMany)).rejects.toThrow();
  });

  it("lists and filters runs, newest first", async () => {
    const scope = await seedScope(pool, envSvc);
    const tag = `q${randomUUID().slice(0, 8)}`;
    await runsSvc.startRun(scope, { name: `one-${tag}` });
    const two = await runsSvc.startRun(scope, { name: `two-${tag}` });
    await runsSvc.endRun(scope, two.id, { status: "failed" });

    const all = await runsSvc.listRuns(scope, { limit: 20, offset: 0 });
    expect(all.total).toBe(2);
    expect(all.runs[0].name).toBe(`two-${tag}`);

    const failed = await runsSvc.listRuns(scope, { status: "failed", limit: 20, offset: 0 });
    expect(failed.runs.map((r) => r.name)).toEqual([`two-${tag}`]);

    const searched = await runsSvc.listRuns(scope, { search: `two-${tag}`, limit: 20, offset: 0 });
    expect(searched.runs.map((r) => r.name)).toEqual([`two-${tag}`]);

    const byId = await runsSvc.listRuns(scope, { search: two.id, limit: 20, offset: 0 });
    expect(byId.runs.map((r) => r.name)).toEqual([`two-${tag}`]);
  });

  it("reads workspace-wide across environments when no environment is scoped (dashboard path)", async () => {
    const a = await seedScope(pool, envSvc);
    const staging = await envSvc.createEnvironment(a.workspaceId, { name: "Staging", slug: "staging" });
    await runsSvc.startRun(a, { name: "prod-run" });
    await runsSvc.startRun({ workspaceId: a.workspaceId, environmentId: staging.id }, { name: "staging-run" });

    const all = await runsSvc.listRuns({ workspaceId: a.workspaceId }, { limit: 20, offset: 0 });
    expect(all.total).toBe(2);
    expect(all.runs.map((r) => r.name).sort()).toEqual(["prod-run", "staging-run"]);

    const stagingOnly = await runsSvc.listRuns(
      { workspaceId: a.workspaceId, environmentId: staging.id },
      { limit: 20, offset: 0 },
    );
    expect(stagingOnly.runs.map((r) => r.name)).toEqual(["staging-run"]);
  });

  it("attaches and lists feedback on a run and a span", async () => {
    const scope = await seedScope(pool, envSvc);
    const run = await runsSvc.startRun(scope, { name: "fb" });
    await runsSvc.ingestSpans(scope, run.id, [{ id: "s1", name: "step", startedAt: T0 }]);

    const runFb = await runsSvc.addFeedback(scope, run.id, { label: "thumbs_up", rating: 1 }, "user_1");
    expect(runFb.id).toMatch(/^fbk_/);
    expect(runFb.spanId).toBeNull();
    expect(runFb.rating).toBe(1);

    const spanFb = await runsSvc.addFeedback(scope, run.id, {
      spanId: "s1",
      source: "model",
      label: "correctness",
      rating: 0.8,
    });
    expect(spanFb.spanId).toBe("s1");
    expect(spanFb.source).toBe("model");

    const all = await runsSvc.listFeedback(scope, run.id);
    expect(all).toHaveLength(2);
    expect(all.map((f) => f.label).sort()).toEqual(["correctness", "thumbs_up"]);
  });

  it("does not attach feedback to a run in another workspace", async () => {
    const a = await seedScope(pool, envSvc);
    const b = await seedScope(pool, envSvc);
    const run = await runsSvc.startRun(a, { name: "owned" });
    await expect(runsSvc.addFeedback(b, run.id, { label: "x" })).rejects.toThrow();
  });

  it("isolates runs across environments and workspaces", async () => {
    const a = await seedScope(pool, envSvc);
    const staging = await envSvc.createEnvironment(a.workspaceId, { name: "Staging", slug: "staging" });
    const b = await seedScope(pool, envSvc);

    const run = await runsSvc.startRun(a, { name: "prod-only" });

    await expect(
      runsSvc.getRunWithTree({ workspaceId: a.workspaceId, environmentId: staging.id }, run.id),
    ).rejects.toThrow();
    await expect(runsSvc.getRunWithTree(b, run.id)).rejects.toThrow();

    const stagingList = await runsSvc.listRuns(
      { workspaceId: a.workspaceId, environmentId: staging.id },
      { limit: 20, offset: 0 },
    );
    expect(stagingList.total).toBe(0);
  });
});
