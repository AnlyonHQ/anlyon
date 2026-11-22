import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { env } from "../config/env.ts";
import { createLogger } from "./logger.ts";
import { redactSensitivePath } from "../utils/sensitive-paths.ts";

const logger = createLogger({ module: "sentry" });

let isInitialized = false;

function setupGlobalErrorHandlers(): void {
  process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
    logger.error(
      {
        reason,
        promise: promise.toString(),
      },
      "Unhandled promise rejection"
    );

    const error = reason instanceof Error ? reason : new Error(String(reason));
    captureException(error, {
      unhandledRejection: true,
      promise: promise.toString(),
    });
  });

  process.on("uncaughtException", async (error: Error) => {
    logger.error({ error }, "Uncaught exception - application will exit");

    captureException(error, {
      uncaughtException: true,
      fatal: true,
    });

    try {
      await flush(2000);
    } catch (flushError) {
      logger.error({ error: flushError }, "Failed to flush Sentry events");
    }

    process.exit(1);
  });

  logger.debug("Global error handlers registered");
}

export function resolveSentryIdentity(input: {
  nodeEnv: string;
  sentryEnvironment?: string;
  sentryRelease?: string;
  buildSha?: string;
}): { environment: string; release: string | undefined; overridden: boolean } {
  const requested = input.sentryEnvironment || input.nodeEnv;
  const overridden = requested === "production" && input.nodeEnv !== "production";
  const buildSha = input.buildSha && input.buildSha !== "unknown" ? input.buildSha : undefined;
  return {
    environment: overridden ? input.nodeEnv : requested,
    release: buildSha ?? input.sentryRelease,
    overridden,
  };
}

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "origin-secret",
  "stripe-signature",
  "webhook-signature",
  "x-internal-auth",
  "idempotency-key",
]);

const QUERY_KEYS = new Set(["query_string", "http.query", "url.query"]);

function stripQuery(value: string): string {
  if (!/^(https?:\/\/|\/)/.test(value)) return value;
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

export function scrubSentryPayload<T>(payload: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: unknown, key?: string): unknown => {
    if (typeof node === "string") return key && QUERY_KEYS.has(key) ? "[Filtered]" : redactSensitivePath(stripQuery(node));
    if (!node || typeof node !== "object" || seen.has(node)) return node;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = walk(node[i]);
      return node;
    }
    const record = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(record)) {
      try {
        if (SENSITIVE_HEADERS.has(k.toLowerCase())) {
          delete record[k];
          continue;
        }
        const next = walk(v, k);
        if (next !== v) record[k] = next;
      } catch {
      }
    }
    return record;
  };
  return walk(payload) as T;
}

export function initSentry(): void {
  if (isInitialized) {
    logger.debug("Sentry already initialized, skipping");
    return;
  }

  if (!env.SENTRY_DSN) {
    logger.info("Sentry DSN not configured, skipping initialization");
    return;
  }

  const identity = resolveSentryIdentity({
    nodeEnv: env.NODE_ENV,
    sentryEnvironment: env.SENTRY_ENVIRONMENT,
    sentryRelease: env.SENTRY_RELEASE,
    buildSha: process.env.BUILD_SHA,
  });
  if (identity.overridden) {
    logger.warn(
      { configured: env.SENTRY_ENVIRONMENT, using: identity.environment },
      "SENTRY_ENVIRONMENT=production ignored outside NODE_ENV=production",
    );
  }

  try {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: identity.environment,
      release: identity.release,
      debug: env.SENTRY_DEBUG === "true",

      tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1,

      profilesSampleRate: env.SENTRY_PROFILES_SAMPLE_RATE ?? 0.1,

      tracePropagationTargets: [],

      integrations: [
        Sentry.httpIntegration(),
        Sentry.nativeNodeFetchIntegration({ breadcrumbs: false, spans: false, tracePropagation: false }),
        nodeProfilingIntegration(),
      ],

      beforeSend(event) {
        return scrubSentryPayload(event);
      },
      beforeSendTransaction(event) {
        return scrubSentryPayload(event);
      },
      beforeSendSpan(span) {
        return scrubSentryPayload(span);
      },

      beforeBreadcrumb(breadcrumb) {
        if (breadcrumb.category === "console" && breadcrumb.level === "debug") {
          return null;
        }
        return scrubSentryPayload(breadcrumb);
      },
    });

    isInitialized = true;
    logger.info(
      { environment: identity.environment, release: identity.release },
      "Sentry initialized successfully"
    );

    setupGlobalErrorHandlers();
  } catch (error) {
    logger.error({ error }, "Failed to initialize Sentry");
  }
}

export function captureException(
  error: Error | unknown,
  context?: Record<string, unknown>
): string | undefined {
  if (!isInitialized) {
    return undefined;
  }

  return Sentry.captureException(error, {
    extra: context,
  });
}

export function captureMessage(
  message: string,
  level: Sentry.SeverityLevel = "info",
  context?: Record<string, unknown>
): string | undefined {
  if (!isInitialized) {
    return undefined;
  }

  return Sentry.captureMessage(message, {
    level,
    extra: context,
  });
}

export function setUser(user: { id: string; email?: string; workspaceId?: string }): void {
  if (!isInitialized) {
    return;
  }

  Sentry.setUser({
    id: user.id,
    email: user.email,
    ...(user.workspaceId && { workspaceId: user.workspaceId }),
  });
}

export function clearUser(): void {
  if (!isInitialized) {
    return;
  }

  Sentry.setUser(null);
}

export function addBreadcrumb(breadcrumb: Sentry.Breadcrumb): void {
  if (!isInitialized) {
    return;
  }

  Sentry.addBreadcrumb(breadcrumb);
}

export function setContext(name: string, context: Record<string, unknown>): void {
  if (!isInitialized) {
    return;
  }

  Sentry.setContext(name, context);
}

export function setTag(key: string, value: string): void {
  if (!isInitialized) {
    return;
  }

  Sentry.setTag(key, value);
}

export function startTransaction(
  name: string,
  op: string
): Sentry.Span | undefined {
  if (!isInitialized) {
    return undefined;
  }

  return Sentry.startInactiveSpan({ name, op });
}

export async function flush(timeout: number = 2000): Promise<boolean> {
  if (!isInitialized) {
    return true;
  }

  return Sentry.flush(timeout);
}

export async function close(timeout: number = 2000): Promise<boolean> {
  if (!isInitialized) {
    return true;
  }

  return Sentry.close(timeout);
}

export { Sentry };
