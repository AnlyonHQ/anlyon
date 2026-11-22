import { performance } from "node:perf_hooks";
import { Environment } from "@marcbachmann/cel-js";
import { evaluateCondition, evaluateConditions, type ConditionFacts } from "../src/core/approvals/condition.ts";

const facts: ConditionFacts = {
  input: { amount: 700, currency: "USD", lines: [1, 2, 3] },
  agent: { id: null }, user: { id: null }, action: { name: "refund" },
  kind: "action", tags: [], environment: { id: "synthetic" },
};
const source = 'input.amount >= 500 && input.currency == "USD" && input.lines.all(x, x > 0)';
const inline = new Environment().registerVariable("input", "map").parse(source);
const startCold = performance.now();
if (!("result" in await evaluateCondition(source, facts))) throw new Error("Worker startup failed");
const coldMs = performance.now() - startCold;

async function measure(name: string, run: () => unknown | Promise<unknown>, rounds = 125) {
  const durations: number[] = [];
  let errors = 0;
  const started = performance.now();
  for (let batch = 0; batch < rounds; batch++) {
    await Promise.all(Array.from({ length: 8 }, async () => {
      const start = performance.now();
      const result = await run();
      durations.push(performance.now() - start);
      if (result !== true && !(typeof result === "object" && result && "result" in result && result.result === true)) errors++;
    }));
  }
  const elapsedMs = performance.now() - started;
  durations.sort((a, b) => a - b);
  const at = (q: number) => durations[Math.min(durations.length - 1, Math.floor(durations.length * q))];
  return { name, samples: durations.length, concurrency: 8, p50Ms: at(0.5), p95Ms: at(0.95),
    elapsedMs, perSecond: durations.length * 1000 / elapsedMs, errors };
}

const POLICIES = 250;
const { environment, ...requestFacts } = facts;
const many = Array.from({ length: POLICIES }, (_, i) => ({
  source: i === POLICIES - 1 ? source : `input.amount == ${i}`, environmentId: environment.id,
}));
const sequential = async () => {
  for (const item of many) {
    const outcome = await evaluateCondition(item.source, facts);
    if ("error" in outcome) return outcome;
    if (outcome.result) return true;
  }
  return false;
};
const batched = async () => {
  const outcome = await evaluateConditions(many, requestFacts);
  return outcome.index === POLICIES - 1 && "result" in outcome;
};

const results = [
  await measure("inline library comparator (no isolation)", () => inline(facts)),
  await measure("bounded worker evaluation", () => evaluateCondition(source, facts)),
  await measure(`${POLICIES} policies, one round trip each (previous engine)`, sequential, 13),
  await measure(`${POLICIES} policies, one batched round trip (current engine)`, batched, 13),
];
const pathological = await evaluateCondition('input.text.matches("^(a+)+$")', {
  ...facts, input: { text: "a".repeat(100) + "!" },
});
const recovered = await evaluateCondition("true", facts);
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, coldMs,
  rssBytes: process.memoryUsage().rss, results, pathological, recovered }, null, 2));
if (results.some((r) => r.errors) || !("error" in pathological) || !("result" in recovered && recovered.result)) process.exitCode = 1;
