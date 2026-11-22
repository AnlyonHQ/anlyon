import { spawn, type ChildProcess } from "node:child_process";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { evaluateCondition, evaluateConditions, type ConditionFacts } from "../src/core/approvals/condition.ts";

const seconds = Number(process.argv[2] ?? 20);
const levels = (process.argv[3] ?? "0,2,4,8").split(",").map(Number);
const CONCURRENCY = 8;
const facts: ConditionFacts = {
  input: { amount: 700, currency: "USD", lines: [1, 2, 3] }, agent: { id: null }, user: { id: null },
  action: { name: "refund" }, kind: "action", tags: [], environment: { id: "synthetic" },
};
const source = 'input.amount >= 500 && input.currency == "USD" && input.lines.all(x, x > 0)';
const { environment, ...requestFacts } = facts;
const many = Array.from({ length: 250 }, (_, i) => ({ source: i === 249 ? source : `input.amount == ${i}`, environmentId: environment.id }));

function hogs(n: number): ChildProcess[] {
  const code = "let x=0;for(;;){x=(x*1103515245+12345)%2147483648}";
  return Array.from({ length: n }, () => spawn(process.execPath, ["-e", code], { stdio: "ignore" }));
}

async function phase(name: string, run: () => Promise<boolean>) {
  const durations: number[] = [];
  let errors = 0;
  const deadline = performance.now() + seconds * 1000;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (performance.now() < deadline) {
      const start = performance.now();
      const ok = await run();
      durations.push(performance.now() - start);
      if (!ok) errors++;
    }
  }));
  durations.sort((a, b) => a - b);
  const at = (q: number) => durations[Math.min(durations.length - 1, Math.floor(durations.length * q))] ?? NaN;
  return { name, samples: durations.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), errors, errorRate: errors / Math.max(1, durations.length) };
}

const results = [];
await evaluateCondition(source, facts);
for (const level of levels) {
  const children = hogs(level);
  await new Promise((r) => setTimeout(r, 1500));
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const batched = await phase("250 policies, batched", async () => {
    const o = await evaluateConditions(many, requestFacts);
    return o.index === 249 && "result" in o;
  });
  const single = await phase("single condition", async () => {
    const o = await evaluateCondition(source, facts);
    return "result" in o && o.result;
  });
  loop.disable();
  for (const child of children) child.kill();
  results.push({ busyProcesses: level, batched, single, eventLoopDelayMs: { p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6 } });
  await new Promise((r) => setTimeout(r, 1500));
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, cores: cpus().length, secondsPerPhase: seconds, concurrency: CONCURRENCY, results }, null, 2));
process.exit(0);
