import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.ts", () => ({ env: {
  TYPESAFE_API_KEY: "ts_test_only",
  TYPESAFE_BASE_URL: "https://api.typesafe.test/v1/",
  TYPESAFE_MODEL: "jev-1.13.0",
  TYPESAFE_TIMEOUT_MS: 50,
} }));
vi.mock("../src/lib/logger.ts", () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
const circuit = vi.hoisted(() => ({ allowed: true }));
vi.mock("../src/lib/circuit-breaker.ts", () => ({ CircuitBreaker: {
  canRequest: async () => ({ allowed: circuit.allowed }),
  recordFailure: vi.fn(async () => {}),
  recordSuccess: vi.fn(async () => {}),
} }));

import { askSystemOne, worstCaseReviewMs } from "../src/core/assistant/typesafe-client.ts";

const ok = {
  model: "jev-1.13.0",
  answers: { injection_suspected: { type: "noul", noul: 0.02 } },
  usage: { input_tokens: 100, output_tokens: 0 },
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const questions = { injection_suspected: { type: "noul" as const, instructions: "?" } };

beforeEach(() => { circuit.allowed = true; });
afterEach(() => { vi.restoreAllMocks(); });

describe("TypeSafe client", () => {
  it("posts the pinned model, state and questions with the bearer key", async () => {
    const fetchImpl = vi.fn(async () => json(200, ok));
    const result = await askSystemOne({ a: 1 }, questions, { fetchImpl });
    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.test/v1/systemone");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ts_test_only");
    expect(JSON.parse(init.body as string)).toEqual({ model: "jev-1.13.0", state: { a: 1 }, questions });
  });

  it("retries 429 and 529, honouring Retry-After", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(429, { error: "rate" }, { "retry-after": "0" }))
      .mockResolvedValueOnce(json(529, { error: "overloaded" }))
      .mockResolvedValueOnce(json(200, ok));
    const result = await askSystemOne({}, questions, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("fails fast on 422 without retrying", async () => {
    const fetchImpl = vi.fn(async () => json(422, { error: "bad question" }));
    const result = await askSystemOne({}, questions, { fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: "http_422", status: 422 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a timeout as failure, never an exception", async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const result = await askSystemOne({}, questions, { fetchImpl: fetchImpl as never, maxAttempts: 1 });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("rejects a malformed response", async () => {
    const fetchImpl = vi.fn(async () => json(200, { model: "jev-1.13.0", answers: { x: { type: "noul" } } }));
    expect(await askSystemOne({}, questions, { fetchImpl })).toMatchObject({ ok: false, reason: "invalid_response" });
  });

  it("does not call out while the circuit is open", async () => {
    circuit.allowed = false;
    const fetchImpl = vi.fn();
    expect(await askSystemOne({}, questions, { fetchImpl })).toMatchObject({ ok: false, reason: "circuit_open" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["a negative score", { risk: { type: "score", score: -1, confidence: 0.9, probabilities: {} } }],
    ["confidence above 1", { recommendation: { type: "choice", choice: "approve", confidence: 2, probabilities: {} } }],
    ["a truth value above 1", { injection_suspected: { type: "noul", noul: 1.5 } }],
    ["a negative truth value", { consistent_with_history: { type: "noul", noul: -0.2 } }],
    ["a probability above 1", { recommendation: { type: "choice", choice: "approve", confidence: 0.9, probabilities: { approve: 1.2 } } }],
  ])("rejects an out-of-range answer: %s", async (_label, answers) => {
    const fetchImpl = vi.fn(async () => json(200, { model: "jev-1.13.0", answers }));
    expect(await askSystemOne({}, questions, { fetchImpl })).toMatchObject({ ok: false, reason: "invalid_response" });
  });

  it("sizes the worst case from the configured timeout", () => {
    expect(worstCaseReviewMs(30_000)).toBe(3 * 30_000 + 2 * 5_000);
    expect(worstCaseReviewMs(5_000)).toBe(25_000);
  });
});
