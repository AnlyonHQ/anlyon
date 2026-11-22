import type { Context } from "hono";
import { ApiError } from "../utils/errors.ts";
import { END_USER_HEADER, NO_END_USER, parseEndUserId, type EndUserContext } from "../core/end-users/identity.ts";
import { EndUserRequiredError } from "../core/end-users/errors.ts";

export function endUserContext(c: Context): EndUserContext {
  if (c.get("authType") !== "apiKey") return NO_END_USER;
  return { endUserId: (c.get("endUserId") as string | undefined) ?? null, required: c.get("endUserRequired") === true };
}

export function requireEndUserWhenRequired(c: Context): EndUserContext {
  const context = endUserContext(c);
  if (context.required && !context.endUserId) throw new EndUserRequiredError();
  return context;
}

export function pathEndUser(c: Context): string {
  const endUserId = parseEndUserId(c.req.param("endUserId"), "The end-user id in the path");
  const context = endUserContext(c);
  if (context.endUserId !== null && context.endUserId !== endUserId) {
    throw new ApiError(400, "END_USER_HEADER_MISMATCH", `The ${END_USER_HEADER} header names another end user than the path.`);
  }
  if (context.required && context.endUserId === null) throw new EndUserRequiredError();
  return endUserId;
}

export function listedEndUser(c: Context, queried: string | undefined): string | undefined {
  const context = endUserContext(c);
  if (context.required) {
    if (!context.endUserId) throw new EndUserRequiredError();
    return context.endUserId;
  }
  return queried;
}

export function assertOwnEndUser(c: Context, recordEndUserId: string | null, notFound: () => Error): void {
  const context = endUserContext(c);
  if (context.required && !context.endUserId) throw new EndUserRequiredError();
  if (context.required && recordEndUserId !== context.endUserId) throw notFound();
}

export function assertSameEndUser(c: Context, recordEndUserId: string | null, notFound: () => Error): void {
  const context = endUserContext(c);
  if (context.required && !context.endUserId) throw new EndUserRequiredError();
  if (context.endUserId !== null && recordEndUserId !== context.endUserId) throw notFound();
}

export function endUserHeaderNotAllowed(): ApiError {
  return new ApiError(400, "END_USER_HEADER_NOT_ALLOWED", `The ${END_USER_HEADER} header is accepted only with an API key, which stays on your server.`);
}

export function readEndUserHeader(c: Context): string | null {
  const raw = c.req.header(END_USER_HEADER);
  if (raw === undefined) return null;
  if (c.get("authType") !== "apiKey") throw endUserHeaderNotAllowed();
  return parseEndUserId(raw);
}
