const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const UNSTORABLE_ALL = new RegExp(UNSTORABLE.source, "g");

export function stripUnstorable(text: string): string {
  return text.replace(UNSTORABLE_ALL, "");
}

export function storableValue(value: unknown): unknown {
  if (typeof value === "string") return stripUnstorable(value);
  if (Array.isArray(value)) return value.map(storableValue);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [stripUnstorable(key), storableValue(item)]));
  }
  return value;
}

export function hasUnstorableText(value: unknown): boolean {
  if (typeof value === "string") return UNSTORABLE.test(value);
  if (Array.isArray(value)) return value.some(hasUnstorableText);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.entries(value).some(([key, item]) => UNSTORABLE.test(key) || hasUnstorableText(item));
  }
  return false;
}
