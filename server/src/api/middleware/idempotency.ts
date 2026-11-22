import type { Context, Next } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { redis, RedisKeys } from "../../lib/redis.ts";
import { createLogger } from "../../lib/logger.ts";

const logger = createLogger({ module: "idempotency-middleware" });

const RESULT_TTL_SECONDS = 24 * 60 * 60;
const CLAIM_LEASE_SECONDS = 5 * 60;
const MAX_CACHED_BODY_SIZE = 256 * 1024;
const WAIT_TIMEOUT_MS = 10_000;
const WAIT_POLL_MS = 100;

type PendingEntry = { state: "pending"; token: string; fingerprint: string };
type CompletedEntry = {
  state: "completed";
  fingerprint: string;
  status: number;
  body: string | null;
  oversized?: boolean;
};
type Entry = PendingEntry | CompletedEntry;

const COMPLETE_IF_OWNER = `
local current = redis.call("GET", KEYS[1])
if current == false then return 0 end
local ok, parsed = pcall(cjson.decode, current)
if not ok or parsed.state ~= "pending" or parsed.token ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[1], ARGV[2], "EX", tonumber(ARGV[3]))
return 1
`;

const RELEASE_IF_OWNER = `
local current = redis.call("GET", KEYS[1])
if current == false then return 0 end
local ok, parsed = pcall(cjson.decode, current)
if not ok or parsed.state ~= "pending" or parsed.token ~= ARGV[1] then return 0 end
redis.call("DEL", KEYS[1])
return 1
`;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

async function fingerprint(c: Context, workspaceId: string, environmentId: string, caller: string): Promise<string> {
  const contentType = c.req.header("content-type") ?? "";
  let bodyPart = "";
  if (contentType.includes("application/json")) {
    try {
      const raw = await c.req.text();
      bodyPart = raw ? stableStringify(JSON.parse(raw)) : "";
    } catch {
      bodyPart = await c.req.text().catch(() => "");
    }
  }
  return createHash("sha256")
    .update(`${c.req.method}\n${c.req.path}\n${workspaceId}\n${environmentId}\n${caller}\n${bodyPart}`)
    .digest("hex");
}

function callerIdentity(c: Context): string {
  const authType = (c.get("authType") as string | undefined) ?? "none";
  if (authType === "apiKey") return `apiKey:${c.get("apiKeyId") ?? ""}${c.get("endUserId") ? `:eu:${c.get("endUserId")}` : ""}`;
  if (authType === "oauth") return `oauth:${c.get("userId") ?? ""}:${c.get("oauthClientId") ?? ""}`;
  return `${authType}:${c.get("userId") ?? ""}`;
}

function replay(entry: CompletedEntry): Response {
  if (entry.oversized || entry.body === null) {
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code: "idempotency_result_not_stored",
          message:
            "The original request for this Idempotency-Key completed successfully, but its response was too large to store for replay.",
        },
      }),
      { status: 409, headers: { "Content-Type": "application/json", "X-Idempotent-Replay": "true" } },
    );
  }
  return new Response(entry.body, {
    status: entry.status,
    headers: { "Content-Type": "application/json", "X-Idempotent-Replay": "true" },
  });
}

function conflict(): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: {
        code: "idempotency_key_reuse",
        message: "This Idempotency-Key was already used for a different request.",
      },
    }),
    { status: 409, headers: { "Content-Type": "application/json" } },
  );
}

function inProgress(): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: {
        code: "idempotency_request_in_progress",
        message: "A request with this Idempotency-Key is still being processed. Retry shortly.",
      },
    }),
    { status: 409, headers: { "Content-Type": "application/json", "Retry-After": "1" } },
  );
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function idempotencyMiddleware(c: Context, next: Next): Promise<Response | void> {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    await next();
    return;
  }

  const key = c.req.header("Idempotency-Key");
  if (!key) {
    await next();
    return;
  }

  const workspaceId = c.get("workspaceId") as string | undefined;
  if (!workspaceId) {
    await next();
    return;
  }
  const environmentId = (c.get("environmentId") as string | undefined) ?? "default";

  const redisKey = RedisKeys.idempotency(workspaceId, environmentId, key);
  const fp = await fingerprint(c, workspaceId, environmentId, callerIdentity(c));
  c.set("budgetEffectId", createHash("sha256").update(JSON.stringify([
    c.get("authType") === "oauth" ? [c.get("userId"), c.get("oauthClientId")] : c.get("apiKeyId"), workspaceId, environmentId, key,
  ])).digest("hex"));
  c.set("budgetFingerprint", fp);
  c.set("idempotencyKey", key);
  c.set("idempotencyFingerprint", fp);
  const token = randomUUID();
  const pending = JSON.stringify({ state: "pending", token, fingerprint: fp } satisfies PendingEntry);
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  for (;;) {
    const claimed = await redis.set(redisKey, pending, "EX", CLAIM_LEASE_SECONDS, "NX");
    if (claimed === "OK") {
      return await runOwned(c, next, redisKey, token, fp);
    }

    const raw = await redis.get(redisKey);
    if (!raw) continue;

    let entry: Entry;
    try {
      entry = JSON.parse(raw) as Entry;
    } catch {
      return inProgress();
    }

    if (entry.fingerprint !== fp) return conflict();
    if (entry.state === "completed") {
      if (c.get("idempotencyCurrentState")) {
        c.set("idempotencyLegacyResponse", replay(entry));
        await next();
        return;
      }
      logger.debug({ redisKey }, "Idempotency replay");
      return replay(entry);
    }
    if (Date.now() >= deadline) return inProgress();
    await delay(WAIT_POLL_MS);
  }
}

async function runOwned(
  c: Context,
  next: Next,
  redisKey: string,
  token: string,
  fp: string,
): Promise<void> {
  let stored = false;
  try {
    await next();
    const res = c.res;
    if (res.status >= 200 && res.status < 300 && !c.get("idempotencyCurrentState")) {
      const bodyText = await res.clone().text();
      const oversized = bodyText.length > MAX_CACHED_BODY_SIZE;
      const completed: CompletedEntry = {
        state: "completed",
        fingerprint: fp,
        status: res.status,
        body: oversized ? null : bodyText,
        ...(oversized ? { oversized: true } : {}),
      };
      await redis.eval(
        COMPLETE_IF_OWNER,
        1,
        redisKey,
        token,
        JSON.stringify(completed),
        String(RESULT_TTL_SECONDS),
      );
      stored = true;
    }
  } finally {
    if (!stored) {
      await redis.eval(RELEASE_IF_OWNER, 1, redisKey, token).catch(() => {});
    }
  }
}
