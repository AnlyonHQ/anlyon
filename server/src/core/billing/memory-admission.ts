import { ApiError } from "../../utils/errors.ts";
import { modelCallsPaused } from "./work-admission.ts";

export function assertMemoryProcessingAllowed(): void {
  if (modelCallsPaused()) {
    throw new ApiError(503, "EXPENSIVE_WORK_PAUSED",
      "Memory processing is temporarily paused. Stored data remains available for viewing and deletion.");
  }
}
