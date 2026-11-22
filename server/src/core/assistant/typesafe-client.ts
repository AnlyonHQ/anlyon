import { z } from "zod";
import { env } from "../../config/env.ts";
import { CircuitBreaker } from "../../lib/circuit-breaker.ts";
import { createLogger } from "../../lib/logger.ts";

const logger = createLogger({ module: "assistant-typesafe" });

export type TypeSafeQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

const probability = z.number().finite().min(0).max(1);
const choiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: probability,
  probabilities: z.record(z.string(), probability),
});
const scoreAnswer = z.object({
  type: z.literal("score"),
  score: z.number().finite().min(0),
  confidence: probability,
  probabilities: z.record(z.string(), probability),
  legend: z.record(z.string(), z.string()).optional(),
});
const noulAnswer = z.object({ type: z.literal("noul"), noul: probability });
const answerSchema = z.discriminatedUnion("type", [choiceAnswer, scoreAnswer, noulAnswer]);

const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).partial().optional(),
});

export type TypeSafeAnswer = z.infer<typeof answerSchema>;
export type TypeSafeResponse = z.infer<typeof responseSchema>;

export type TypeSafeResult =
  | { ok: true; response: TypeSafeResponse; latencyMs: number }
  | { ok: false; reason: string; status?: number; latencyMs: number };

const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
export const TYPESAFE_MAX_ATTEMPTS = 3;
export const TYPESAFE_MAX_RETRY_WAIT_MS = 5_000;

export function worstCaseReviewMs(timeoutMs: number = env.TYPESAFE_TIMEOUT_MS): number {
  return TYPESAFE_MAX_ATTEMPTS * timeoutMs + (TYPESAFE_MAX_ATTEMPTS - 1) * TYPESAFE_MAX_RETRY_WAIT_MS;
}

export function isTypeSafeConfigured(): boolean {
  return Boolean(env.TYPESAFE_API_KEY);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function askSystemOne(
  state: unknown,
  questions: Record<string, TypeSafeQuestion>,
  opts: { fetchImpl?: typeof fetch; maxAttempts?: number } = {},
): Promise<TypeSafeResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  if (!env.TYPESAFE_API_KEY) return { ok: false, reason: "not_configured", latencyMs: 0 };

  const url = `${env.TYPESAFE_BASE_URL.replace(/\/$/, "")}/systemone`;
  const circuit = await CircuitBreaker.canRequest(url).catch(() => ({ allowed: true as const }));
  if (!circuit.allowed) return { ok: false, reason: "circuit_open", latencyMs: 0 };

  const doFetch = opts.fetchImpl ?? fetch;
  const attempts = opts.maxAttempts ?? TYPESAFE_MAX_ATTEMPTS;
  let last: { reason: string; status?: number } = { reason: "unknown" };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.TYPESAFE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.TYPESAFE_API_KEY}` },
        body: JSON.stringify({ model: env.TYPESAFE_MODEL, state, questions }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      last = { reason: controller.signal.aborted ? "timeout" : "network_error" };
      await CircuitBreaker.recordFailure(url).catch(() => {});
      if (attempt < attempts) await sleep(backoff(attempt));
      continue;
    }
    clearTimeout(timer);

    if (response.ok) {
      let parsed: TypeSafeResponse;
      try {
        parsed = responseSchema.parse(await response.json());
      } catch {
        return { ok: false, reason: "invalid_response", status: response.status, latencyMs: elapsed() };
      }
      await CircuitBreaker.recordSuccess(url).catch(() => {});
      return { ok: true, response: parsed, latencyMs: elapsed() };
    }

    last = { reason: `http_${response.status}`, status: response.status };
    if (!RETRYABLE.has(response.status)) break;
    await CircuitBreaker.recordFailure(url).catch(() => {});
    if (attempt < attempts) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, TYPESAFE_MAX_RETRY_WAIT_MS) : backoff(attempt));
    }
  }

  logger.warn({ reason: last.reason, status: last.status }, "TypeSafe request failed; the approval is reviewed without a suggestion");
  return { ok: false, ...last, latencyMs: elapsed() };
}

function backoff(attempt: number): number {
  return Math.min(250 * 2 ** (attempt - 1), 2000) + Math.floor(Math.random() * 100);
}
