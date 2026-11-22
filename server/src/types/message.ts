export type MessageStatus = "pending" | "scheduled" | "processing" | "delivered" | "failed" | "cancelled";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Message {
  id: string;
  workspaceId: string;
  messageId: string;
  contentHash?: string;
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: any;
  scheduledFor?: Date;
  status: MessageStatus;
  attempts: number;
  maxRetries: number;
  responseStatus?: number;
  responseBody?: string;
  errorMessage?: string;
  deliveredAt?: Date;
  failedAt?: Date;
  callbackUrl?: string;
  failureCallbackUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliveryAttempt {
  attemptNumber: number;
  timestamp: Date;
  responseStatus?: number;
  responseBody?: string;
  errorMessage?: string;
}
