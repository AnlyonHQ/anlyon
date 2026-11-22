import { addSeconds, format } from "date-fns";

export function calculateBackoff(attempt: number, baseDelay: number = 1000): number {
  const maxDelay = 1000 * 60 * 60;
  const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  const jitter = delay * 0.2 * (Math.random() - 0.5);
  return Math.floor(delay + jitter);
}

export function calculateNextRetry(attempt: number): Date {
  const delayMs = calculateBackoff(attempt);
  return addSeconds(new Date(), Math.floor(delayMs / 1000));
}

export function formatDate(date: Date, pattern: string = "yyyy-MM-dd HH:mm:ss"): string {
  return format(date, pattern);
}

export function getUsageDate(date: Date = new Date()): string {
  return date.toISOString().split("T")[0];
}

export function isPast(date: Date): boolean {
  return date.getTime() < Date.now();
}

export function isFuture(date: Date): boolean {
  return date.getTime() > Date.now();
}

export function getTimestamp(date: Date = new Date()): number {
  return Math.floor(date.getTime() / 1000);
}

export function timestampToDate(timestamp: number): Date {
  return new Date(timestamp * 1000);
}
