import type { Context } from "hono";
import { ValidationError } from "../utils/errors.ts";

export function pathParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (value === undefined) throw new ValidationError(`Missing path parameter: ${name}`);
  return value;
}
