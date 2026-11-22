import { beforeEach, describe, expect, it, vi } from "vitest";

const safeFetch = vi.fn();
const recordInvocationOutcome = vi.fn();
const emitEvent = vi.fn();

vi.mock("../src/lib/safe-http.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/safe-http.ts")>()),
  safeFetch: (...args: unknown[]) => safeFetch(...args),
}));
vi.mock("../src/core/billing/action-accounting.ts", () => ({
  reserveActionExecution: async () => true,
  recordInvocationOutcome: (...args: unknown[]) => recordInvocationOutcome(...args),
}));
vi.mock("../src/core/environments/halt.ts", () => ({ isEnvironmentHalted: async () => false }));
vi.mock("../src/core/actions/secrets.ts", () => ({
  assertSecretsMayReachHost: async () => {},
  loadSecretPolicies: async () => new Map(),
  resolveSecrets: async () => new Map([["STRIPE_KEY", "sk_test_123"]]),
  resolveAccountHost: async () => null,
}));
vi.mock("../src/core/runs/service.ts", () => ({ getRunWithTree: async () => ({}), ingestSpans: async () => {} }));
vi.mock("../src/core/events/emitter.ts", () => ({ emitEvent: (...args: unknown[]) => emitEvent(...args) }));

const { executeInvocation, outcomeOfResponseStatus } = await import("../src/core/actions/execute.ts");
const { encodeFormBody, wantsFormBody } = await import("../src/core/actions/form-encoding.ts");

type Action = Parameters<typeof executeInvocation>[0];
type Invocation = Parameters<typeof executeInvocation>[1];

function action(headers: Record<string, unknown> = {}): Action {
  return {
    id: "a_1", workspaceId: "ws_1", environmentId: "env_1", actionId: "act_1", name: "refund-order",
    method: "POST", urlTemplate: "https://api.stripe.com/v1/refunds",
    headers: { Authorization: "Bearer {{secret:STRIPE_KEY}}", ...headers },
    bodyTemplate: null,
  } as unknown as Action;
}

const invocation = {
  id: "inv_row_1", invocationId: "inv_1", decision: null, definitionSnapshot: null, traceRunId: null,
  input: { charge: "ch_1", amount: 1200, metadata: { order: "42" }, expand: ["charge"] },
} as unknown as Invocation;

function unreadableBody(status: number): Response {
  const body = new ReadableStream({ start(controller) { controller.error(new Error("socket hang up")); } });
  return new Response(body, { status });
}

beforeEach(() => {
  safeFetch.mockReset();
  emitEvent.mockReset();
  recordInvocationOutcome.mockReset();
  recordInvocationOutcome.mockImplementation(async (_ws: string, _id: string, patch: Record<string, unknown>) => ({
    ...invocation, ...patch,
  }));
});

function recorded() {
  const [, , patch, usage] = recordInvocationOutcome.mock.calls[0];
  return { patch: patch as Record<string, unknown>, usage };
}

describe("classifying a received status", () => {
  it.each([200, 201, 202, 204])("%i happened", (status) => {
    expect(outcomeOfResponseStatus(status)).toBe("succeeded");
  });

  it.each([400, 401, 402, 404, 409, 422, 429])("%i is the destination refusing, so it did not happen", (status) => {
    expect(outcomeOfResponseStatus(status)).toBe("failed");
  });

  it.each([500, 502, 503, 504])("%i is indeterminate", (status) => {
    expect(outcomeOfResponseStatus(status)).toBe("unknown");
  });
});

describe("an error after the destination answered", () => {
  const busy = () => { throw new Error("The database is busy: a transaction waited 15000 ms to begin and was not started."); };

  it("records a 2xx as succeeded when the first recording fails, so a retry cannot repeat the write", async () => {
    safeFetch.mockResolvedValue(new Response('{"id":"re_1"}', { status: 200 }));
    recordInvocationOutcome.mockImplementationOnce(async () => busy());

    const result = await executeInvocation(action(), invocation);

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("succeeded");
    const [, , patch, usage] = recordInvocationOutcome.mock.calls[1];
    expect(patch).toMatchObject({ status: "succeeded", responseStatus: 200, responseBody: '{"id":"re_1"}', errorMessage: null });
    expect(usage).toBe("billed");
    expect(emitEvent.mock.calls.map((call) => call[1])).toEqual(["action.succeeded"]);
  });

  it("keeps a 4xx failed and a 5xx unknown, each with the destination's status as the reason", async () => {
    safeFetch.mockResolvedValue(new Response("{}", { status: 422 }));
    recordInvocationOutcome.mockImplementationOnce(async () => busy());
    expect((await executeInvocation(action(), invocation)).status).toBe("failed");
    expect(recordInvocationOutcome.mock.calls[1][2]).toMatchObject({ status: "failed", responseStatus: 422, errorMessage: "Upstream returned 422" });

    recordInvocationOutcome.mockClear();
    safeFetch.mockResolvedValue(new Response("{}", { status: 503 }));
    recordInvocationOutcome.mockImplementationOnce(async () => busy());
    expect((await executeInvocation(action(), invocation)).status).toBe("unknown");
    expect(recordInvocationOutcome.mock.calls[1][3]).toBe("unknown");
  });
});

describe("executing against a response", () => {
  it("records a 500 as unknown, keeps the status, and tells the operator to reconcile", async () => {
    safeFetch.mockResolvedValue(new Response('{"error":{"type":"api_error"}}', { status: 500 }));

    const result = await executeInvocation(action(), invocation);

    expect(result.status).toBe("unknown");
    const { patch, usage } = recorded();
    expect(patch.responseStatus).toBe(500);
    expect(patch.errorMessage).toMatch(/indeterminate.*Reconcile/s);
    expect(usage).toBe("unknown");
    expect(emitEvent.mock.calls[0][1]).toBe("action.unknown");
  });

  it("keeps a 4xx as failed", async () => {
    safeFetch.mockResolvedValue(new Response('{"error":{"type":"invalid_request_error"}}', { status: 400 }));

    const result = await executeInvocation(action(), invocation);

    expect(result.status).toBe("failed");
    expect(recorded().patch.errorMessage).toBe("Upstream returned 400");
    expect(recorded().usage).toBe("billed");
    expect(emitEvent.mock.calls[0][1]).toBe("action.failed");
  });

  it("records a 2xx whose body could not be read as succeeded, not failed", async () => {
    safeFetch.mockResolvedValue(unreadableBody(200));

    const result = await executeInvocation(action(), invocation);

    expect(result.status).toBe("succeeded");
    const { patch, usage } = recorded();
    expect(patch.responseStatus).toBe(200);
    expect(patch.responseBody).toMatch(/^\[response body unavailable: /);
    expect(usage).toBe("billed");
    expect(emitEvent.mock.calls[0][1]).toBe("action.succeeded");
  });

  it("records a 5xx whose body could not be read as unknown", async () => {
    safeFetch.mockResolvedValue(unreadableBody(502));

    const result = await executeInvocation(action(), invocation);

    expect(result.status).toBe("unknown");
    expect(recorded().usage).toBe("unknown");
  });

  it("still holds a 5xx's usage when recording it has to be retried from the error path", async () => {
    safeFetch.mockResolvedValue(new Response("{}", { status: 503 }));
    recordInvocationOutcome.mockRejectedValueOnce(new Error("connection terminated"));

    const result = await executeInvocation(action(), invocation);

    expect(result.status).toBe("unknown");
    expect(recordInvocationOutcome.mock.calls.map(([, , , usage]) => usage)).toEqual(["unknown", "unknown"]);
  });
});

describe("request encoding", () => {
  it("sends JSON by default", async () => {
    safeFetch.mockResolvedValue(new Response("{}", { status: 200 }));

    await executeInvocation(action(), invocation);

    const init = safeFetch.mock.calls[0][1] as { headers: Record<string, string>; body: string };
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(invocation.input);
  });

  it("sends a form body when the action declares the form Content-Type", async () => {
    safeFetch.mockResolvedValue(new Response("{}", { status: 200 }));

    await executeInvocation(action({ "Content-Type": "application/x-www-form-urlencoded" }), invocation);

    const init = safeFetch.mock.calls[0][1] as { headers: Record<string, string>; body: string };
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(init.body).toString()).toBe(
      "charge=ch_1&amount=1200&metadata%5Border%5D=42&expand%5B0%5D=charge"
    );
  });
});

describe("encodeFormBody", () => {
  it("uses bracket notation for nested objects and arrays", () => {
    expect(decodeURIComponent(encodeFormBody({
      items: [{ price: "p_1", quantity: 2 }], metadata: { a: "b" }, capture: true,
    }))).toBe("items[0][price]=p_1&items[0][quantity]=2&metadata[a]=b&capture=true");
  });

  it("omits null and undefined rather than sending the text", () => {
    expect(encodeFormBody({ a: null, b: undefined, c: "x" })).toBe("c=x");
  });

  it("recognises the form media type with parameters and any header casing", () => {
    expect(wantsFormBody({ "content-type": "application/x-www-form-urlencoded; charset=utf-8" })).toBe(true);
    expect(wantsFormBody({ "Content-Type": "application/json" })).toBe(false);
    expect(wantsFormBody({})).toBe(false);
  });
});
