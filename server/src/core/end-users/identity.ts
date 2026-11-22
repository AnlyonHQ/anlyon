import { createHash, createHmac } from "node:crypto";
import { env } from "../../config/env.ts";
import { ApiError } from "../../utils/errors.ts";

export const END_USER_HEADER = "Anlyon-End-User";

const END_USER_ID = /^[A-Za-z0-9._:@-]{1,128}$/;

export const ERASED_PREFIX = "erased~";

export function isEndUserId(value: unknown): value is string {
  return typeof value === "string" && END_USER_ID.test(value);
}

export class InvalidEndUserError extends ApiError {
  constructor(where: string) {
    super(400, "INVALID_END_USER", `${where} must be 1 to 128 characters: letters, digits, and . _ : @ -`);
    this.name = "InvalidEndUserError";
  }
}

export function parseEndUserId(value: string | undefined | null, where = `The ${END_USER_HEADER} header`): string {
  if (!isEndUserId(value)) throw new InvalidEndUserError(where);
  return value;
}

export function erasedEndUserId(workspaceId: string, endUserId: string): string {
  const digest = createHmac("sha256", env.DELIVERY_SECRET_MASTER_KEY)
    .update(`end-user-erasure|${workspaceId}|${endUserId}`)
    .digest("hex");
  return `${ERASED_PREFIX}${digest.slice(0, 32)}`;
}

export function endUserCounterTag(endUserId: string): string {
  return `eu:${createHash("sha256").update(endUserId).digest("hex").slice(0, 32)}`;
}

export interface EndUserContext {
  endUserId: string | null;
  required: boolean;
}

export const NO_END_USER: EndUserContext = { endUserId: null, required: false };
