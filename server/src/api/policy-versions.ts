import type { Context } from "hono";
import { POLICY_VERSIONS_DEFAULT_LIMIT, type PolicyVersionPage } from "../core/approvals/policy.ts";
import { ValidationError } from "../utils/errors.ts";
import { pathParam } from "./params.ts";

export function versionPageResponse(page: PolicyVersionPage, limit: number | undefined) {
  return {
    success: true as const,
    data: page.versions,
    pagination: {
      limit: limit ?? POLICY_VERSIONS_DEFAULT_LIMIT,
      nextBefore: page.nextBefore,
      earliestVersion: page.earliestVersion,
      latestVersion: page.latestVersion,
    },
  };
}

export function versionParam(c: Context): number {
  const version = Number(pathParam(c, "version"));
  if (!Number.isInteger(version) || version < 1) throw new ValidationError("version must be a positive integer.");
  return version;
}
