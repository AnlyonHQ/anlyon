import { isFeatureEnabled } from "@anlyon/feature-flags";
import { env } from "../../config/env.ts";

export function hostedFunctionsAvailable(): boolean {
  return isFeatureEnabled("functions") && Boolean(env.FUNCTION_RUNNER_URL);
}
