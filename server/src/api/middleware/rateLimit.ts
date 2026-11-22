import type { Context, Next } from "hono";
import { asTransactionTenant } from "../../db/transaction-gate.ts";
import { redis, RedisKeys } from "../../lib/redis.ts";
import { AuthenticationError, RateLimitError } from "../../utils/errors.ts";
import { env } from "../../config/env.ts";
import { getPlanLimits, getNumericLimit, type PlanType } from "../../core/plans/limits.ts";
import { getWorkspaceCached } from "../../lib/workspace-cache.ts";
import { trustedClientIp } from "../client-ip.ts";
import { credentialWasRejected } from "../credential-rejection.ts";
import { mcpUnauthorized } from "../mcp-challenge.ts";
import { scimUnauthorizedResponse } from "../../core/scim/protocol.ts";
import { createLogger } from "../../lib/logger.ts";
import { buildErrorResponse } from "./error.ts";
import { createHash } from "node:crypto";

const logger = createLogger({ module: "rate-limit" });

export const WORKSPACE_WINDOWS_LUA = `
local m = redis.call('INCR', KEYS[1])
if m == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local h = 0
if KEYS[2] and m <= tonumber(ARGV[3]) then
  h = redis.call('INCR', KEYS[2])
  if h == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
end
return {m, h}`;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

function hourResetPhrase(resetAt: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((resetAt - now) / MINUTE_MS));
  return `${new Date(resetAt).toISOString().slice(11, 16)} UTC (in ${minutes} minute${minutes === 1 ? "" : "s"})`;
}

export async function rateLimitByWorkspace(c: Context, proceed: Next) {
  const workspaceId = c.get("workspaceId");

  if (!workspaceId) {
    await proceed();
    return;
  }
  const next: Next = () => asTransactionTenant(String(workspaceId), proceed);

  const workspace = await getWorkspaceCached(workspaceId);

  if (!workspace) {
    throw new RateLimitError("Workspace not found");
  }

  c.set("cachedWorkspace", workspace);

  const plan = workspace.plan;
  const planLimits = getPlanLimits(plan);

  const now = Date.now();
  const limitMax = getNumericLimit(planLimits.rateLimit.requestsPerMinute);

  if (planLimits.rateLimit.requestsPerMinute === "unlimited") {
    await next();
    return;
  }

  const hourly = planLimits.rateLimit.requestsPerHour;
  const minuteKey = RedisKeys.rateLimit(workspaceId, Math.floor(now / MINUTE_MS).toString());
  const hourWindow = Math.floor(now / HOUR_MS);
  const keys = hourly === "unlimited" ? [minuteKey] : [minuteKey, RedisKeys.rateLimit(workspaceId, `h${hourWindow}`)];
  const counts = (await redis.eval(
    WORKSPACE_WINDOWS_LUA, keys.length, ...keys,
    String(MINUTE_MS / 1000), String(HOUR_MS / 1000), String(limitMax),
  )) as unknown[];
  const count = Number(counts?.[0] ?? 0);
  const hourCount = Number(counts?.[1] ?? 0);

  if (count > limitMax) {
    c.header("Retry-After", String(Math.max(1, Math.ceil((MINUTE_MS - (now % MINUTE_MS)) / 1000))));
    throw new RateLimitError(
      `Rate limit exceeded. Your plan allows ${limitMax} requests per minute. Slow down and retry shortly.`
    );
  }
  const hourResetAt = (hourWindow + 1) * HOUR_MS;
  if (hourly !== "unlimited" && hourCount > hourly) {
    c.header("Retry-After", String(Math.max(1, Math.ceil((hourResetAt - now) / 1000))));
    c.header("X-RateLimit-Limit-Hour", hourly.toString());
    c.header("X-RateLimit-Remaining-Hour", "0");
    c.header("X-RateLimit-Reset-Hour", hourResetAt.toString());
    throw new RateLimitError(
      `Hourly rate limit exceeded. Your plan allows ${new Intl.NumberFormat("en-US").format(hourly)} requests an hour; ` +
      `the count resets at ${hourResetPhrase(hourResetAt, now)}.`
    );
  }

  c.header("X-RateLimit-Limit", limitMax.toString());
  c.header("X-RateLimit-Remaining", Math.max(0, limitMax - count).toString());
  c.header("X-RateLimit-Reset", (now + MINUTE_MS).toString());
  if (hourly !== "unlimited") {
    c.header("X-RateLimit-Limit-Hour", hourly.toString());
    c.header("X-RateLimit-Remaining-Hour", Math.max(0, hourly - hourCount).toString());
    c.header("X-RateLimit-Reset-Hour", hourResetAt.toString());
  }
  c.header("X-RateLimit-Plan", plan);

  await next();
}

async function consumePublicAllowance(bucket: string, allowance?: number): Promise<void> {
  const now = Date.now();
  const windowMs: number = Number(env.RATE_LIMIT_WINDOW ?? 60000);
  const limitMax: number = allowance !== undefined ? allowance * 2 : Number(env.RATE_LIMIT_MAX ?? 100);
  const window = Math.floor(now / windowMs);
  const key = allowance !== undefined ? `ratelimit:${bucket}:${allowance}:${window}` : `ratelimit:${bucket}:${window}`;

  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, Math.ceil(windowMs / 1000));
  }

  const ipLimit = Math.floor(limitMax / 2);
  if (count > ipLimit) {
    throw new RateLimitError(
      `Rate limit exceeded. Maximum ${ipLimit} requests per ${windowMs / 1000} seconds`
    );
  }
}

const AUTH_FAILURES_PER_ADDRESS = 300;
const AUTH_FAILURES_PER_CREDENTIAL = 10;
const AUTH_FAILURE_DELAY_MS = 1000;
const AUTH_THROTTLE_REDIS_BUDGET_MS = 250;

async function bestEffort<T>(command: () => Promise<T>): Promise<T | null> {
  if (redis.status !== "ready") return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), AUTH_THROTTLE_REDIS_BUDGET_MS);
  });
  try {
    return await Promise.race([command().catch(() => null), budget]);
  } finally {
    clearTimeout(timer);
  }
}

function refusedCredentialResponse(c: Context): Response {
  const path = c.req.path;
  if (path === "/mcp" || path.startsWith("/mcp/")) {
    return mcpUnauthorized("The access token was refused. Re-authorize to continue.");
  }
  if (path.startsWith("/api/v2/scim/")) return scimUnauthorizedResponse();
  return buildErrorResponse(new AuthenticationError("Authentication failed"), c);
}

export async function rateLimitFailedAuthByIp(c: Context, next: Next) {
  if (env.NODE_ENV === "development") {
    await next();
    return;
  }
  const credential = c.req.header("Authorization") || c.req.header("Cookie");
  const ip = trustedClientIp((name) => c.req.header(name));
  if (!credential || !ip || ip === "unknown") {
    await next();
    return;
  }
  const windowMs = 60000;
  const window = Math.floor(Date.now() / windowMs);
  const credentialDigest = createHash("sha256").update(credential).digest("hex").slice(0, 16);
  const addressKey = `ratelimit:authfail:${ip}:${window}`;
  const credentialKey = `ratelimit:authfail:${ip}:${credentialDigest}:${window}`;
  const counts = await bestEffort(() => redis.mget(addressKey, credentialKey));
  const addressFailures = Number(counts?.[0] ?? 0);
  const credentialFailures = Number(counts?.[1] ?? 0);

  if (credentialFailures >= AUTH_FAILURES_PER_CREDENTIAL) {
    c.res = refusedCredentialResponse(c);
  } else {
    await next();
    if (!credentialWasRejected(c)) return;
  }

  const ttl = Math.ceil(windowMs / 1000);
  const counted = await bestEffort(() =>
    redis.pipeline().incr(addressKey).expire(addressKey, ttl).incr(credentialKey).expire(credentialKey, ttl).exec(),
  );
  if (Number(counted?.[0]?.[1]) === AUTH_FAILURES_PER_ADDRESS) {
    logger.warn({ ip }, "Failed-authentication cap reached for an address; slowing its refusals for the rest of the minute");
  }
  if (addressFailures >= AUTH_FAILURES_PER_ADDRESS) {
    await new Promise((resolve) => setTimeout(resolve, AUTH_FAILURE_DELAY_MS));
  }
  return c.res;
}

export function rateLimitByIpAllowing(requestsPerWindow: number) {
  return async function ipAllowanceMiddleware(c: Context, next: Next) {
    if (env.NODE_ENV === "development") {
      await next();
      return;
    }
    const ip = trustedClientIp((name) => c.req.header(name));
    if (!ip || ip === "unknown" || ip === "") {
      if (env.NODE_ENV !== "production") {
        await next();
        return;
      }
      throw new RateLimitError("Unable to determine client IP address. Ensure your proxy is configured correctly.");
    }
    await consumePublicAllowance(`ip:${ip}`, requestsPerWindow);
    await next();
  };
}

export const INVITATION_EMAILS_PER_HOUR = 20;

export async function limitInvitationEmails(c: Context, next: Next) {
  const workspaceId = c.req.param("workspaceId");
  const window = Math.floor(Date.now() / 3_600_000);
  const key = `ratelimit:invitation-emails:${workspaceId}:${window}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 3600);
  }
  if (count > INVITATION_EMAILS_PER_HOUR) {
    throw new RateLimitError(
      `This workspace has sent ${INVITATION_EMAILS_PER_HOUR} invitation emails this hour. Try again in the next hour.`
    );
  }
  await next();
}

export async function rateLimitByIp(c: Context, next: Next) {
  if (env.NODE_ENV === "development") {
    c.set("clientIp", "local");
    await next();
    return;
  }

  const ip = trustedClientIp((name) => c.req.header(name));

  if (!ip || ip === "unknown" || ip === "") {
    if (env.NODE_ENV !== "production") {
      c.set("clientIp", "local");
      await next();
      return;
    }
    throw new RateLimitError(
      "Unable to determine client IP address. Ensure your proxy is configured correctly."
    );
  }

  await consumePublicAllowance(`ip:${ip}`);

  await next();
}

export async function rateLimitByVerifiedBucket(c: Context, next: Next, bucket: string) {
  if (env.NODE_ENV === "development") {
    await next();
    return;
  }
  await consumePublicAllowance(bucket);
  await next();
}
