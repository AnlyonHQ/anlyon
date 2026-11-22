import { describe, expect, it } from "vitest";
import { MAX_OUTPUT_BYTES, MAX_RESPONSE_BYTES, RunnerTimeoutError, sendRun, type RunnerRunRequest } from "./runner-client.ts";
import { verifyRunnerRequest } from "./runner-signing.ts";

const config = { url: "https://runner.anlyon.test", secret: "test-runner-shared-secret-at-least-32-chars" };
const request: RunnerRunRequest = {
  runId: "frn_1",
  functionVersionId: "fnv_1",
  digest: "sha256:00",
  language: "javascript",
  source: "export default () => 1",
  input: {},
  mode: "straight_through",
  allowedActions: [],
  budgets: { maxActionCalls: 50, maxCpuMs: 1000, maxSubrequests: 100, timeoutMs: 30000 },
  runToken: "frt_v1.a.b",
};
const answer = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the runner client", () => {
  it("signs POST /run with the shared secret", async () => {
    let seen: { url: string; signature: string | null; body: string } | null = null;
    const send = (async (url: URL, init: RequestInit) => {
      seen = { url: String(url), signature: new Headers(init.headers).get("Anlyon-Runner-Signature"), body: String(init.body) };
      return new Response(JSON.stringify({ status: "succeeded", output: 2, logs: ["a"], durationMs: 3 }));
    }) as unknown as typeof fetch;
    expect(await sendRun(request, config, send)).toEqual({ status: "succeeded", output: 2, logs: ["a"], durationMs: 3 });
    expect(seen!.url).toBe("https://runner.anlyon.test/run");
    expect(verifyRunnerRequest(config.secret, seen!.signature, "POST", "/run", seen!.body)).toBe(true);
  });

  it("answers 503 FUNCTION_RUNNER_UNAVAILABLE when unconfigured, unreachable, refusing or garbled", async () => {
    await expect(sendRun(request, null)).rejects.toMatchObject({ statusCode: 503, code: "FUNCTION_RUNNER_UNAVAILABLE" });
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(sendRun(request, config, down)).rejects.toMatchObject({ statusCode: 503 });
    await expect(sendRun(request, config, answer({ error: "no" }, 401) as unknown as typeof fetch)).rejects.toMatchObject({ statusCode: 503 });
    await expect(sendRun(request, config, answer({ status: "maybe" }) as unknown as typeof fetch)).rejects.toMatchObject({ statusCode: 503 });
  });

  it("takes a runner that does not answer in time as a timeout, not an outage", async () => {
    const slow = (async () => { throw new DOMException("timed out", "TimeoutError"); }) as unknown as typeof fetch;
    await expect(sendRun(request, config, slow)).rejects.toBeInstanceOf(RunnerTimeoutError);
  });

  it("does not take the runner's word for the output size or the log lengths", async () => {
    const big = answer({ status: "succeeded", output: "x".repeat(MAX_OUTPUT_BYTES + 1), logs: [], durationMs: 1 }) as unknown as typeof fetch;
    expect(await sendRun(request, config, big)).toMatchObject({ status: "failed", error: { code: "OUTPUT_TOO_LARGE" } });
    const noisy = answer({ status: "succeeded", output: 1, logs: Array.from({ length: 150 }, () => "y".repeat(5000)), durationMs: 1 }) as unknown as typeof fetch;
    const result = await sendRun(request, config, noisy);
    expect(result.logs).toHaveLength(100);
    expect(result.logs[0]).toHaveLength(2000);
  });

  it("never follows a redirect from the runner", async () => {
    let redirect: RequestRedirect | undefined;
    const send = (async (_url: URL, init: RequestInit) => {
      redirect = init.redirect;
      return new Response(JSON.stringify({ status: "succeeded", output: 1, logs: [], durationMs: 1 }));
    }) as unknown as typeof fetch;
    await sendRun(request, config, send);
    expect(redirect).toBe("error");
  });

  it("stops reading an answer longer than it accepts, and does not parse it", async () => {
    const flood = JSON.stringify({ status: "succeeded", output: 1, logs: Array.from({ length: 200 }, () => "z".repeat(50_000)), durationMs: 1 });
    expect(flood.length).toBeGreaterThan(MAX_RESPONSE_BYTES);
    let pulled = 0;
    const streamed = (async () => new Response(new ReadableStream({
      pull(controller) {
        const chunk = new TextEncoder().encode(flood.slice(pulled, pulled + 64 * 1024));
        pulled += 64 * 1024;
        if (chunk.byteLength === 0) controller.close();
        else controller.enqueue(chunk);
      },
    }))) as unknown as typeof fetch;
    expect(await sendRun(request, config, streamed)).toMatchObject({ status: "failed", error: { code: "OUTPUT_TOO_LARGE" }, logs: [] });
    expect(pulled).toBeLessThan(flood.length);
    const declared = (async () => new Response("{}", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } })) as unknown as typeof fetch;
    expect(await sendRun(request, config, declared)).toMatchObject({ status: "failed", error: { code: "OUTPUT_TOO_LARGE" } });
  });
});
