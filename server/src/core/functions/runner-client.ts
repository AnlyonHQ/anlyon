import { env } from "../../config/env.ts";
import type { FunctionBudgetName, FunctionBudgets, FunctionLanguage, FunctionRunMode } from "../../db/schema/functions.ts";
import { createLogger } from "../../lib/logger.ts";
import { FunctionRunnerUnavailableError } from "./errors.ts";
import { RUNNER_SIGNATURE_HEADER, signRunnerRequest } from "./runner-signing.ts";

const logger = createLogger({ module: "function-runner-client" });

export const RUNNER_TIMEOUT_MARGIN_MS = 10_000;

export interface RunnerRunRequest {
  runId: string;
  functionVersionId: string;
  digest: string;
  language: FunctionLanguage;
  source: string;
  input: unknown;
  mode: FunctionRunMode;
  allowedActions: string[];
  budgets: FunctionBudgets;
  runToken: string;
  isolation?: string;
}

export interface RunnerRunResponse {
  status: "succeeded" | "failed" | "budget_exceeded";
  output?: unknown;
  error?: { code: string; message: string };
  budget?: FunctionBudgetName;
  logs: string[];
  durationMs: number;
}

export interface RunnerConfig {
  url: string;
  secret: string;
}

export function runnerConfig(): RunnerConfig | null {
  if (!env.FUNCTION_RUNNER_URL || !env.RUNNER_SHARED_SECRET) return null;
  return { url: env.FUNCTION_RUNNER_URL, secret: env.RUNNER_SHARED_SECRET };
}

const STATUSES = new Set(["succeeded", "failed", "budget_exceeded"]);
const BUDGETS = new Set(["maxActionCalls", "maxCpuMs", "maxSubrequests", "timeoutMs"]);

export const MAX_OUTPUT_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = MAX_OUTPUT_BYTES + 100 * 2000 * 4 + 64 * 1024;

async function readCapped(response: Response, limit: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseResponse(value: unknown): RunnerRunResponse | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (typeof body.status !== "string" || !STATUSES.has(body.status)) return null;
  if (body.budget !== undefined && !BUDGETS.has(body.budget as string)) return null;
  const error = body.error as { code?: unknown; message?: unknown } | undefined;
  if (body.status === "succeeded" && JSON.stringify(body.output ?? null).length > MAX_OUTPUT_BYTES) {
    return {
      status: "failed",
      error: { code: "OUTPUT_TOO_LARGE", message: `The output is larger than ${MAX_OUTPUT_BYTES} bytes.` },
      logs: [],
      durationMs: typeof body.durationMs === "number" ? body.durationMs : 0,
    };
  }
  return {
    status: body.status as RunnerRunResponse["status"],
    output: body.output ?? null,
    ...(error && typeof error.code === "string"
      ? { error: { code: error.code.slice(0, 100), message: String(error.message ?? "").slice(0, 2000) } }
      : {}),
    ...(body.budget ? { budget: body.budget as FunctionBudgetName } : {}),
    logs: Array.isArray(body.logs)
      ? body.logs.filter((line): line is string => typeof line === "string").slice(0, 100).map((line) => line.slice(0, 2000))
      : [],
    durationMs: typeof body.durationMs === "number" ? body.durationMs : 0,
  };
}

export class RunnerTimeoutError extends Error {
  constructor() {
    super("The function runner did not answer within the run's timeout.");
    this.name = "RunnerTimeoutError";
  }
}

export async function sendRun(
  request: RunnerRunRequest,
  config: RunnerConfig | null = runnerConfig(),
  send: typeof fetch = fetch,
): Promise<RunnerRunResponse> {
  if (!config) throw new FunctionRunnerUnavailableError("Hosted functions are not configured on this deployment. Nothing ran.");
  const url = new URL("/run", config.url);
  const body = JSON.stringify(request);
  let response: Response;
  try {
    response = await send(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RUNNER_SIGNATURE_HEADER]: signRunnerRequest(config.secret, "POST", url.pathname, body),
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(request.budgets.timeoutMs + RUNNER_TIMEOUT_MARGIN_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new RunnerTimeoutError();
    logger.warn({ runId: request.runId, error: error instanceof Error ? error.message : String(error) }, "Function runner unreachable");
    throw new FunctionRunnerUnavailableError();
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    logger.warn({ runId: request.runId, status: response.status, body: text.slice(0, 500) }, "Function runner refused the run");
    throw new FunctionRunnerUnavailableError(undefined, { runnerStatus: response.status });
  }
  const text = await readCapped(response, MAX_RESPONSE_BYTES).catch(() => "");
  if (text === null) {
    logger.warn({ runId: request.runId }, "Function runner answered with more than the API reads");
    return {
      status: "failed",
      error: { code: "OUTPUT_TOO_LARGE", message: `The run's answer is larger than ${MAX_RESPONSE_BYTES} bytes.` },
      logs: [],
      durationMs: 0,
    };
  }
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const parsed = parseResponse(json);
  if (!parsed) {
    logger.warn({ runId: request.runId }, "Function runner answered with an unexpected body");
    throw new FunctionRunnerUnavailableError();
  }
  return parsed;
}
