import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.ts", () => ({ env: {
  OPENROUTER_API_KEY: "test-only", EMBEDDING_BASE_URL: "https://openrouter.ai/api/v1",
  LLM_MODEL: "openai/gpt-4o-mini", LLM_MAX_TOKENS: 16, LLM_TEMPERATURE: 0,
} }));
const logs = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("../src/lib/logger.ts", () => ({ createLogger: () => logs }));
vi.mock("../src/lib/circuit-breaker.ts", () => ({ CircuitBreaker: { canRequest: async () => ({ allowed: true }) } }));

import { OpenRouterLLMProvider } from "../src/core/lib/llm.ts";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("LLM provider", () => {
  it("does not expose a provider error body in logs or the thrown error", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("PRIVATE_CUSTOMER_PROMPT", { status: 400 }));
    await expect(new OpenRouterLLMProvider().chat([{ role: "user", content: "PRIVATE_CUSTOMER_PROMPT" }]))
      .rejects.toThrow("LLM provider returned 400");
    expect(JSON.stringify(logs.error.mock.calls)).not.toContain("PRIVATE_CUSTOMER_PROMPT");
    expect(logs.error).toHaveBeenCalledWith({ status: 400, model: "openai/gpt-4o-mini" }, "LLM request failed permanently");
  });
});
