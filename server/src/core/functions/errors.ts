import { ApiError } from "../../utils/errors.ts";

export class FunctionNotFoundError extends ApiError {
  constructor(ref: string) {
    super(404, "FUNCTION_NOT_FOUND", `Function ${ref} not found.`);
    this.name = "FunctionNotFoundError";
  }
}

export class FunctionRunNotFoundError extends ApiError {
  constructor(runId: string) {
    super(404, "FUNCTION_RUN_NOT_FOUND", `Function run ${runId} not found.`);
    this.name = "FunctionRunNotFoundError";
  }
}

export class FunctionRunnerUnavailableError extends ApiError {
  constructor(message = "The function runner is not available. Nothing ran. Try again shortly.", details?: Record<string, unknown>) {
    super(503, "FUNCTION_RUNNER_UNAVAILABLE", message, details);
    this.name = "FunctionRunnerUnavailableError";
  }
}
