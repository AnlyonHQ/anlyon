import { db } from "../../db/index.ts";
import { messageExecutionLogs } from "../../db/schema/execution-logs.ts";
import { createLogger } from "../../lib/logger.ts";
import { redactLogHeaders } from "./public-log.ts";

const logger = createLogger({ module: "execution-logger" });

export async function logMessageExecution(params: {
  messageId: string;
  workspaceId: string;
  attemptNumber: number;
  status: string;
  requestUrl?: string;
  requestMethod?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: any;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  errorMessage?: string;
  errorCode?: string;
  duration?: number;
}): Promise<void> {
  try {
    await db.insert(messageExecutionLogs).values({
      messageId: params.messageId,
      workspaceId: params.workspaceId,
      attemptNumber: params.attemptNumber,
      status: params.status,
      requestUrl: params.requestUrl,
      requestMethod: params.requestMethod,
      requestHeaders: redactLogHeaders(params.requestHeaders) as any,
      requestBody: params.requestBody as any,
      responseStatus: params.responseStatus,
      responseHeaders: redactLogHeaders(params.responseHeaders) as any,
      responseBody: params.responseBody?.substring(0, 5000),
      errorMessage: params.errorMessage?.substring(0, 1000),
      errorCode: params.errorCode,
      duration: params.duration,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error({ error, messageId: params.messageId }, "Failed to log message execution");
  }
}
