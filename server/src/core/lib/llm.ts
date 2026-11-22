import { env } from "../../config/env.ts";
import { createLogger } from "../../lib/logger.ts";
import { CircuitBreaker } from "../../lib/circuit-breaker.ts";
import { EmbeddingProviderError } from "../../utils/errors.ts";
import { assertMemoryProcessingAllowed } from "../billing/memory-admission.ts";

const logger = createLogger({ module: "llm" });

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
}

export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  score: number;
}

export interface LLMProvider {
  readonly model: string;
  chat(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<ChatResult>;
  rerank(query: string, candidates: RerankCandidate[]): Promise<{ results: RerankResult[]; totalTokens: number }>;
}

const REQUEST_TIMEOUT_MS = 60000;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_RERANK_CANDIDATES = 50;

interface OpenAIChatResponse {
  choices: Array<{ message: { content: string }; index: number }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenRouterLLMProvider implements LLMProvider {
  readonly model: string;

  private readonly apiKey: string;
  private readonly url: string;

  constructor() {
    if (!env.OPENROUTER_API_KEY) {
      throw new EmbeddingProviderError("LLM provider is not configured");
    }
    this.apiKey = env.OPENROUTER_API_KEY;
    this.model = env.LLM_MODEL;
    this.url = `${env.EMBEDDING_BASE_URL.replace(/\/$/, "")}/chat/completions`;
  }

  async chat(
    messages: ChatMessage[],
    opts: { maxTokens?: number; temperature?: number } = {}
  ): Promise<ChatResult> {
    const maxTokens = opts.maxTokens ?? env.LLM_MAX_TOKENS;
    const temperature = opts.temperature ?? env.LLM_TEMPERATURE;

    const body = {
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature,
    };

    const json = await this.requestWithRetry(body);
    const choice = json.choices?.[0];
    if (!choice?.message?.content) {
      throw new EmbeddingProviderError("LLM provider returned no content");
    }

    const promptTokens = json.usage?.prompt_tokens ?? 0;
    const completionTokens = json.usage?.completion_tokens ?? 0;
    const totalTokens = json.usage?.total_tokens ?? promptTokens + completionTokens;

    return {
      content: choice.message.content,
      totalTokens,
      promptTokens,
      completionTokens,
    };
  }

  async rerank(
    query: string,
    candidates: RerankCandidate[]
  ): Promise<{ results: RerankResult[]; totalTokens: number }> {
    if (candidates.length === 0) {
      return { results: [], totalTokens: 0 };
    }
    if (candidates.length > MAX_RERANK_CANDIDATES) {
      logger.warn(
        { count: candidates.length, max: MAX_RERANK_CANDIDATES },
        "Rerank candidate count exceeds max, truncating"
      );
      candidates = candidates.slice(0, MAX_RERANK_CANDIDATES);
    }

    const systemPrompt = `You are a relevance judge. Score each candidate document against the query on a scale of 0.0 to 1.0, where 1.0 means the document directly answers the query and 0.0 means it is completely unrelated. Return ONLY a JSON array of objects with "id" and "score" fields, no other text.`;

    const candidateText = candidates
      .map((c, i) => `[${i}] id=${c.id}\n${c.text.slice(0, 500)}`)
      .join("\n\n");

    const userPrompt = `Query: ${query}\n\nCandidates:\n${candidateText}\n\nReturn JSON: [{"id":"...","score":0.0},...]`;

    const result = await this.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { maxTokens: 1024, temperature: 0 }
    );

    const scores = this.parseRerankScores(result.content, candidates);

    return {
      results: scores.sort((a, b) => b.score - a.score),
      totalTokens: result.totalTokens,
    };
  }

  private parseRerankScores(content: string, candidates: RerankCandidate[]): RerankResult[] {
    try {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        logger.warn({ content: content.slice(0, 200) }, "Rerank response had no JSON array");
        return candidates.map((c) => ({ id: c.id, score: 0.5 }));
      }
      const parsed = JSON.parse(jsonMatch[0]) as Array<{ id?: string; score?: number }>;
      const scoreMap = new Map<string, number>();
      for (const item of parsed) {
        if (item.id && typeof item.score === "number") {
          scoreMap.set(item.id, Math.max(0, Math.min(1, item.score)));
        }
      }
      return candidates.map((c) => ({
        id: c.id,
        score: scoreMap.get(c.id) ?? 0.5,
      }));
    } catch {
      logger.warn({ content: content.slice(0, 200) }, "Failed to parse rerank response");
      return candidates.map((c) => ({ id: c.id, score: 0.5 }));
    }
  }

  private async requestWithRetry(body: unknown): Promise<OpenAIChatResponse> {
    const circuit = await CircuitBreaker.canRequest(this.url);
    if (!circuit.allowed) {
      throw new EmbeddingProviderError(`LLM provider circuit open: ${circuit.reason}`);
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      assertMemoryProcessingAllowed();
      try {
        const result = await this.requestOnce(body);
        await CircuitBreaker.recordSuccess(this.url);
        return result;
      } catch (error) {
        lastError = error;
        const status = (error as { status?: number }).status;
        const retryable = status === undefined || RETRYABLE_STATUS.has(status);

        if (retryable) {
          await CircuitBreaker.recordFailure(this.url);
        }

        if (!retryable || attempt === MAX_ATTEMPTS) {
          break;
        }

        const retryAfter = (error as { retryAfter?: number }).retryAfter;
        const backoff = retryAfter ?? Math.min(1000 * 2 ** (attempt - 1), 8000);
        const jitter = Math.floor(Math.random() * 250);
        logger.warn(
          { attempt, status, backoff, model: this.model },
          "LLM request failed, retrying"
        );
        await sleep(backoff + jitter);
      }
    }

    const status = (lastError as { status?: unknown } | undefined)?.status;
    logger.error({ status: typeof status === "number" ? status : undefined, model: this.model }, "LLM request failed permanently");
    if (lastError instanceof EmbeddingProviderError) {
      throw lastError;
    }
    throw new EmbeddingProviderError(
      lastError instanceof Error ? lastError.message : "LLM request failed"
    );
  }

  private async requestOnce(body: unknown): Promise<OpenAIChatResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "HTTP-Referer": "https://anlyon.com",
          "X-Title": "Anlyon",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new EmbeddingProviderError(
        error instanceof Error ? error.message : "Network error"
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfter = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
      await response.body?.cancel().catch(() => {});
      const err = new EmbeddingProviderError(
        `LLM provider returned ${response.status}`
      );
      (err as any).status = response.status;
      if (retryAfter && !Number.isNaN(retryAfter)) (err as any).retryAfter = retryAfter;
      throw err;
    }

    const json = (await response.json()) as OpenAIChatResponse;
    if (!json.choices || !Array.isArray(json.choices) || json.choices.length === 0) {
      throw new EmbeddingProviderError(
        `LLM provider returned ${json.choices?.length ?? 0} choices`
      );
    }
    return json;
  }
}
