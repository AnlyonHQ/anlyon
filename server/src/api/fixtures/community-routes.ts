import { readFileSync } from "node:fs";

export const OWNER_CORE_ROUTES = [
  "ALL /api/v2/dlq/*",
  "DELETE /api/v2/dlq",
  "DELETE /api/v2/dlq/:messageId",
  "GET /api/v2/dlq",
  "GET /api/v2/dlq/:messageId",
  "GET /api/v2/dlq/stats",
  "POST /api/v2/dlq/:messageId/retry",
  "POST /api/v2/dlq/retry-all",
  "ALL /api/v2/sandbox/*",
  "POST /api/v2/sandbox/token",
  "POST /api/v2/public/sandbox/echo",
];

export function recordedCommunityRoutes(): string[] {
  return JSON.parse(readFileSync(new URL("./routes-community.json", import.meta.url), "utf8")) as string[];
}

export function communityRouteTable(): string[] {
  return [...new Set([...recordedCommunityRoutes(), ...OWNER_CORE_ROUTES])].sort();
}
