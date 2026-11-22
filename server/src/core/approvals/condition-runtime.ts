import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const WORKERS = 2;
const MAX_QUEUED = 32;
const QUEUE_MS = 2000;
const EXECUTION_MS = 250;
const STARTUP_MS = 5000;
const libraryUrl = pathToFileURL(createRequire(import.meta.url).resolve("@marcbachmann/cel-js")).href;

const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { createContext, Script } = require('node:vm');
import(workerData.libraryUrl).then(({ Environment }) => {
  const env = new Environment({ limits: workerData.limits, homogeneousAggregateLiterals: false });
  for (const [name, type] of workerData.variables) env.registerVariable(name, type);
  const cache = new Map();
  const context = createContext({});
  const script = new Script('run()');
  parentPort.on('message', ({ items, facts }) => {
    const state = { index: 0 };
    context.run = () => {
      for (let index = 0; index < items.length; index++) {
        state.index = index;
        const { source, environmentId } = items[index];
        let program = cache.get(source);
        if (!program) {
          program = env.parse(source);
          if (cache.size >= 1000) cache.delete(cache.keys().next().value);
          cache.set(source, program);
        }
        const result = program({ ...facts, environment: { id: environmentId } });
        if (result === false) continue;
        return result === true
          ? { index: state.index, result: true }
          : { index: state.index, error: 'The condition did not produce true or false.' };
      }
      return { index: -1 };
    };
    try {
      parentPort.postMessage(script.runInContext(context, { timeout: workerData.executionMs }));
    } catch (error) {
      if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        parentPort.postMessage({ index: state.index, timedOut: true, error: 'Condition execution exceeded ' + workerData.executionMs + ' ms.' });
      } else {
        const code = typeof error?.code === 'string' ? error.code : 'evaluation_error';
        parentPort.postMessage({ index: state.index, error: 'Condition evaluation failed: ' + code });
      }
    } finally {
      context.run = undefined;
    }
  });
  parentPort.postMessage({ ready: true });
});
`;

export interface ConditionItem { source: string; environmentId: string }
export type BatchOutcome = { index: -1 } | { index: number; result: true } | { index: number; error: string };
type Job = { items: ConditionItem[]; facts: unknown; finish: (result: BatchOutcome) => void; timer: ReturnType<typeof setTimeout> };
type Slot = { worker: Worker; ready: boolean; stopped: boolean; job?: Job; timer?: ReturnType<typeof setTimeout> };

export function conditionRuntime(limits: Record<string, number>, variables: ReadonlyArray<readonly [string, string]>) {
  const slots = new Set<Slot>();
  const queue: Job[] = [];

  function stop(slot: Slot, message: string) {
    if (slot.stopped) return;
    slot.stopped = true;
    clearTimeout(slot.timer);
    slot.job?.finish({ index: 0, error: message });
    slot.job = undefined;
    void slot.worker.terminate().finally(() => { slots.delete(slot); pump(); });
  }

  function start() {
    let worker: Worker;
    try {
      worker = new Worker(workerSource, {
        eval: true,
        workerData: { libraryUrl, limits, variables, executionMs: EXECUTION_MS },
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
        execArgv: [],
      });
    } catch {
      for (const job of queue.splice(0)) { clearTimeout(job.timer); job.finish({ index: 0, error: "Condition worker unavailable." }); }
      return;
    }
    const slot: Slot = { worker, ready: false, stopped: false };
    slots.add(slot);
    slot.timer = setTimeout(() => stop(slot, "Condition worker startup timed out."), STARTUP_MS);
    worker.on("error", () => stop(slot, "Condition worker failed or exceeded its memory limit."));
    worker.on("exit", () => stop(slot, "Condition worker exited."));
    worker.on("message", (message: (BatchOutcome & { timedOut?: true }) | { ready: true }) => {
      if (slot.stopped) return;
      clearTimeout(slot.timer);
      if ("timedOut" in message && message.timedOut) {
        const { timedOut: _timedOut, ...outcome } = message;
        slot.job?.finish(outcome as BatchOutcome);
        slot.job = undefined;
        stop(slot, "Condition worker retired after a timeout.");
        return;
      }
      if ("ready" in message) slot.ready = true;
      else {
        slot.job?.finish(message);
        slot.job = undefined;
      }
      worker.unref();
      pump();
    });
    worker.unref();
  }

  function pump() {
    for (const slot of slots) {
      if (!queue.length) break;
      if (!slot.ready || slot.stopped || slot.job) continue;
      const job = queue.shift();
      if (!job) break;
      clearTimeout(job.timer);
      slot.job = job;
      slot.worker.ref();
      slot.timer = setTimeout(() => stop(slot, "Condition worker response timed out."), QUEUE_MS);
      try { slot.worker.postMessage({ items: job.items, facts: job.facts }); }
      catch { stop(slot, "Condition facts could not be transferred."); }
    }
    if (queue.length && slots.size < WORKERS) start();
  }

  return (items: ConditionItem[], facts: unknown): Promise<BatchOutcome> => {
    if (!items.length) return Promise.resolve({ index: -1 });
    if (queue.length >= MAX_QUEUED) return Promise.resolve({ index: 0, error: "Condition evaluation capacity exceeded." });
    return new Promise((finish) => {
      const job: Job = {
        items, facts, finish,
        timer: setTimeout(() => {
          const index = queue.indexOf(job);
          if (index !== -1) queue.splice(index, 1);
          finish({ index: 0, error: "Condition evaluation queue timed out." });
        }, QUEUE_MS),
      };
      queue.push(job);
      pump();
    });
  };
}
