import type { EndUserConnectionError } from "./errors.ts";

const failures = new WeakMap<object, EndUserConnectionError>();

export function markEndUserFailure<T extends object>(result: T, error: EndUserConnectionError): T {
  failures.set(result, error);
  return result;
}

export function endUserFailureOf(result: object): EndUserConnectionError | undefined {
  return failures.get(result);
}
