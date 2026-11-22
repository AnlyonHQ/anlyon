import pino from "pino";
import { env } from "../config/env.ts";

const isDevelopment = env.NODE_ENV === "development";

export const logger = pino({
  level: env.LOG_LEVEL ?? "info",
  transport: isDevelopment
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss Z",
          ignore: "pid,hostname",
        },
      }
    : undefined,
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  base: {
    env: env.NODE_ENV,
  },
});

export function createLogger(context: Record<string, any>) {
  return logger.child(context);
}

export const apiLogger = createLogger({ module: "api" });
export const workerLogger = createLogger({ module: "worker" });
export const dbLogger = createLogger({ module: "database" });
export const redisLogger = createLogger({ module: "redis" });
export const authLogger = createLogger({ module: "auth" });
